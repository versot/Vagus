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
const root = await mkdtemp(join(tempRoot, 'vagus-claude-ask-user-question-'));
const projectRoot = join(root, 'workspace');
const dataDirectory = join(root, 'vagus-data');
await mkdir(projectRoot, { recursive: true });
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const token = randomBytes(32).toString('hex');
const hostProcess = spawn(globalThis.process.execPath, [resolve('packages/host/dist/server.js')], {
  cwd: resolve('.'),
  env: { ...globalThis.process.env, VAGUS_HOST_TOKEN: token, VAGUS_HOST_PORT: String(port), VAGUS_DATA_DIR: dataDirectory, VAGUS_MANAGED_HOST: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let output = '';
let diagnostics = '';
hostProcess.stdout.on('data', chunk => output += chunk);
hostProcess.stderr.on('data', chunk => diagnostics += chunk);
const client = new HostClient(`ws://127.0.0.1:${port}/rpc`, { token });
const events = [];
let sessionId;
let sourceId;
let stage = 'starting Host';

async function waitUntil(condition, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (hostProcess.exitCode !== null) throw new Error(`Host exited (${hostProcess.exitCode}): ${diagnostics}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${label}: ${diagnostics.slice(-2500)}`);
}

try {
  await waitUntil(() => output.includes('VAGUS_HOST_READY'), 'Host did not start');
  await client.connect();
  const catalog = await client.request('providers.models.refresh', { providerId: 'claude' });
  if (catalog.error) throw new Error(catalog.error);
  const project = await client.request('projects.create', { name: 'Claude AskUserQuestion smoke', root: projectRoot, roots: [projectRoot] });
  if (project.error) throw new Error(project.error);
  const created = await client.request('sessions.create', { projectId: project.id, providerId: 'claude' });
  if (created.error) throw new Error(created.error);
  sessionId = created.id;
  let responseError;
  let formResponse;
  client.onEvent(event => {
    if (event.sessionId !== sessionId) return;
    events.push(event);
    if (event.type !== 'interaction.requested' || event.interaction.kind !== 'form') return;
    const values = Object.fromEntries(event.interaction.fields.flatMap(field => {
      if (field.id.startsWith('question_') && !field.id.endsWith('_custom') && field.type === 'choice') {
        const preferred = field.options?.find(option => /blue|蓝/iu.test(option.value));
        return preferred ? [[field.id, preferred.value]] : [];
      }
      if (field.id.endsWith('_custom') && field.type === 'text') return [[field.id, 'keep the menu theme consistent']];
      return [];
    }));
    formResponse = values;
    void client.request('interactions.respond', { sessionId, interactionId: event.interactionId, value: JSON.stringify(values) })
      .then(result => { if (result.error) responseError = result.error; })
      .catch(error => { responseError = error instanceof Error ? error.message : String(error); });
  });
  const subscribed = await client.request('sessions.subscribe', { sessionId });
  if (subscribed.error) throw new Error(subscribed.error);

  stage = 'asking Claude Code to invoke its native AskUserQuestion tool';
  const sent = await client.request('sessions.send', { sessionId, text: 'Use the built-in AskUserQuestion tool exactly once. Ask one single-choice question with the question text "Which color should the menu use?" and the options "Blue" and "Green". Wait for my answer, then tell me which choice I made and any note I added. Do not call other tools.' });
  if (sent.error) throw new Error(sent.error);
  await waitUntil(() => events.some(event => event.type === 'interaction.requested' && event.interaction.kind === 'form')
    && events.some(event => event.type === 'tool.completed'), 'Claude did not complete the AskUserQuestion form round trip', 90_000);
  await waitUntil(() => events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle', 'Claude did not return to idle', 20_000);
  const formEvent = events.find(event => event.type === 'interaction.requested' && event.interaction.kind === 'form');
  const fields = formEvent?.interaction.kind === 'form' ? formEvent.interaction.fields : [];
  const userQuestion = fields.find(field => field.id === 'question_0');
  const customField = fields.find(field => field.id === 'question_0_custom');
  const opened = await client.request('sessions.open', { sessionId, historyLimit: 30 });
  if (opened.error) throw new Error(opened.error);
  const assistantText = opened.timeline.filter(entry => entry.kind === 'message' && entry.role === 'assistant').map(entry => entry.text).join('\n');
  const errors = events.filter(event => event.type === 'provider.error').map(event => event.message);
  const result = {
    formArrivedInVagus: Boolean(formEvent),
    questionRenderedAsChoice: userQuestion?.type === 'choice' && userQuestion.options?.some(option => option.value === 'Blue') === true,
    customAnswerFieldRendered: customField?.type === 'text',
    submittedAnswer: formResponse,
    answerReturnedToClaude: assistantText.includes('Blue') && assistantText.includes('keep the menu theme consistent'),
    interactionResponseError: responseError ?? null,
    providerErrors: errors,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.formArrivedInVagus || !result.questionRenderedAsChoice || !result.customAnswerFieldRendered || !result.answerReturnedToClaude || responseError || errors.length) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ stage, error: error instanceof Error ? error.stack : String(error), hostDiagnostics: diagnostics.slice(-2500), recentEvents: events.slice(-25).map(event => event.type === 'interaction.requested' ? { type: event.type, kind: event.interaction.kind, title: event.interaction.title } : { type: event.type, state: event.state, code: event.code, name: event.name, message: event.message }) }, null, 2));
  process.exitCode = 3;
} finally {
  if (hostProcess.exitCode === null) {
    hostProcess.stdin.end('shutdown\n');
    await Promise.race([once(hostProcess, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (hostProcess.exitCode === null) { hostProcess.kill(); await once(hostProcess, 'exit'); }
  }
  client.close();
  if (sessionId) {
    try {
      const candidates = await new ClaudeProvider().listImportableSessions();
      const candidate = candidates.find(item => item.workingDirectory === projectRoot);
      if (candidate) { sourceId = candidate.sourceId; await new ClaudeProvider().deleteSession({ sessionId: sourceId }); }
    } catch (error) { console.error(`Could not remove the isolated AskUserQuestion smoke session: ${error instanceof Error ? error.message : String(error)}`); process.exitCode ||= 4; }
  }
  if (!root.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
