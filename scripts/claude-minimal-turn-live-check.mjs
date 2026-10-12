import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-minimal-turn-'));
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
const events = [];
let sessionId;
let deleted = false;

async function waitUntil(condition, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    if (host.exitCode !== null) throw new Error(`${label}: Host exited ${host.exitCode}: ${stderr.slice(-2000)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

try {
  if (!await waitUntil(() => stdout.includes('VAGUS_HOST_READY'), 'Host startup timed out')) throw new Error('Host startup timed out');
  await client.connect();
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await client.request('projects.create', { name: 'Claude minimal turn smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const created = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  sessionId = created.id;
  client.onEvent(event => { if (event.sessionId === sessionId) events.push(event); });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);
  const initial = await client.request('sessions.get-settings', { sessionId });
  if (initial.error) throw new Error(initial.error);
  let activeModel = initial.settings.modelId;
  const requestedModel = process.env.VAGUS_LIVE_MODEL || 'default';
  const requestedOption = catalog.models.find(model => model.id === requestedModel);
  if (!requestedOption) throw new Error(`Requested live-check model is not advertised: ${requestedModel}`);
  if (activeModel !== requestedModel) {
    const changed = await client.request('sessions.set-model', { sessionId, modelId: requestedModel });
    if (changed.error) throw new Error(`Could not select advertised model ${requestedModel}: ${changed.error}`);
    activeModel = changed.modelId;
  }
  const sent = await client.request('sessions.send', { sessionId, text: 'Reply with exactly PONG and nothing else.' });
  if (sent.error) throw new Error(sent.error);
  const completed = await waitUntil(() => {
    const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
    return events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle'
      && events.some(event => event.type === 'message.completed' && assistantIds.has(event.messageId));
  }, 'minimal reply timed out', 60_000);
  if (!completed) {
    await client.request('sessions.cancel', { sessionId }).catch(() => undefined);
    await waitUntil(() => events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle', 'cancel after timeout did not settle', 15_000);
  }
  const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
  const assistantText = events.filter(event => event.type === 'message.delta' && assistantIds.has(event.messageId)).map(event => event.text).join('');
  const result = {
    initialModel: initial.settings.modelId,
    testedModel: activeModel,
    requestedModelAdvertised: Boolean(requestedOption),
    completed,
    assistantText,
    states: events.filter(event => event.type === 'session.state').map(event => event.state),
    providerErrors: events.filter(event => event.type === 'provider.error').map(event => ({ code: event.code, message: event.message })),
    notifications: events.filter(event => event.type === 'notification').map(event => event.message),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!completed || !assistantText.includes('PONG') || result.providerErrors.length) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.stack : String(error), recentEvents: events.slice(-20).map(event => ({ type: event.type, state: event.state, code: event.code, message: event.message })), stderr: stderr.slice(-2000) }, null, 2));
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
  if (!resolve(root).startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (sessionId && !deleted) process.exitCode ||= 4;
}
