import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-queue-live-'));
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
let stage = 'starting Host';

async function waitUntil(condition, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (host.exitCode !== null) throw new Error(`Host exited (${host.exitCode}): ${stderr.slice(-2500)}`);
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`${label}: ${stderr.slice(-2500)}`);
}

try {
  await waitUntil(() => stdout.includes('VAGUS_HOST_READY'), 'Host did not start', 20_000);
  await client.connect();
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await client.request('projects.create', { name: 'Claude queue smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const created = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  sessionId = created.id;
  client.onEvent(event => { if (event.sessionId === sessionId) events.push(event); });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);

  stage = 'sending a long parent turn then a follow-up';
  const first = await client.request('sessions.send', { sessionId, text: 'Do not use tools. Write 60 numbered short paragraphs about reliable software. Keep working until all 60 are written.' });
  if (first.error) throw new Error(first.error);
  await waitUntil(() => events.some(event => event.type === 'session.state' && event.state === 'running'), 'Claude did not enter running state', 30_000);
  const followupMarker = `VAGUS_QUEUE_FOLLOWUP_${randomBytes(5).toString('hex')}`;
  const followup = await client.request('sessions.send', { sessionId, deliveryMode: 'follow-up', text: `Reply with exactly this marker and nothing else: ${followupMarker}` });
  if (followup.error) throw new Error(followup.error);

  const queueEvents = events.filter(event => event.type === 'session.queue.updated');
  const queued = queueEvents.some(event => event.queue?.followUp?.some(text => text.includes(followupMarker)));
  stage = 'waiting for queued follow-up to run';
  await waitUntil(() => {
    const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
    const assistantText = events.filter(event => event.type === 'message.delta' && assistantIds.has(event.messageId)).map(event => event.text).join('');
    return assistantText.includes(followupMarker)
      && events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle';
  }, 'Queued Claude follow-up did not complete', 120_000);
  const opened = await client.request('sessions.open', { sessionId, historyLimit: 80 });
  if (opened.error) throw new Error(opened.error);
  const messages = opened.timeline.filter(entry => entry.kind === 'message');
  const assistantText = messages.filter(entry => entry.role === 'assistant').map(entry => entry.text).join('\n');
  const providerErrors = events.filter(event => event.type === 'provider.error').map(event => ({ code: event.code, message: event.message }));
  const result = {
    followUpDisposition: followup.disposition,
    queueEventObserved: queued,
    firstUserMessagePersisted: messages.some(entry => entry.role === 'user' && entry.text.includes('60 numbered short paragraphs')),
    followUpMessagePersisted: messages.some(entry => entry.role === 'user' && entry.text.includes(followupMarker)),
    followUpAnswerReturned: assistantText.includes(followupMarker),
    finalState: events.filter(event => event.type === 'session.state').at(-1)?.state,
    providerErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (followup.disposition !== 'queued' || !queued || !result.firstUserMessagePersisted || !result.followUpMessagePersisted || !result.followUpAnswerReturned || result.finalState !== 'idle' || providerErrors.length) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ stage, error: error instanceof Error ? error.stack : String(error), stderr: stderr.slice(-2500), recentEvents: events.slice(-25).map(event => ({ type: event.type, role: event.role, state: event.state, code: event.code, message: event.type === 'message.delta' ? event.text?.slice(0, 160) : event.type === 'provider.error' ? event.message : undefined })) }, null, 2));
  process.exitCode = 3;
} finally {
  if (sessionId && events.filter(event => event.type === 'session.state').at(-1)?.state === 'running') {
    await client.request('sessions.cancel', { sessionId }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
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
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (sessionId && !deleted) process.exitCode ||= 4;
}
