import type { Root } from "hast";
import { recordPerformance } from "../../lib/performance.js";
export type MarkdownBlock = { key: string; version: number; tree: Root };
type Job = { id: string; revision: number; text: string; complete: boolean; onResult(blocks: MarkdownBlock[] | null): void };
let worker: Worker | undefined;
let busy = false;
let revision = 0;
let failed = false;
const queue = new Map<string, Job>();
const active = new Map<string, Job>();
const blocksByMessage = new Map<string, Map<string, MarkdownBlock>>();
const sourceSizes = new Map<string, number>();
function dispatch() {
  if (busy || !queue.size) return;
  const job = [...queue.values()].find((candidate) => !candidate.complete) ?? queue.values().next().value!;
  queue.delete(job.id);
  busy = true; active.set(job.id, job);
  worker!.postMessage({ id: job.id, revision: job.revision, text: job.text, complete: job.complete });
}
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("../../workers/markdown-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }: MessageEvent<{ id: string; revision: number; keys: string[]; changes: MarkdownBlock[]; sourceBytes?: number; elapsedMs: number; error?: string }>) => {
    const job = active.get(data.id);
    active.delete(data.id); busy = false;
    const cache = blocksByMessage.get(data.id) ?? new Map<string, MarkdownBlock>();
    for (const block of data.changes ?? []) cache.set(block.key, block);
    const keys = new Set(data.keys);
    for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
    blocksByMessage.delete(data.id); blocksByMessage.set(data.id, cache);
    sourceSizes.set(data.id, data.sourceBytes ?? 0);
    let size = [...sourceSizes.values()].reduce((total, value) => total + value, 0);
    for (const id of blocksByMessage.keys()) {
      if (blocksByMessage.size <= 16 && size <= 8 * 1024 * 1024) break;
      if (id === data.id) continue;
      blocksByMessage.delete(id); size -= sourceSizes.get(id) ?? 0; sourceSizes.delete(id);
      // Keep both caches in sync: a later remount must receive all blocks.
      worker?.postMessage({ evict: id });
    }
    recordPerformance("markdown.worker", data.elapsedMs ?? 0);
    if (data.error) recordPerformance("markdown.fallback", 0);
    if (job?.revision === data.revision && !queue.has(data.id)) job.onResult(data.error ? null : data.keys.map((key) => cache.get(key)!).filter(Boolean));
    dispatch();
  };
  worker.onerror = (event) => {
    recordPerformance("markdown.fallback", 0);
    console.warn("Markdown Worker unavailable; using the synchronous renderer.", event.message);
    failed = true; worker?.terminate(); worker = undefined; busy = false;
    for (const job of [...active.values(), ...queue.values()]) job.onResult(null);
    active.clear(); queue.clear(); blocksByMessage.clear(); sourceSizes.clear();
  };
  return worker;
}
export function requestMarkdown(id: string, text: string, complete: boolean, onResult: Job["onResult"]) {
  if (failed) { onResult(null); return () => undefined; }
  try { getWorker(); } catch { onResult(null); return () => undefined; }
  const job: Job = { id, revision: ++revision, text, complete, onResult };
  queue.set(id, job); dispatch();
  return () => {
    if (queue.get(id) === job) queue.delete(id);
    if (active.get(id) === job) job.onResult = () => undefined;
  };
}
