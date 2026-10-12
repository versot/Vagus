import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeProvider } from "../packages/host/dist/agent/providers/claude/claude-provider.js";

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-mcp-command-'));
const events = [];
const provider = new ClaudeProvider();
let session;

try {
  session = await provider.startSession({ sessionId: `claude-mcp-command-${randomUUID()}`, workingDirectory: root }, event => {
    events.push(event);
    if (event.type === 'interaction.requested') {
      // The probe is read-only: dismiss any MCP menu/auth prompt rather than
      // accepting a change to the user's MCP configuration.
      void session.respond({ interactionId: event.interactionId, value: null }).catch(() => undefined);
    }
  });
  const commandDeadline = Date.now() + 15_000;
  while (Date.now() < commandDeadline && !(await session.getCommands?.() ?? []).some(command => command.name === 'mcp')) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const commandPublished = (await session.getCommands?.() ?? []).some(command => command.name === 'mcp');
  if (!commandPublished) throw new Error('Claude ACP did not publish /mcp');

  await session.sendText('/mcp', [], 'immediate');
  const deadline = Date.now() + 30_000;
  const assistantCompleted = () => {
    const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
    return events.some(event => event.type === 'message.completed' && assistantIds.has(event.messageId));
  };
  const idle = () => events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle';
  while (Date.now() < deadline && (!idle() || !assistantCompleted())) await new Promise(resolve => setTimeout(resolve, 100));
  if (!idle()) await session.cancel().catch(() => undefined);
  const interactionKinds = events.filter(event => event.type === 'interaction.requested').map(event => event.interaction.kind);
  const assistantIds = new Set(events.filter(event => event.type === 'message.started' && event.role === 'assistant').map(event => event.messageId));
  const assistantText = events.filter(event => event.type === 'message.delta' && assistantIds.has(event.messageId)).map(event => event.text).join('');
  const result = {
    commandPublished,
    interactionKinds,
    assistantCompleted: assistantCompleted(),
    responseCharacters: assistantText.length,
    responseWasPlainTextOnly: !events.some(event => event.type === 'interaction.requested' || event.type.startsWith('tool.')),
    finalState: events.filter(event => event.type === 'session.state').at(-1)?.state,
    providerErrors: events.filter(event => event.type === 'provider.error').map(event => ({ code: event.code, message: event.message })),
    // Event names indicate whether the CLI surfaced a Vagus-renderable flow;
    // omit command output so local MCP server names/configuration stay private.
    eventTypes: [...new Set(events.map(event => event.type))],
  };
  console.log(JSON.stringify(result, null, 2));
  if (!idle() || result.providerErrors.length) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error), eventTypes: [...new Set(events.map(event => event.type))] }, null, 2));
  process.exitCode = 3;
} finally {
  const reference = session?.storageReference;
  await session?.dispose().catch(() => undefined);
  if (reference) await provider.deleteSession(reference).catch(() => undefined);
  if (!root.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
