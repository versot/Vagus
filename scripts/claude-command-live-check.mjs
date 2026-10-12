import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-command-live-'));
const projectRoot = join(root, 'workspace');
const dataDirectory = join(root, 'vagus-data');
await mkdir(projectRoot, { recursive: true });

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const token = randomBytes(32).toString('hex');
const host = spawn(process.execPath, [resolve('packages/host/dist/server.js')], {
  cwd: resolve('.'),
  env: { ...process.env, VAGUS_HOST_TOKEN: token, VAGUS_HOST_PORT: String(port), VAGUS_DATA_DIR: dataDirectory, VAGUS_MANAGED_HOST: '1' },
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
let deleteSucceeded = false;
let stage = 'starting Host';

async function waitUntil(condition, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (host.exitCode !== null) throw new Error(`Host exited unexpectedly (${host.exitCode}): ${diagnostics}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: ${diagnostics.slice(-2500)}`);
}

try {
  await waitUntil(() => output.includes('VAGUS_HOST_READY'), 'Host did not start');
  await client.connect();
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await client.request('projects.create', { name: 'Claude command smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const created = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  sessionId = created.id;
  client.onEvent(event => { if (event.sessionId === sessionId) events.push(event); });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);

  const memoryMarker = `vagus-compact-memory-${randomBytes(5).toString('hex')}`;
  stage = 'seeding a marker before context compaction';
  const seed = await client.request('sessions.send', { sessionId, text: `Remember this exact token for later: ${memoryMarker}. Reply only OK.` });
  if (seed.error) throw new Error(seed.error);
  await waitUntil(() => {
    const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
    return events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle'
      && events.some(event => event.type === 'message.completed' && assistantIds.has(event.messageId));
  }, 'Claude did not complete the marker seed turn', 60_000);

  stage = 'waiting for Claude ACP native command discovery';
  let commands = [];
  await waitUntil(async () => {
    const result = await client.request('sessions.get-commands', { sessionId });
    if (result.error) throw new Error(result.error);
    commands = result;
    return commands.length > 0;
  }, 'Claude ACP did not publish any slash commands', 15_000);
  const command = commands.find(item => item.name === 'context');
  if (!command) throw new Error(`Claude ACP did not publish the safe read-only /context command: ${commands.map(item => item.name).join(', ')}`);

  stage = `executing safe native /${command.name} command`;
  const sent = await client.request('sessions.send', { sessionId, text: `/${command.name}` });
  if (sent.error) throw new Error(sent.error);
  await waitUntil(() => {
    const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
    return events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle'
      && events.some(event => event.type === 'message.completed' && assistantIds.has(event.messageId));
  }, `/${command.name} did not finish`, 60_000);

  stage = 'requesting manual Claude Code context compaction';
  const compacted = await client.request('sessions.compact', { sessionId, instructions: `Preserve the exact token ${memoryMarker}.` });
  if (compacted.error) throw new Error(compacted.error);
  stage = 'checking the remembered token after compaction';
  const followup = await client.request('sessions.send', { sessionId, text: 'What exact token did I ask you to remember? Reply with only the token.' });
  if (followup.error) throw new Error(followup.error);
  await waitUntil(() => {
    const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
    const assistantText = events.filter(event => event.type === 'message.delta' && assistantIds.has(event.messageId)).map(event => event.text).join('');
    return assistantText.includes(memoryMarker)
      && events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle';
  }, 'Claude did not return the preserved marker after compaction', 60_000);
  const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
  const assistantText = events.filter(event => event.type === 'message.delta' && assistantIds.has(event.messageId)).map(event => event.text).join('');
  const providerErrors = events.filter(event => event.type === 'provider.error').map(event => ({ code: event.code, message: event.message }));
  const commandUpdates = events.filter(event => event.type === 'session.commands.updated').map(event => event.commands.length);
  const result = {
    commandCount: commands.length,
    commands: commands.map(({ name, source, inputHint, description }) => ({ name, source, inputHint: inputHint ?? null, description: description ?? null })),
    selectedCommand: { name: command.name, source: command.source, description: command.description ?? null },
    commandUpdateCounts: commandUpdates,
    sentSlashCommand: `/${command.name}`,
    contextCompactionRpcSucceeded: compacted.compacted === true,
    tokenPreservedAfterCompaction: assistantText.includes(memoryMarker),
    assistantCompleted: assistantIds.size > 0,
    finalState: events.filter(event => event.type === 'session.state').at(-1)?.state,
    assistantPreview: assistantText.slice(-500),
    providerErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.assistantCompleted || !result.contextCompactionRpcSucceeded || !result.tokenPreservedAfterCompaction || result.finalState !== 'idle' || providerErrors.length) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ stage, error: error instanceof Error ? error.stack : String(error), hostDiagnostics: diagnostics.slice(-2500), recentEvents: events.slice(-25).map(event => ({ type: event.type, state: event.state, code: event.code, name: event.name, message: event.message })) }, null, 2));
  process.exitCode = 3;
} finally {
  if (sessionId) {
    const deleted = await client.request('sessions.delete-permanent', { sessionId }).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
    deleteSucceeded = !deleted.error;
    if (deleted.error) console.error(`Test-session cleanup did not complete: ${deleted.error}`);
  }
  client.close();
  if (host.exitCode === null) {
    host.stdin.end('shutdown\n');
    await Promise.race([once(host, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (host.exitCode === null) { host.kill(); await once(host, 'exit'); }
  }
  if (!root.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (sessionId && !deleteSucceeded) process.exitCode ||= 4;
}
