import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-input-mcp-'));
const projectRoot = join(root, 'workspace');
const resultFile = join(root, 'mcp-arguments.json');
await mkdir(projectRoot, { recursive: true });
await writeFile(join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { vagus_input_smoke: {
  type: 'stdio', command: process.execPath, args: [resolve('scripts/claude-input-mcp-smoke-server.mjs')], env: { VAGUS_INPUT_MCP_RESULT_FILE: resultFile },
} } }), 'utf8');

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const token = randomBytes(32).toString('hex');
const host = spawn(process.execPath, [resolve('packages/host/dist/server.js')], {
  cwd: resolve('.'),
  env: { ...process.env, VAGUS_HOST_TOKEN: token, VAGUS_HOST_PORT: String(port), VAGUS_DATA_DIR: join(root, 'vagus-data'), VAGUS_MANAGED_HOST: '1' },
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let stdout = '';
let stderr = '';
host.stdout.on('data', chunk => stdout += chunk);
host.stderr.on('data', chunk => stderr += chunk);
const client = new HostClient(`ws://127.0.0.1:${port}/rpc`, { token });
const events = [];
let sessionId;
let cleaned = false;
let stage = 'starting Host';
let targetToolCallId;

async function waitUntil(condition, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (host.exitCode !== null) throw new Error(`Host exited unexpectedly (${host.exitCode}): ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${label}: ${stderr.slice(-2500)}`);
}

try {
  await waitUntil(() => stdout.includes('VAGUS_HOST_READY'), 'Host did not start', 30_000);
  await client.connect();
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await client.request('projects.create', { name: 'Claude MCP input smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const created = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  sessionId = created.id;
  client.onEvent(event => {
    if (event.sessionId !== sessionId) return;
    events.push(event);
    if (event.type === 'tool.started' && /echo_arguments|vagus_input_smoke/iu.test(`${event.name ?? ''} ${event.title ?? ''}`)) targetToolCallId = event.toolCallId;
    if (event.type !== 'interaction.requested' || event.interaction.kind !== 'choice') return;
    const text = `${event.interaction.title ?? ''} ${event.interaction.message ?? ''}`;
    const allow = event.interaction.options.find(option => /允许一次|allow once/iu.test(option));
    const permitted = /echo_arguments|vagus_input_smoke/iu.test(text);
    void client.request('interactions.respond', { sessionId, interactionId: event.interactionId, value: permitted ? allow ?? false : false }).catch(() => undefined);
  });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);

  stage = 'calling a local MCP tool with distinct arguments';
  const sent = await client.request('sessions.send', { sessionId, text: 'Call the vagus_input_smoke echo_arguments tool exactly once with phrase set to ORBIT_SIGNAL_913 and count set to 17. Do not call any other tools.' });
  if (sent.error) throw new Error(sent.error);
  await waitUntil(async () => {
    try {
      await readFile(resultFile, 'utf8');
      return Boolean(targetToolCallId && events.some(event => event.type === 'tool.completed' && event.toolCallId === targetToolCallId));
    }
    catch { return false; }
  }, 'Claude did not complete the local MCP tool call');

  const toolEvents = events.filter(event => (event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed') && event.toolCallId === targetToolCallId);
  const inputUpdates = toolEvents.filter(event => event.type === 'tool.started' || event.type === 'tool.updated').filter(event => event.input !== undefined).map(event => event.input);
  const toolInput = inputUpdates.findLast(value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
  const mcpArguments = JSON.parse(await readFile(resultFile, 'utf8'));
  const toolOutput = toolEvents.filter(event => event.type === 'tool.updated' || event.type === 'tool.completed').map(event => JSON.stringify({ output: event.output, content: event.content, outputDelta: event.outputDelta })).join('\n');
  const providerErrors = events.filter(event => event.type === 'provider.error').map(event => ({ code: event.code, message: event.message }));
  const result = {
    toolCallId: targetToolCallId,
    toolEventNames: toolEvents.map(event => ({ type: event.type, name: event.name, title: event.title })),
    toolEventPayloads: toolEvents.map(event => ({ type: event.type, name: event.name, input: event.input, content: event.content, output: event.output, outputDelta: event.outputDelta, isError: event.isError })),
    firstToolInput: inputUpdates[0] ?? null,
    finalToolInput: toolInput ?? null,
    mcpReceivedArguments: mcpArguments,
    outputContainsMarker: toolOutput.includes('ORBIT_SIGNAL_913'),
    providerErrors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!toolInput || toolInput.phrase !== 'ORBIT_SIGNAL_913' || toolInput.count !== 17 || JSON.stringify(mcpArguments) !== JSON.stringify({ phrase: 'ORBIT_SIGNAL_913', count: 17 }) || !result.outputContainsMarker || providerErrors.length) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ stage, error: error instanceof Error ? error.stack : String(error), recentEvents: events.slice(-60).map(event => ({ type: event.type, state: event.state, interaction: event.interaction, interactionId: event.interactionId, name: event.name, title: event.title, input: event.input, output: event.output, text: event.text, message: event.message })), hostDiagnostics: stderr.slice(-2500) }, null, 2));
  process.exitCode = 3;
} finally {
  if (sessionId) {
    const deleted = await client.request('sessions.delete-permanent', { sessionId }).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
    cleaned = !deleted.error;
    if (!cleaned) console.error(`Isolated session cleanup did not complete: ${deleted.error}`);
  }
  client.close();
  if (host.exitCode === null) {
    host.stdin.end('shutdown\n');
    await Promise.race([once(host, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (host.exitCode === null) { host.kill(); await once(host, 'exit'); }
  }
  if (!root.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (sessionId && !cleaned) process.exitCode ||= 4;
}
