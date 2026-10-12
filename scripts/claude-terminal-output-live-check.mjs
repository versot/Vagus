import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-terminal-output-'));
const projectRoot = join(root, 'workspace');
const skillDirectory = join(projectRoot, '.claude', 'skills', 'vagus-terminal-output-smoke');
await mkdir(skillDirectory, { recursive: true });
await writeFile(join(skillDirectory, 'SKILL.md'), `---\nname: vagus-terminal-output-smoke\ndescription: Use only when explicitly requested by the Vagus terminal output smoke check.\n---\nUse the Shell tool to run exactly: echo VAGUS_TERMINAL_STREAM_OK. Do not read or modify files. Report the command output.\n`, 'utf8');

const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const token = randomBytes(32).toString('hex');
const dataDirectory = join(root, 'vagus-data');
const host = spawn(process.execPath, [resolve('packages/host/dist/server.js')], {
  cwd: resolve('.'),
  env: { ...process.env, VAGUS_HOST_TOKEN: token, VAGUS_HOST_PORT: String(port), VAGUS_DATA_DIR: dataDirectory, VAGUS_MANAGED_HOST: '1' },
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

async function waitUntil(condition, message, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    if (host.exitCode !== null) throw new Error(`Host exited (${host.exitCode}): ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${message}: ${stderr.slice(-2500)}`);
}

try {
  await waitUntil(() => stdout.includes('VAGUS_HOST_READY'), 'Host did not start', 30_000);
  await client.connect();
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await client.request('projects.create', { name: 'Claude terminal output smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const session = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (session.error) throw new Error(session.error);
  sessionId = session.id;
  client.onEvent(event => { if (event.sessionId === sessionId) events.push(event); });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);
  const sent = await client.request('sessions.send', { sessionId, text: 'Invoke vagus-terminal-output-smoke and follow its instructions exactly.' });
  if (sent.error) throw new Error(sent.error);
  await waitUntil(() => events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle', 'Claude did not finish shell output smoke');

  const allToolEvents = events.filter(event => event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed');
  const shellIds = new Set(allToolEvents.filter(event => event.type === 'tool.started' && /bash|shell/i.test(`${event.name ?? ''} ${event.title ?? ''} ${JSON.stringify(event.input ?? '')}`)).map(event => event.toolCallId));
  const toolEvents = allToolEvents.filter(event => shellIds.has(event.toolCallId));
  const outputDelta = toolEvents.filter(event => event.type === 'tool.updated').map(event => event.outputDelta ?? '').join('');
  const outputSnapshot = toolEvents.filter(event => event.type === 'tool.updated' && event.output !== undefined).map(event => typeof event.output === 'string' ? event.output : '').join('');
  const completed = toolEvents.findLast(event => event.type === 'tool.completed');
  const result = {
    shellToolObserved: toolEvents.some(event => event.type === 'tool.started'),
    streamedOutput: outputDelta || null,
    snapshotOutput: outputSnapshot || null,
    terminalExitCode: completed?.terminalExitCode ?? null,
    toolEvents: toolEvents.map(event => ({ type: event.type, name: event.name, title: event.title, input: event.input, output: event.output, outputDelta: event.outputDelta, terminalExitCode: event.terminalExitCode })),
    providerErrors: events.filter(event => event.type === 'provider.error').map(event => event.message),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.shellToolObserved || !`${outputDelta}${outputSnapshot}`.includes('VAGUS_TERMINAL_STREAM_OK') || result.terminalExitCode !== 0 || result.providerErrors.length) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    sessionId,
    recentEvents: events.slice(-50).map(event => ({
      type: event.type,
      state: event.state,
      interactionId: event.interactionId,
      interaction: event.interaction,
      toolCallId: event.toolCallId,
      name: event.name,
      title: event.title,
      input: event.input,
      output: event.output,
      outputDelta: event.outputDelta,
      message: event.message,
    })),
    hostDiagnostics: stderr.slice(-2500),
  }, null, 2));
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
  await rm(root, { recursive: true, force: true });
  if (sessionId && !cleaned) process.exitCode ||= 4;
}
