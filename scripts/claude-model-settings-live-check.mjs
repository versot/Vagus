import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

const root = await mkdtemp(join(tmpdir(), 'vagus-claude-settings-live-'));
const projectRoot = join(root, 'workspace');
await mkdir(projectRoot, { recursive: true });
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const token = randomBytes(32).toString('hex');
const host = spawn(process.execPath, [resolve('packages/host/dist/server.js')], {
  cwd: resolve('.'),
  env: { ...process.env, VAGUS_HOST_TOKEN: token, VAGUS_HOST_PORT: String(port), VAGUS_DATA_DIR: join(root, 'vagus-data'), VAGUS_MANAGED_HOST: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let stdout = '';
let stderr = '';
host.stdout.on('data', chunk => stdout += chunk);
host.stderr.on('data', chunk => stderr += chunk);
const client = new HostClient(`ws://127.0.0.1:${port}/rpc`, { token });
let sessionId;

async function waitUntil(condition, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (host.exitCode !== null) throw new Error(`Host exited (${host.exitCode}): ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: ${stderr.slice(-2000)}`);
}

try {
  await waitUntil(() => stdout.includes('VAGUS_HOST_READY'), 'Host did not start');
  await client.connect();
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await client.request('projects.create', { name: 'Claude model settings smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const created = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  sessionId = created.id;

  const initialResult = await client.request('sessions.get-settings', { sessionId });
  if (initialResult.error) throw new Error(initialResult.error);
  const initial = initialResult.settings;
  const otherModel = catalog.models.find(model => model.id !== initial.modelId);
  const otherThinking = (initial.thinkingLevels ?? []).find(level => level !== initial.thinkingLevel);
  const otherMode = (initial.availableModes ?? []).find(mode => mode.id !== initial.currentModeId);
  const checks = {};

  if (otherModel) {
    const changed = await client.request('sessions.set-model', { sessionId, modelId: otherModel.id });
    if (changed.error) throw new Error(`Model switch failed: ${changed.error}`);
    const reread = await client.request('sessions.get-settings', { sessionId });
    if (reread.error) throw new Error(reread.error);
    checks.model = { from: initial.modelId, selected: otherModel.id, returned: changed.modelId, reread: reread.settings.modelId, passed: changed.modelId === otherModel.id && reread.settings.modelId === otherModel.id };
  } else {
    checks.model = { skipped: 'Claude Code exposed fewer than two selectable models in this local configuration', modelCount: catalog.models.length };
  }

  if (otherThinking) {
    const changed = await client.request('sessions.set-thinking-level', { sessionId, level: otherThinking });
    if (changed.error) throw new Error(`Thinking-level switch failed: ${changed.error}`);
    const reread = await client.request('sessions.get-settings', { sessionId });
    if (reread.error) throw new Error(reread.error);
    checks.thinkingLevel = { from: initial.thinkingLevel, selected: otherThinking, returned: changed.thinkingLevel, reread: reread.settings.thinkingLevel, passed: changed.thinkingLevel === otherThinking && reread.settings.thinkingLevel === otherThinking };
  } else {
    checks.thinkingLevel = { skipped: 'Claude Code exposed fewer than two thinking levels in this local configuration', thinkingLevels: initial.thinkingLevels ?? [] };
  }

  if (otherMode) {
    const changed = await client.request('sessions.set-mode', { sessionId, modeId: otherMode.id });
    if (changed.error) throw new Error(`Session-mode switch failed: ${changed.error}`);
    const reread = await client.request('sessions.get-settings', { sessionId });
    if (reread.error) throw new Error(reread.error);
    checks.mode = { from: initial.currentModeId, selected: otherMode.id, returned: changed.currentModeId, reread: reread.settings.currentModeId, passed: changed.currentModeId === otherMode.id && reread.settings.currentModeId === otherMode.id };
  } else {
    checks.mode = { skipped: 'Claude Code exposed fewer than two session modes in this local configuration', availableModes: initial.availableModes ?? [] };
  }

  console.log(JSON.stringify({ modelCount: catalog.models.length, availableThinkingLevels: initial.thinkingLevels, checks }, null, 2));
  if (checks.model.passed === false || checks.thinkingLevel.passed === false || checks.mode.passed === false) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.stack : String(error), stderr: stderr.slice(-2000) }, null, 2));
  process.exitCode = 3;
} finally {
  if (sessionId) {
    const deleted = await client.request('sessions.delete-permanent', { sessionId }).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
    if (deleted.error) console.error(`Test-session cleanup did not complete: ${deleted.error}`);
  }
  client.close();
  if (host.exitCode === null) {
    host.stdin.end('shutdown\n');
    await Promise.race([once(host, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (host.exitCode === null) { host.kill(); await once(host, 'exit'); }
  }
  const tempRoot = resolve(tmpdir());
  if (!resolve(root).startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
