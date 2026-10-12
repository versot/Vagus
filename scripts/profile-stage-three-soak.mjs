// Fixed-load 30-minute WorkspaceStore/SQLite soak. Uses only an isolated synthetic database.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { WorkspaceStore } from '../packages/host/dist/storage/workspace-store.js';

const durationMs = Number(process.env.VAGUS_SOAK_DURATION_MS) || 30 * 60 * 1000;
const intervalMs = 60_000;
const batchIntervalMs = 5_000;
const directory = await mkdtemp(join(tmpdir(), 'vagus-stage-three-soak-'));
const store = new WorkspaceStore(directory);
const sessions = Array.from({ length: 1000 }, (_, index) => ({
  id: `soak-${index}`, projectId: null, title: `Synthetic session ${index} needle-${index % 80}`,
  createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', state: 'ended', eventSequence: 100,
}));
const history = (session) => Array.from({ length: 100 }, (_, index) => ({
  kind: 'message', id: `message-${session.id}-${index}`, role: index % 2 ? 'assistant' : 'user',
  text: `Vagus fixed-load synthetic history ${session.id} needle-${session.id.slice(-2)} entry-${index} `.repeat(2),
  complete: true, sequence: index + 1, turnId: `turn-${Math.floor(index / 2)}`, occurredAt: session.createdAt,
}));
const percentile = (values, ratio) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * ratio)] ?? 0;
const reportPath = process.argv[2] ? resolve(process.argv[2]) : null;
const samples = [];
const lag = monitorEventLoopDelay({ resolution: 20 });
let cursor = 0;
let startedAt;
let deadline;
let priorCpu;
let priorWall;

try {
  await store.load();
  const populateStarted = performance.now();
  await store.save([], sessions, sessions.flatMap((session) => history(session).map((entry) => ({ sessionId: session.id, entry }))));
  const populateMs = performance.now() - populateStarted;
  startedAt = new Date();
  deadline = Date.now() + durationMs;
  priorCpu = process.cpuUsage();
  priorWall = Date.now();
  lag.enable();

  while (Date.now() < deadline) {
    const sampleStart = Date.now();
    const windowEnd = Math.min(deadline, sampleStart + intervalMs);
    const historyMs = [], searchMs = [], saveMs = [];
    let historyOps = 0, searchOps = 0, saveOps = 0;
    // Repeat a deterministic batch every five seconds, without a long idle gap:
    // 10 paged reads, 5 paginated searches, and 2 incremental writes per batch.
    while (Date.now() < windowEnd) {
      const batchStart = Date.now();
      for (let index = 0; index < 10; index++) {
        const session = sessions[(cursor * 47 + index * 23) % sessions.length];
        const at = performance.now();
        await store.history(session.id, { limit: 40, beforeSequence: 100 - (index % 3) * 10 });
        historyMs.push(performance.now() - at); historyOps++;
      }
      for (let index = 0; index < 5; index++) {
        const at = performance.now();
        await store.search(`needle-${(cursor + index) % 80}`, false, { limit: 50, offset: (index % 2) * 50 });
        searchMs.push(performance.now() - at); searchOps++;
      }
      for (let index = 0; index < 2; index++) {
        const session = sessions[(cursor * 31 + index * 97) % sessions.length];
        const entry = { ...history(session)[99], text: `Synthetic soak update ${cursor}-${index}` };
        const at = performance.now();
        await store.save([], sessions, [{ sessionId: session.id, entry }]);
        saveMs.push(performance.now() - at); saveOps++;
      }
      cursor++;
      const remainingMs = Math.min(batchIntervalMs - (Date.now() - batchStart), windowEnd - Date.now());
      if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
    }

    const cpu = process.cpuUsage(priorCpu);
    const wallMs = Math.max(1, Date.now() - priorWall);
    const memory = process.memoryUsage();
    const storage = await store.request('performance');
    samples.push({
      elapsedMinutes: (Date.now() - startedAt.getTime()) / 60_000, sampledAt: new Date().toISOString(),
      workload: { historyOps, historyP95Ms: percentile(historyMs, .95), searchOps, searchP95Ms: percentile(searchMs, .95), saveOps, saveP95Ms: percentile(saveMs, .95) },
      process: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external, cpuPercentOneCore: ((cpu.user + cpu.system) / 1000) / wallMs * 100, eventLoopDelayP99Ms: lag.percentile(99) / 1e6 },
      storage,
    });
    lag.reset(); priorCpu = process.cpuUsage(); priorWall = Date.now();
    if (reportPath) {
      const partial = makeReport(false, populateMs);
      await writeFile(reportPath, `${JSON.stringify(partial, null, 2)}\n`);
    }
    console.log(JSON.stringify(samples.at(-1)));
  }
  const report = makeReport(true, populateMs);
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ complete: true, reportPath, samples: samples.length, rssPeakBytes: report.summary.rssPeakBytes, rssGrowthBytes: report.summary.rssGrowthBytes }));
} finally {
  lag.disable();
  await store.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}

function makeReport(complete, populateMs) {
  const rss = samples.map((sample) => sample.process.rssBytes);
  const summary = {
    sampleCount: samples.length,
    rssStartBytes: rss[0] ?? null,
    rssPeakBytes: rss.length ? Math.max(...rss) : null,
    rssEndBytes: rss.at(-1) ?? null,
    rssGrowthBytes: rss.length > 1 ? rss.at(-1) - rss[0] : null,
    historyP95MaxMs: samples.length ? Math.max(...samples.map((sample) => sample.workload.historyP95Ms)) : null,
    searchP95MaxMs: samples.length ? Math.max(...samples.map((sample) => sample.workload.searchP95Ms)) : null,
    saveP95MaxMs: samples.length ? Math.max(...samples.map((sample) => sample.workload.saveP95Ms)) : null,
    cpuPeakPercentOneCore: samples.length ? Math.max(...samples.map((sample) => sample.process.cpuPercentOneCore)) : null,
  };
  return {
    measuredAt: new Date().toISOString(), startedAt: startedAt.toISOString(), complete,
    durationRequestedMs: durationMs, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceState: 'working tree; synthetic isolated database', node: process.version, os: release(), cpu: cpus()[0].model, totalMemoryBytes: totalmem(),
    dataset: { sessions: sessions.length, entries: sessions.length * 100, storage: 'isolated temp SQLite database', scope: 'direct WorkspaceStore process; excludes desktop UI and WebSocket transport' },
    workloadPerMinute: { targetHistoryPages: 120, targetPaginatedSearches: 60, targetIncrementalSaves: 24, batchIntervalMs }, populateMs, samples, summary,
  };
}
