import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-host-cancel-'));
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
let output = '';
let diagnostics = '';
host.stdout.on('data', chunk => output += chunk);
host.stderr.on('data', chunk => diagnostics += chunk);
const client = new HostClient(`ws://127.0.0.1:${port}/rpc`, { token });
const events = [];
let sessionId;
let deleted = false;
let stage = 'starting';

async function waitUntil(condition, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (host.exitCode !== null) throw new Error(`Host exited unexpectedly (${host.exitCode}): ${diagnostics}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${label}: ${diagnostics.slice(-2500)}`);
}

try {
  await waitUntil(() => output.includes('VAGUS_HOST_READY'), 'Host did not start');
  await client.connect();
  stage = 'checking Claude Code health';
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await client.request('projects.create', { name: 'Claude cancellation smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  stage = 'creating Claude Code session';
  const created = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  sessionId = created.id;
  client.onEvent(event => { if (event.sessionId === sessionId) events.push(event); });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);
  stage = 'starting a long-running Claude Code turn';
  const sent = await client.request('sessions.send', { sessionId, text: 'Do not use tools. Write a very long Chinese essay about software architecture, with at least 100 numbered sections of 80 words each. Continue until explicitly stopped.' });
  if (sent.error) throw new Error(sent.error);
  await waitUntil(() => events.some(event => event.type === 'session.state' && event.state === 'running'), 'Claude Code never entered running state');

  stage = 'calling the same sessions.cancel route used by the Vagus stop button';
  const cancelled = await client.request('sessions.cancel', { sessionId });
  if (cancelled.error) throw new Error(cancelled.error);
  await waitUntil(() => events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle', 'Claude Code did not return to idle after cancel', 20_000);
  const providerErrors = events.filter(event => event.type === 'provider.error').map(event => ({ code: event.code, message: event.message }));
  const notifications = events.filter(event => event.type === 'notification').map(event => event.message);
  const result = { cancelRpc: 'success', states: events.filter(event => event.type === 'session.state').map(event => event.state), stopNotification: notifications.find(message => message.includes('已停止当前任务')) ?? null, methodNotFoundErrors: providerErrors.filter(error => /method not found|session\/cancel/i.test(error.message)), providerErrors };
  console.log(JSON.stringify(result, null, 2));
  if (!result.stopNotification || result.methodNotFoundErrors.length || providerErrors.length) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ stage, error: error instanceof Error ? error.stack : String(error), hostDiagnostics: diagnostics.slice(-2500), recentEvents: events.slice(-30).map(event => ({ type: event.type, state: event.state, code: event.code, message: event.message })) }, null, 2));
  process.exitCode = 3;
} finally {
  if (sessionId) {
    const result = await client.request('sessions.delete-permanent', { sessionId }).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
    deleted = !result.error;
    if (result.error) console.error(`Isolated session cleanup failed: ${result.error}`);
  }
  client.close();
  if (host.exitCode === null) {
    host.stdin.end('shutdown\n');
    await Promise.race([once(host, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (host.exitCode === null) { host.kill(); await once(host, 'exit'); }
  }
  if (!root.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true });
}
