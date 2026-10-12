import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

const root = await mkdtemp(join(tmpdir(), 'vagus-pi-cancel-live-'));
const projectRoot = join(root, 'workspace');
const piHome = join(root, 'pi-agent');
await mkdir(projectRoot, { recursive: true });
await mkdir(piHome, { recursive: true });

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const token = randomBytes(32).toString('hex');
const host = spawn(process.execPath, [resolve('packages/host/dist/server.js')], {
  cwd: resolve('.'),
  env: {
    ...process.env,
    VAGUS_HOST_TOKEN: token,
    VAGUS_HOST_PORT: String(port),
    VAGUS_DATA_DIR: join(root, 'vagus-data'),
    VAGUS_MANAGED_HOST: '1',
    PI_CODING_AGENT_DIR: piHome,
  },
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

async function waitFor(condition, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (host.exitCode !== null) throw new Error(`Host exited (${host.exitCode}): ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: ${stderr.slice(-1500)}`);
}

try {
  await waitFor(() => stdout.includes('VAGUS_HOST_READY'), 'Host did not start');
  await client.connect();
  const health = await client.request('providers.models.refresh', { providerId: 'pi' });
  if (health.error) throw new Error(`Pi health check failed: ${health.error}`);
  const project = await client.request('projects.create', { name: 'Pi cancel isolated', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const session = await client.request('sessions.create', { projectId: project.id, providerId: 'pi' });
  if (session.error) throw new Error(session.error);
  sessionId = session.id;
  client.onEvent(event => { if (event.sessionId === sessionId) events.push(event); });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);
  const sent = await client.request('sessions.send', {
    sessionId,
    text: '请不要使用任何工具，持续写一篇不少于 100 个编号段落、每段至少 80 字的中文软件架构文章，直到我停止。',
  });
  if (sent.error) throw new Error(sent.error);
  await waitFor(() => events.some(event => event.type === 'session.state' && event.state === 'running'), 'Pi did not enter running state');
  const cancelled = await client.request('sessions.cancel', { sessionId });
  if (cancelled.error) throw new Error(`Cancel RPC failed: ${cancelled.error}`);
  await waitFor(() => events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle', 'Pi did not return to idle after cancellation', 30_000);
  const result = {
    cancelRpc: 'success',
    states: events.filter(event => event.type === 'session.state').map(event => event.state),
    errors: events.filter(event => event.type === 'provider.error').map(event => event.message),
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({
    error: error instanceof Error ? error.stack : String(error),
    stderr: stderr.slice(-1500),
    events: events.slice(-15).map(event => ({ type: event.type, state: event.state, message: event.message })),
  }, null, 2));
  process.exitCode = 3;
} finally {
  client.close();
  if (host.exitCode === null) {
    host.stdin.end('shutdown\n');
    await Promise.race([once(host, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (host.exitCode === null) {
      host.kill();
      await once(host, 'exit');
    }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
