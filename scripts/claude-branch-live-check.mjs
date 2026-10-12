import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-branch-live-'));
const projectRoot = join(root, 'workspace');
const hostData = join(root, 'vagus-data');
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const token = randomBytes(32).toString('hex');
const host = spawn(process.execPath, [resolve('packages/host/dist/server.js')], {
  cwd: resolve('.'),
  env: { ...process.env, VAGUS_HOST_TOKEN: token, VAGUS_HOST_PORT: String(port), VAGUS_DATA_DIR: hostData, VAGUS_MANAGED_HOST: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let output = '';
let diagnostics = '';
host.stdout.on('data', chunk => output += chunk);
host.stderr.on('data', chunk => diagnostics += chunk);
const client = new HostClient(`ws://127.0.0.1:${port}/rpc`, { token });
const events = [];
let projectId;
let sessionId;
let branchId;
let deleted = false;

async function waitUntil(condition, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (host.exitCode !== null) throw new Error(`Host exited unexpectedly (${host.exitCode}): ${diagnostics}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: ${diagnostics.slice(-2500)}`);
}

try {
  await waitUntil(() => output.includes('VAGUS_HOST_READY'), 'Host did not start', 20_000);
  await client.connect();
  await mkdir(projectRoot, { recursive: true });
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await client.request('projects.create', { name: 'Claude branch smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  projectId = project.id;
  const session = await client.request('sessions.create', { projectId, providerId: 'claude' });
  if (session.error) throw new Error(session.error);
  sessionId = session.id;
  client.onEvent(event => { if (event.sessionId === sessionId || event.sessionId === branchId) events.push(event); });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);
  const marker = `vagus-branch-marker-${randomBytes(6).toString('hex')}`;
  const sent = await client.request('sessions.send', { sessionId, text: `Reply with exactly this token and nothing else: ${marker}` });
  if (sent.error) throw new Error(sent.error);
  await waitUntil(() => {
    const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
    return events.some(event => event.type === 'session.state' && event.state === 'idle')
      && events.some(event => event.type === 'message.completed' && assistantIds.has(event.messageId));
  }, 'Claude did not complete the branch seed turn');
  const summary = await client.request('sessions.open', { sessionId, historyLimit: 20 });
  if (summary.error) throw new Error(summary.error);
  const seed = summary.timeline?.filter(entry => entry.kind === 'message' && entry.role === 'assistant' && entry.complete).at(-1);
  if (!seed?.id) throw new Error('No completed assistant message was persisted for the fork point');
  const branch = await client.request('sessions.branch', { sessionId, messageId: seed.id });
  if (branch.error) throw new Error(branch.error);
  branchId = branch.id;
  if (!branchId || branchId === sessionId) throw new Error('Vagus did not create a distinct branch session');
  const opened = await client.request('sessions.open', { sessionId: branchId, historyLimit: 20 });
  if (opened.error) throw new Error(opened.error);
  const branchAssistant = opened.timeline?.filter(entry => entry.kind === 'message' && entry.role === 'assistant' && entry.complete).at(-1);
  const markerOccurrencesInBranch = branchAssistant?.text.split(marker).length - 1;
  const result = { distinctVagusSession: branchId !== sessionId, forkMetadataPresent: opened.branchRootSessionId === summary.branchRootSessionId || opened.branchRootSessionId === sessionId, forkPointMessageCopied: branchAssistant?.id === seed.id, forkPointMarkerPreservedExactlyOnce: markerOccurrencesInBranch === 1, markerReturned: seed.text.includes(marker), parentForkPoint: { text: seed.text, complete: seed.complete, sequence: seed.sequence, contentDeferred: seed.contentDeferred }, branchForkPoint: { text: branchAssistant?.text, complete: branchAssistant?.complete, sequence: branchAssistant?.sequence, contentDeferred: branchAssistant?.contentDeferred }, parentSessionId: sessionId, branchSessionId: branchId };
  console.log(JSON.stringify(result, null, 2));
  if (!result.distinctVagusSession || !result.forkMetadataPresent || !result.forkPointMessageCopied || !result.forkPointMarkerPreservedExactlyOnce || !result.markerReturned) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error), hostDiagnostics: diagnostics.slice(-2500), recentEvents: events.slice(-20).map(event => ({ type: event.type, role: event.role, state: event.state, code: event.code })) }, null, 2));
  process.exitCode = 3;
} finally {
  for (const id of [branchId, sessionId]) {
    if (!id) continue;
    await client.request('sessions.delete-permanent', { sessionId: id }).then(result => { if (result.error) throw new Error(result.error); }).catch(error => console.error(`Test session cleanup did not complete (${id}): ${error instanceof Error ? error.message : String(error)}`));
  }
  client.close();
  if (host.exitCode === null) {
    host.stdin.end('shutdown\n');
    await Promise.race([once(host, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (host.exitCode === null) { host.kill(); await once(host, 'exit'); }
  }
  if (!root.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
