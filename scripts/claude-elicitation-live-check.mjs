import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-elicitation-live-'));
const projectRoot = join(root, 'workspace');
const claudeConfig = join(projectRoot, '.mcp.json');
const resultFile = join(root, 'elicitation-result.json');
const hostData = join(root, 'vagus-data');
const serverScript = resolve('scripts/claude-elicitation-mcp-smoke-server.mjs');
await mkdir(projectRoot, { recursive: true });
await writeFile(claudeConfig, JSON.stringify({ mcpServers: { vagus_form_smoke: {
  type: 'stdio', command: process.execPath, args: [serverScript], env: { VAGUS_ELICITATION_RESULT_FILE: resultFile },
} } }), 'utf8');

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const token = randomBytes(32).toString('hex');
const host = spawn(process.execPath, [resolve('packages/host/dist/server.js')], {
  cwd: resolve('.'), env: { ...process.env, VAGUS_HOST_TOKEN: token, VAGUS_HOST_PORT: String(port), VAGUS_DATA_DIR: hostData, VAGUS_MANAGED_HOST: '1' },
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let output = '';
let diagnostics = '';
host.stdout.on('data', chunk => output += chunk);
host.stderr.on('data', chunk => diagnostics += chunk);
const client = new HostClient(`ws://127.0.0.1:${port}/rpc`, { token });
const events = [];
let sessionId;
let deleteSucceeded = false;
let formResponseError;

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
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await client.request('projects.create', { name: 'Claude elicitation smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const created = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  sessionId = created.id;
  client.onEvent(event => {
    if (event.sessionId !== sessionId) return;
    events.push(event);
    if (event.type !== 'interaction.requested') return;
    if (event.interaction.kind === 'choice') {
      const index = event.interaction.optionHints?.findIndex(hint => /允许一次|allow once/iu.test(hint)) ?? -1;
      if (index >= 0) void client.request('interactions.respond', { sessionId, interactionId: event.interactionId, value: event.interaction.options[index] }).then(result => { if (result.error) formResponseError = result.error; }).catch(error => { formResponseError = error instanceof Error ? error.message : String(error); });
    } else if (event.interaction.kind === 'form') {
      void client.request('interactions.respond', { sessionId, interactionId: event.interactionId, value: JSON.stringify({ name: 'Vagus', count: 3, enabled: true, priority: 'high', labels: ['red', 'blue'] }) }).then(result => { if (result.error) formResponseError = result.error; }).catch(error => { formResponseError = error instanceof Error ? error.message : String(error); });
    }
  });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);
  const sent = await client.request('sessions.send', { sessionId, text: 'Call the vagus_form_smoke ask_form tool exactly once. Do not answer until it returns.' });
  if (sent.error) throw new Error(sent.error);
  await waitUntil(async () => {
    try { await readFile(resultFile, 'utf8'); return events.some(event => event.type === 'tool.completed'); }
    catch { return false; }
  }, 'Claude did not complete the ACP elicitation round trip');
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  const form = events.find(event => event.type === 'interaction.requested' && event.interaction.kind === 'form')?.interaction;
  const formInteractionId = events.find(event => event.type === 'interaction.requested' && event.interaction.kind === 'form')?.interactionId;
  const formResponseEvents = events.filter(event => event.type === 'interaction.responded' && event.interactionId === formInteractionId);
  const fields = form?.fields ?? [];
  const actual = result.action === 'accept' ? result.content : null;
  const expected = { name: 'Vagus', count: 3, enabled: true, priority: 'high', labels: ['red', 'blue'] };
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  const providerErrors = events.filter(event => event.type === 'provider.error').map(event => event.code);
  const tool = events.find(event => event.type === 'tool.started' && String(event.name).includes('ask_form'));
  const summary = { formTitle: form?.title ?? null, fieldTypes: fields.map(field => ({ id: field.id, type: field.type, required: field.required })), submittedAndReturned: passed, returnedFieldIds: actual ? Object.keys(actual) : [], mcpToolWasInvoked: Boolean(tool), formResponseEventCount: formResponseEvents.length, providerErrors, interactionResponseError: formResponseError ?? null };
  console.log(JSON.stringify(summary, null, 2));
  if (!passed || fields.length !== 5 || formResponseEvents.length !== 1 || !tool || providerErrors.length || formResponseError) process.exitCode = 2;
  if (events.filter(event => event.type === 'session.state').at(-1)?.state === 'running') {
    const cancelled = await client.request('sessions.cancel', { sessionId });
    if (cancelled.error) throw new Error(`MCP elicitation finished, but test cleanup could not stop the remaining answer: ${cancelled.error}`);
    await waitUntil(async () => events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle', 'Claude did not return to idle after test cleanup', 20_000);
  }
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error), hostDiagnostics: diagnostics.slice(-2500), recentEvents: events.slice(-20).map(event => event.type === 'interaction.requested' ? { type: event.type, kind: event.interaction.kind, title: event.interaction.title } : { type: event.type, state: event.state, code: event.code }) }, null, 2));
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
  await rm(root, { recursive: true, force: true });
  if (sessionId && !deleteSucceeded) process.exitCode ||= 4;
}
