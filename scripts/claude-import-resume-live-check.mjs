import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';
import { ClaudeProvider } from "../packages/host/dist/agent/providers/claude/claude-provider.js";

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-import-resume-'));
const projectRoot = join(root, 'workspace');
const firstDataDirectory = join(root, 'host-before-import');
const secondDataDirectory = join(root, 'host-after-import');
await mkdir(projectRoot, { recursive: true });

async function reservePort() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function startHost(dataDirectory) {
  const port = await reservePort();
  const token = randomBytes(32).toString('hex');
  const process = spawn(globalThis.process.execPath, [resolve('packages/host/dist/server.js')], {
    cwd: resolve('.'),
    env: { ...globalThis.process.env, VAGUS_HOST_TOKEN: token, VAGUS_HOST_PORT: String(port), VAGUS_DATA_DIR: dataDirectory, VAGUS_MANAGED_HOST: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let diagnostics = '';
  process.stdout.on('data', chunk => output += chunk);
  process.stderr.on('data', chunk => diagnostics += chunk);
  const client = new HostClient(`ws://127.0.0.1:${port}/rpc`, { token });
  const waitUntil = async (condition, label, timeoutMs = 45_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) return;
      if (process.exitCode !== null) throw new Error(`Host exited (${process.exitCode}): ${diagnostics}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`${label}: ${diagnostics.slice(-2500)}`);
  };
  await waitUntil(() => output.includes('VAGUS_HOST_READY'), 'Host did not start');
  await client.connect();
  return { process, client, waitUntil, diagnostics: () => diagnostics };
}

async function stopHost(host) {
  if (!host) return;
  host.client.close();
  if (host.process.exitCode === null) {
    host.process.stdin.end('shutdown\n');
    await Promise.race([once(host.process, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (host.process.exitCode === null) { host.process.kill(); await once(host.process, 'exit'); }
  }
}

async function completeTurn(host, sessionId, prompt, label) {
  const events = [];
  host.client.onEvent(event => { if (event.sessionId === sessionId) events.push(event); });
  const subscribed = await host.client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);
  const sent = await host.client.request('sessions.send', { sessionId, text: prompt });
  if (sent.error) throw new Error(sent.error);
  try {
    await host.waitUntil(() => {
      const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
      return events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle'
        && events.some(event => event.type === 'message.completed' && assistantIds.has(event.messageId));
    }, `${label}: Claude did not complete its turn`, 90_000);
  } catch (error) {
    const diagnosticEvents = events.slice(-60).map(event => ({ type: event.type, role: event.role, state: event.state, code: event.code, message: event.type === 'message.delta' ? event.text?.slice(0, 240) : event.type === 'provider.error' ? event.message : undefined, tool: event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed' ? { id: event.toolCallId, name: event.name, input: event.input, output: event.output } : undefined }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(diagnosticEvents)}`);
  }
  const errors = events.filter(event => event.type === 'provider.error').map(event => event.message);
  if (errors.length) throw new Error(`${label}: ${errors.join('; ')}`);
  const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
  return events.filter(event => event.type === 'message.delta' && assistantIds.has(event.messageId)).map(event => event.text).join('');
}

let firstHost;
let secondHost;
let sourceId;
let importedSessionId;
let importCandidate;
let result;
let stage = 'starting first isolated Host';

try {
  firstHost = await startHost(firstDataDirectory);
  const catalog = await firstHost.client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await firstHost.client.request('projects.create', { name: 'Claude import resume smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const created = await firstHost.client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  const firstMarker = `vagus-import-seed-${randomBytes(6).toString('hex')}`;

  stage = 'creating a native Claude conversation to import';
  const firstReply = await completeTurn(firstHost, created.id, `Reply with exactly this marker and nothing else: ${firstMarker}`, 'seed turn');
  if (!firstReply.includes(firstMarker)) throw new Error('Claude did not return the import seed marker');
  const candidates = await firstHost.client.request('providers.sessions.importable', { providerId: 'claude' });
  if (candidates.error) throw new Error(candidates.error);
  importCandidate = candidates.find(candidate => candidate.workingDirectory === projectRoot && candidate.preview.includes(firstMarker));
  if (!importCandidate) throw new Error('The newly created Claude JSONL transcript was not discovered for import');
  sourceId = importCandidate.sourceId;
  await stopHost(firstHost);
  firstHost = undefined;

  stage = 'importing and resuming the native conversation in a fresh Host';
  secondHost = await startHost(secondDataDirectory);
  const beforeImport = await secondHost.client.request('providers.sessions.importable', { providerId: 'claude' });
  if (beforeImport.error) throw new Error(beforeImport.error);
  const candidate = beforeImport.find(item => item.sourceId === sourceId && item.workingDirectory === projectRoot);
  if (!candidate || candidate.alreadyImported) throw new Error('Fresh Host did not expose the unimported native Claude session');
  const imported = await secondHost.client.request('sessions.import', { providerId: 'claude', sourceId });
  if (imported.error) throw new Error(imported.error);
  importedSessionId = imported.id;
  const opened = await secondHost.client.request('sessions.open', { sessionId: importedSessionId, historyLimit: 50 });
  if (opened.error) throw new Error(opened.error);
  const importedMessages = opened.timeline.filter(entry => entry.kind === 'message');
  const importedSeedVisible = importedMessages.some(entry => entry.role === 'user' && entry.text.includes(firstMarker))
    && importedMessages.some(entry => entry.role === 'assistant' && entry.text.includes(firstMarker));
  if (!importedSeedVisible) throw new Error('Imported Vagus timeline did not retain both sides of the seed conversation');

  const followUpMarker = `vagus-import-followup-${randomBytes(6).toString('hex')}`;
  const resumedReply = await completeTurn(secondHost, importedSessionId, `Continue this imported conversation. Reply with exactly this marker and nothing else: ${followUpMarker}`, 'resume turn');
  if (!resumedReply.includes(followUpMarker)) throw new Error('The imported Claude session did not accept and answer a follow-up');
  const afterResume = await secondHost.client.request('sessions.open', { sessionId: importedSessionId, historyLimit: 50 });
  if (afterResume.error) throw new Error(afterResume.error);
  const finalMessages = afterResume.timeline.filter(entry => entry.kind === 'message');
  result = {
    importCandidateDiscovered: true,
    freshHostImportedIt: true,
    originalConversationRestored: importedSeedVisible,
    nativeSessionContinued: finalMessages.some(entry => entry.role === 'user' && entry.text.includes(followUpMarker))
      && finalMessages.some(entry => entry.role === 'assistant' && entry.text.includes(followUpMarker)),
    importedMessageCount: importedMessages.length,
    messageCountAfterFollowUp: finalMessages.length,
    providerErrors: [],
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.nativeSessionContinued) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ stage, error: error instanceof Error ? error.stack : String(error), firstHostDiagnostics: firstHost?.diagnostics().slice(-2000), secondHostDiagnostics: secondHost?.diagnostics().slice(-2000) }, null, 2));
  process.exitCode = 3;
} finally {
  await stopHost(secondHost);
  await stopHost(firstHost);
  if (sourceId) {
    try { await new ClaudeProvider().deleteSession({ sessionId: sourceId }); }
    catch (error) { console.error(`Could not remove the isolated native Claude smoke session: ${error instanceof Error ? error.message : String(error)}`); process.exitCode ||= 4; }
  }
  if (!root.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
