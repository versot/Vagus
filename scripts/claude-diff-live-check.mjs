import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HostClient } from '../packages/client/dist/index.js';

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-diff-live-'));
const projectRoot = join(root, 'workspace');
const targetPath = join(projectRoot, 'src', 'vagus-diff-smoke.ts');
await mkdir(join(projectRoot, 'src'), { recursive: true });

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
const isSmokePath = path => typeof path === 'string' && path.replaceAll('\\', '/').endsWith('/src/vagus-diff-smoke.ts');

async function waitUntil(condition, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (host.exitCode !== null) throw new Error(`Host exited unexpectedly (${host.exitCode}): ${diagnostics}`);
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`${label}: ${diagnostics.slice(-2500)}`);
}

try {
  await waitUntil(() => output.includes('VAGUS_HOST_READY'), 'Host did not start', 20_000);
  await client.connect();
  stage = 'checking Claude Code health';
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await client.request('projects.create', { name: 'Claude diff smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  stage = 'creating Claude Code session';
  const created = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  sessionId = created.id;
  client.onEvent(event => { if (event.sessionId === sessionId) events.push(event); });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);
  stage = 'sending isolated file edit request';
  const sent = await client.request('sessions.send', {
    sessionId,
    text: `Use Claude Code's Write tool to create exactly this new file at src/vagus-diff-smoke.ts with the content shown below. Do not use Bash, do not inspect other files, and do not add any extra text to the file.\n\nexport const vagusDiffSmoke = "structured-diff-ok";`,
  });
  if (sent.error) throw new Error(sent.error);
  await waitUntil(async () => {
    const writeToolIds = new Set(events.filter(event => event.type === 'tool.started' && /write|edit/i.test(String(event.name))).map(event => event.toolCallId));
    if (!writeToolIds.size || !events.some(event => event.type === 'tool.completed' && writeToolIds.has(event.toolCallId))) return false;
    try { await readFile(targetPath, 'utf8'); return true; }
    catch { return false; }
  }, 'Claude did not complete a file-writing tool call and persist the target file');
  const toolEvents = events.filter(event => event.type === 'tool.started' || event.type === 'tool.updated');
  const diff = toolEvents.flatMap(event => Array.isArray(event.content) ? event.content : []).find(block => block?.type === 'diff' && isSmokePath(block.path));
  const fileText = await readFile(targetPath, 'utf8');
  const readPersistedDiff = () => {
    const db = new DatabaseSync(join(root, 'vagus-data', 'workspace.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare("SELECT data FROM entries WHERE session_id=? AND kind='tool' ORDER BY sequence DESC").all(sessionId);
      return rows.map(row => JSON.parse(String(row.data))).find(entry => Array.isArray(entry.content) && entry.content.some(block => block?.type === 'diff' && isSmokePath(block.path)));
    } finally { db.close(); }
  };
  let persisted;
  await waitUntil(() => { persisted = readPersistedDiff(); return Boolean(persisted); }, 'Vagus did not persist the structured file diff', 10_000);
  stage = 'waiting for the Claude turn to finish after the Write tool';
  await waitUntil(() => {
    const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
    return events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle'
      && events.some(event => event.type === 'message.completed' && assistantIds.has(event.messageId));
  }, 'Claude left the parent turn running after completing the Write tool', 60_000);
  const turnStateAfterWrite = events.filter(event => event.type === 'session.state').at(-1)?.state;
  const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
  const assistantCompleted = events.some(event => event.type === 'message.completed' && assistantIds.has(event.messageId));
  const providerErrors = events.filter(event => event.type === 'provider.error').map(event => ({ code: event.code, message: event.message }));
  const result = {
    turnStateAfterWrite,
    toolNames: [...new Set(toolEvents.filter(event => event.type === 'tool.started').map(event => event.name))],
    toolEventPayloads: toolEvents.map(event => ({ type: event.type, name: event.name, title: event.title, toolKind: event.toolKind, input: event.input, content: event.content, output: event.output })),
    liveDiff: diff ? { path: diff.path, oldText: diff.oldText ?? null, newText: diff.newText } : null,
    persistedDiff: Boolean(persisted),
    persistedToolState: persisted?.state ?? null,
    fileContentMatches: fileText.trim() === 'export const vagusDiffSmoke = "structured-diff-ok";',
    assistantCompleted,
    providerErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!diff || !persisted || persisted.state !== 'done' || !result.fileContentMatches || !assistantCompleted || turnStateAfterWrite !== 'idle' || providerErrors.length) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ stage, error: error instanceof Error ? error.stack : String(error), hostDiagnostics: diagnostics.slice(-2500), recentEvents: events.slice(-30).map(event => ({ type: event.type, name: event.name, toolCallId: event.toolCallId, input: event.input, content: event.content, output: event.output, outputDelta: event.outputDelta, code: event.code, message: event.message, state: event.state })) }, null, 2));
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
  if (sessionId && !deleted) process.exitCode ||= 4;
}
