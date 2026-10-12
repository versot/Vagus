import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeProvider } from "../packages/host/dist/agent/providers/claude/claude-provider.js";

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-autocompact-'));
const provider = new ClaudeProvider();
const events = [];
let session;

try {
  session = await provider.startSession({ sessionId: `claude-autocompact-${randomUUID()}`, workingDirectory: root }, event => events.push(event));
  const deadline = Date.now() + 15_000;
  let commands = [];
  while (Date.now() < deadline && !commands.length) {
    commands = await session.getCommands?.() ?? [];
    if (!commands.length) await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!commands.some(command => command.name === 'autocompact')) throw new Error('Claude ACP did not publish /autocompact');

  await session.sendText('/autocompact', [], 'immediate');
  const turnDeadline = Date.now() + 60_000;
  const isIdle = () => events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle';
  const hasAssistantResponse = () => {
    const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
    return events.some(event => event.type === 'message.completed' && assistantIds.has(event.messageId));
  };
  while (Date.now() < turnDeadline && (!isIdle() || !hasAssistantResponse())) await new Promise(resolve => setTimeout(resolve, 50));

  const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
  const response = events.filter(event => event.type === 'message.delta' && assistantIds.has(event.messageId)).map(event => event.text).join('');
  const providerErrors = events.filter(event => event.type === 'provider.error').map(event => event.message);
  const result = { commandPublished: true, sentCommand: '/autocompact', assistantCompleted: hasAssistantResponse(), finalState: events.filter(event => event.type === 'session.state').at(-1)?.state, response: response.slice(-1000), providerErrors };
  console.log(JSON.stringify(result, null, 2));
  if (!isIdle() || !hasAssistantResponse() || providerErrors.length) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.stack : String(error), recentEvents: events.slice(-20) }, null, 2));
  process.exitCode = 3;
} finally {
  const reference = session?.storageReference;
  await session?.dispose().catch(() => undefined);
  if (reference) await provider.deleteSession(reference).catch(error => console.error('Native session cleanup:', error instanceof Error ? error.message : String(error)));
  if (!root.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
