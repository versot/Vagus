import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-tool-cancel-'));
const projectRoot = join(root, 'workspace');
await mkdir(projectRoot, { recursive: true });
await writeFile(join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { vagus_cancel_smoke: {
  type: 'stdio', command: process.execPath, args: [resolve('scripts/claude-cancel-mcp-smoke-server.mjs')],
} } }), 'utf8');

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
let deleteSucceeded = false;
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
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await client.request('projects.create', { name: 'Claude tool cancellation smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const created = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  sessionId = created.id;
  client.onEvent(event => {
    if (event.sessionId !== sessionId) return;
    events.push(event);
    if (event.type !== 'interaction.requested' || event.interaction.kind !== 'choice') return;
    const name = `${event.interaction.title ?? ''} ${event.interaction.message ?? ''}`;
    const isOnlySmokeTool = /wait_for_cancel|vagus_cancel_smoke/iu.test(name);
    const allow = event.interaction.options.find(option => /允许一次|allow once/iu.test(option));
    void client.request('interactions.respond', { sessionId, interactionId: event.interactionId, value: isOnlySmokeTool ? allow ?? false : false }).catch(() => undefined);
  });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);

  stage = 'starting the harmless long-running MCP tool';
  const sent = await client.request('sessions.send', { sessionId, text: 'Call the vagus_cancel_smoke wait_for_cancel tool exactly once with seconds set to 20. Do not call any other tool.' });
  if (sent.error) throw new Error(sent.error);
  let toolInput = null;
  await waitUntil(() => {
    const toolStart = events.find(event => event.type === 'tool.started' && String(event.name).includes('wait_for_cancel'));
    if (!toolStart || events.some(event => event.type === 'tool.completed' && event.toolCallId === toolStart.toolCallId)) return false;
    toolInput = events.filter(event => (event.type === 'tool.started' || event.type === 'tool.updated') && event.toolCallId === toolStart.toolCallId && event.input !== undefined).map(event => event.input).findLast(input => input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length > 0) ?? null;
    return toolInput?.seconds === 20;
  }, 'Claude did not stream the MCP tool arguments { seconds: 20 }', 20_000);

  stage = 'cancelling while the MCP tool is running';
  const cancelled = await client.request('sessions.cancel', { sessionId });
  if (cancelled.error) throw new Error(cancelled.error);
  await waitUntil(() => events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle', 'Claude did not return to idle after cancelling an active tool', 20_000);
  const notifications = events.filter(event => event.type === 'notification').map(event => event.message);
  const errors = events.filter(event => event.type === 'provider.error').map(event => event.message);
  const result = {
    toolEntered: true,
    cancelRpc: 'success',
    toolInput,
    states: events.filter(event => event.type === 'session.state').map(event => event.state),
    stopNotification: notifications.find(message => message.includes('已停止当前任务')) ?? null,
    methodNotFoundErrors: errors.filter(message => /method not found|session\/cancel/i.test(message)),
    providerErrors: errors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.stopNotification || result.methodNotFoundErrors.length || result.providerErrors.length || result.toolInput?.seconds !== 20) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ stage, error: error instanceof Error ? error.stack : String(error), hostDiagnostics: diagnostics.slice(-2500), recentEvents: events.slice(-25).map(event => ({ type: event.type, state: event.state, code: event.code, name: event.name, message: event.message })) }, null, 2));
  process.exitCode = 3;
} finally {
  if (sessionId) {
    const deleted = await client.request('sessions.delete-permanent', { sessionId }).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
    deleteSucceeded = !deleted.error;
    if (!deleteSucceeded) console.error(`Test-session cleanup did not complete: ${deleted.error}`);
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
