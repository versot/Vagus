import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeProvider } from "../packages/host/dist/agent/providers/claude/claude-provider.js";

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-subagent-live-'));
const readme = join(root, 'README.md');
await writeFile(readme, 'Vagus ACP subagent normalization test marker.\nSecond line is irrelevant.\n', 'utf8');
const events = [];
const permissionNames = [];
const provider = new ClaudeProvider();
let session;

try {
  session = await provider.startSession({ sessionId: `claude-subagent-live-${Date.now()}`, workingDirectory: root }, event => {
    events.push(event);
    if (event.type !== 'interaction.requested' || event.interaction.kind !== 'choice') return;
    const title = event.interaction.title ?? '';
    const message = event.interaction.message ?? '';
    permissionNames.push({ title, message: message.slice(0, 200) });
    const permitted = title === 'Agent' || title === 'Task' || (title === 'Read' && message.includes(readme));
    const choice = event.interaction.options.find(option => /allow once|允许一次/iu.test(option));
    void session.respond({ interactionId: event.interactionId, value: permitted ? choice ?? false : false }).catch(() => undefined);
  });
  await session.sendText(`Use exactly one Agent or Task subagent to read only ${readme} and return its first line. Wait for the subagent to finish and hand back its result before you answer; do not tell me it is still running. Do not use MCP, Bash, web search, or any other tools. Do not create or modify files. Your final answer must be exactly the file's first line.`, [], 'immediate');

  const deadline = Date.now() + 150_000;
  let sawRunning = false;
  while (Date.now() < deadline) {
    if (events.some(event => event.type === 'session.state' && event.state === 'running')) sawRunning = true;
    const assistantMessageIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
    const assistantCompleted = events.some(event => event.type === 'message.completed' && assistantMessageIds.has(event.messageId));
    const sessionIsIdle = events.at(-1)?.type === 'session.state' && events.at(-1)?.state === 'idle';
    if (sawRunning && sessionIsIdle && assistantCompleted) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  const subagentStatuses = events.filter(event => event.type === 'ui.status' && String(event.text).includes('子代理')).map(event => event.text);
  const subagentCapabilities = events.filter(event => event.type === 'ui.status' && String(event.key).startsWith('claude-subagent:')).map(event => ({
    subagentSessionId: event.subagentSessionId,
    state: event.subagentState,
    cancellable: event.subagentCancellable,
    text: event.text,
  }));
  const tools = events.filter(event => event.type.startsWith('tool.')).map(event => ({
    type: event.type,
    name: event.name,
    parentToolCallId: event.parentToolCallId,
    toolCallId: event.toolCallId,
    isError: event.isError,
    input: event.input,
    output: event.output,
    outputDelta: event.outputDelta,
  }));
  const assistantMessageIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
  const assistantText = events.filter(event => event.type === 'message.delta' && assistantMessageIds.has(event.messageId)).map(event => event.text).join('');
  const assistantCompleted = events.some(event => event.type === 'message.completed' && assistantMessageIds.has(event.messageId));
  const finalState = events.filter(event => event.type === 'session.state').at(-1)?.state;
  const providerErrors = events.filter(event => event.type === 'provider.error');
  const gatewayModelRejected = providerErrors.some(event => event.code === 'claude_sdk_model_rejected');
  const eventSummary = events.map(event => ({
    type: event.type,
    role: event.role,
    state: event.state,
    name: event.name,
    title: event.title,
    parentToolCallId: event.parentToolCallId,
    toolCallId: event.toolCallId,
    text: typeof event.text === 'string' ? event.text.slice(0, 300) : undefined,
    key: event.key,
    subagentSessionId: event.subagentSessionId,
    subagentCancellable: event.subagentCancellable,
    subagentState: event.subagentState,
    output: typeof event.output === 'string' ? event.output.slice(0, 300) : undefined,
    code: event.code,
    message: event.message,
  }));
  console.log(JSON.stringify({ sawRunning, assistantCompleted, finalState, subagentStatuses, subagentCapabilities, tools, assistantText: assistantText.slice(-500), providerErrors, gatewayModelRejected, permissionNames, eventSummary }, null, 2));
  if (gatewayModelRejected) {
    // The local third-party gateway may reject SDK subagent model calls. This
    // live check passes only if Vagus reports the reason and recovers to idle.
    if (finalState !== 'idle') process.exitCode = 7;
  } else {
    if (!subagentStatuses.some(status => status.includes('已完成'))) process.exitCode = 2;
    if (!assistantText.includes('Vagus ACP subagent normalization test marker.')) process.exitCode = 6;
    if (providerErrors.length) process.exitCode = 3;
    if (!assistantCompleted || finalState !== 'idle') process.exitCode = 5;
  }
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.stack : String(error), permissionNames, events: events.slice(-30) }, null, 2));
  process.exitCode = 4;
} finally {
  const reference = session?.storageReference;
  await session?.dispose().catch(() => undefined);
  if (reference) await provider.deleteSession(reference).catch(error => console.error('Native session cleanup:', error instanceof Error ? error.message : String(error)));
  if (!root.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true });
}
