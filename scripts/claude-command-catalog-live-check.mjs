import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeProvider } from "../packages/host/dist/agent/providers/claude/claude-provider.js";

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-command-catalog-'));
const provider = new ClaudeProvider();
let session;

try {
  const events = [];
  session = await provider.startSession({ sessionId: `claude-command-catalog-${randomUUID()}`, workingDirectory: root }, event => events.push(event));
  const deadline = Date.now() + 15_000;
  let commands = [];
  while (Date.now() < deadline && !commands.length) {
    commands = await session.getCommands?.() ?? [];
    if (!commands.length) await new Promise(resolve => setTimeout(resolve, 50));
  }
  const result = {
    commandCount: commands.length,
    commands: commands.map(({ name, source, inputHint, action }) => ({ name, source, inputHint: inputHint ?? null, action: action ?? null })),
    compactPublished: commands.some(command => command.name === 'compact'),
    compactActionMapped: commands.find(command => command.name === 'compact')?.action === 'compact',
    irrelevantCommandsFiltered: ['model', 'effort', 'rename', 'new', 'clear', 'resume', 'branch', 'fork', 'color', 'focus', 'heapdump', 'theme', 'tui', 'terminal-setup', '__remote-workflow', 'workflow-launch-exec'].every(name => !commands.some(command => command.name.toLowerCase() === name)),
    providerErrors: events.filter(event => event.type === 'provider.error').map(event => ({ code: event.code, message: event.message })),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!commands.length || !result.irrelevantCommandsFiltered || result.providerErrors.length) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }, null, 2));
  process.exitCode = 3;
} finally {
  const reference = session?.storageReference;
  await session?.dispose().catch(() => undefined);
  if (reference) await provider.deleteSession(reference).catch(error => console.error('Native session cleanup:', error instanceof Error ? error.message : String(error)));
  if (!resolve(root).startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true });
}
