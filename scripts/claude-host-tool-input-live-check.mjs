import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HostClient } from '../packages/client/dist/index.js';

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-host-input-'));
const projectRoot = join(root, 'workspace');
const skillDirectory = join(projectRoot, '.claude', 'skills', 'vagus-host-input-smoke');
await mkdir(skillDirectory, { recursive: true });
await writeFile(join(skillDirectory, 'SKILL.md'), `---\nname: vagus-host-input-smoke\ndescription: Use only when explicitly asked to invoke this Vagus Host persistence smoke test.\n---\nReturn exactly HOST_INPUT_SMOKE_OK and do not call any additional tools.\n`, 'utf8');

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const token = randomBytes(32).toString('hex');
const dataDirectory = join(root, 'vagus-data');
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
let cleanupSucceeded = false;

async function waitUntil(condition, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (host.exitCode !== null) throw new Error(`Host exited unexpectedly (${host.exitCode}): ${diagnostics}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${message}: ${diagnostics}`);
}

try {
  await waitUntil(() => output.includes('VAGUS_HOST_READY'), 'Host did not start');
  await client.connect();
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  if (!catalog.models.length) throw new Error('Claude Code returned an empty model catalog');
  const project = await client.request('projects.create', { name: 'Claude ACP persistence smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const created = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  sessionId = created.id;
  client.onEvent(event => { if (event.sessionId === sessionId) events.push(event); });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);
  const sent = await client.request('sessions.send', { sessionId, text: 'Invoke the vagus-host-input-smoke skill now. Do not use any other tools.' });
  if (sent.error) throw new Error(sent.error);
  await waitUntil(() => events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle'
    && events.some(event => event.type === 'tool.started' && String(event.name).toLowerCase().includes('skill')), 'Claude did not complete the smoke tool call', 90_000);

  // Force pending Host writes through SQLite, then inspect persisted activity.
  const history = await client.request('sessions.history', { sessionId, limit: 500 });
  if (history.error) throw new Error(history.error);
  const db = new DatabaseSync(join(dataDirectory, 'workspace.sqlite'), { readOnly: true });
  const row = db.prepare("SELECT data FROM entries WHERE session_id=? AND kind='tool' ORDER BY sequence DESC LIMIT 1").get(sessionId);
  db.close();
  if (!row) throw new Error('No persisted Claude tool entry was found');
  const tool = JSON.parse(String(row.data));
  const input = tool.input;
  const inputKeys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : [];
  const toolEvents = events.filter(event => event.type === 'tool.started' || event.type === 'tool.updated');
  const hasNonEmptyUpdate = toolEvents.some(event => event.type === 'tool.updated' && event.input && typeof event.input === 'object' && Object.keys(event.input).length > 0);
  const result = { toolName: tool.name, persistedInputKeys: inputKeys, sawNonEmptyInputUpdate: hasNonEmptyUpdate, states: events.filter(event => event.type === 'session.state').map(event => event.state), providerErrors: events.filter(event => event.type === 'provider.error').map(event => event.code) };
  console.log(JSON.stringify(result, null, 2));
  if (!inputKeys.length || !hasNonEmptyUpdate || result.providerErrors.length) process.exitCode = 2;
} catch (error) {
  const eventSummary = events.map(event => ({
    type: event.type,
    state: event.type === 'session.state' ? event.state : undefined,
    name: event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed' ? event.name : undefined,
    input: event.type === 'tool.started' || event.type === 'tool.updated' ? event.input : undefined,
    text: event.type === 'message.delta' ? String(event.text).slice(0, 160) : undefined,
    output: event.type === 'tool.updated' || event.type === 'tool.completed' ? String(event.output ?? '').slice(0, 240) : undefined,
    code: event.type === 'provider.error' ? event.code : undefined,
    message: event.type === 'provider.error' ? event.message : undefined,
  }));
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error), eventSummary, hostDiagnostics: diagnostics.slice(-3000) }, null, 2));
  process.exitCode = 3;
} finally {
  if (sessionId && client) {
    const deleted = await client.request('sessions.delete-permanent', { sessionId }).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
    cleanupSucceeded = !deleted.error;
    if (deleted.error) console.error(`Test-session cleanup did not complete: ${deleted.error}`);
  }
  client.close();
  if (host.exitCode === null) {
    host.stdin.end('shutdown\n');
    await Promise.race([once(host, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (host.exitCode === null) { host.kill(); await once(host, 'exit'); }
  }
  if (!root.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true });
  if (sessionId && !cleanupSucceeded) process.exitCode ||= 4;
}
