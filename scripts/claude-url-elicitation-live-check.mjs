import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-url-elicitation-'));
const projectRoot = join(root, 'workspace');
const resultFile = join(root, 'elicitation-result.json');
const traceFile = join(root, 'mcp-trace.jsonl');
await mkdir(projectRoot, { recursive: true });
await writeFile(join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { vagus_url_smoke: {
  type: 'stdio', command: process.execPath, args: [resolve('scripts/claude-url-elicitation-mcp-smoke-server.mjs')], env: { VAGUS_URL_ELICITATION_RESULT_FILE: resultFile, VAGUS_URL_ELICITATION_TRACE_FILE: traceFile },
} } }), 'utf8');

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const token = randomBytes(32).toString('hex');
const host = spawn(process.execPath, [resolve('packages/host/dist/server.js')], {
  cwd: resolve('.'), env: { ...process.env, VAGUS_HOST_TOKEN: token, VAGUS_HOST_PORT: String(port), VAGUS_DATA_DIR: join(root, 'vagus-data'), VAGUS_MANAGED_HOST: '1' },
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
let interactionResponseError;

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
  const project = await client.request('projects.create', { name: 'Claude URL elicitation smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const created = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  sessionId = created.id;
  client.onEvent(event => {
    if (event.sessionId !== sessionId) return;
    events.push(event);
    if (event.type !== 'interaction.requested' || event.interaction.kind !== 'url-consent') return;
    void client.request('interactions.respond', { sessionId, interactionId: event.interactionId, value: true })
      .then(result => { if (result.error) interactionResponseError = result.error; })
      .catch(error => { interactionResponseError = error instanceof Error ? error.message : String(error); });
  });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);
  const sent = await client.request('sessions.send', { sessionId, text: 'Call the vagus_url_smoke ask_url tool exactly once. Do not answer until the result returns.' });
  if (sent.error) throw new Error(sent.error);
  await waitUntil(async () => {
    try { await readFile(resultFile, 'utf8'); return events.some(event => event.type === 'tool.completed'); }
    catch { return false; }
  }, 'Claude did not complete the ACP URL elicitation round trip', 45_000);

  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  const mcpTrace = (await readFile(traceFile, 'utf8')).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const requested = events.find(event => event.type === 'interaction.requested' && event.interaction.kind === 'url-consent');
  const response = requested && events.find(event => event.type === 'interaction.responded' && event.interactionId === requested.interactionId);
  const actualUrl = requested?.interaction.kind === 'url-consent' ? new URL(requested.interaction.url) : null;
  const providerErrors = events.filter(event => event.type === 'provider.error').map(event => ({ code: event.code, message: event.message }));
  const summary = {
    requestReachedVagus: Boolean(requested),
    interactionKind: requested?.interaction.kind ?? null,
    authorizationHostShown: requested?.interaction.kind === 'url-consent' ? requested.interaction.host : null,
    embeddedCredentialsRejectedAtUiBoundary: actualUrl ? !actualUrl.username && !actualUrl.password && ['https:', 'http:'].includes(actualUrl.protocol) : false,
    userConsentAccepted: response?.value === true,
    acceptedResponseReturnedToMcp: result.action === 'accept',
    mcpResult: result,
    mcpInitializeCapabilities: mcpTrace.find(message => message.method === 'initialize')?.params?.capabilities ?? null,
    toolEvents: events.filter(event => event.type.startsWith('tool.')).map(event => ({ type: event.type, name: event.name, isError: event.isError, output: event.output })),
    assistantText: events.filter(event => event.type === 'message.delta').map(event => event.text).join(''),
    mcpReceivedNoCredentialContent: !result.content || Object.keys(result.content).length === 0,
    providerErrors,
    interactionResponseError: interactionResponseError ?? null,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.requestReachedVagus || summary.interactionKind !== 'url-consent' || !summary.authorizationHostShown || !summary.embeddedCredentialsRejectedAtUiBoundary || !summary.userConsentAccepted || !summary.acceptedResponseReturnedToMcp || !summary.mcpReceivedNoCredentialContent || providerErrors.length || interactionResponseError) process.exitCode = 2;
  if (events.filter(event => event.type === 'session.state').at(-1)?.state === 'running') {
    const cancelled = await client.request('sessions.cancel', { sessionId });
    if (cancelled.error) throw new Error(`URL elicitation finished, but test cleanup could not stop Claude: ${cancelled.error}`);
    await waitUntil(async () => events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle', 'Claude did not return to idle after test cleanup', 20_000);
  }
} catch (error) {
  const mcpTrace = await readFile(traceFile, 'utf8').catch(() => '');
  const result = await readFile(resultFile, 'utf8').catch(() => null);
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error), hostDiagnostics: diagnostics.slice(-2500), mcpTrace: mcpTrace.split(/\r?\n/u).filter(Boolean).map(line => { try { const message = JSON.parse(line); return { method: message.method, capabilities: message.method === 'initialize' ? message.params?.capabilities : undefined, error: message.error, response: message.method === 'elicitation/create' || message.id ? message.result : undefined }; } catch { return line.slice(0, 500); } }), result, recentEvents: events.slice(-30).map(event => ({ type: event.type, state: event.state, code: event.code, name: event.name, toolCallId: event.toolCallId, input: event.input, isError: event.isError, kind: event.type === 'interaction.requested' ? event.interaction.kind : undefined, title: event.type === 'interaction.requested' ? event.interaction.title : undefined, message: event.type === 'message.delta' ? event.text : event.message, output: event.output })) }, null, 2));
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
