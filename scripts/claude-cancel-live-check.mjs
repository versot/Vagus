import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeProvider } from "../packages/host/dist/agent/providers/claude/claude-provider.js";

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-cancel-live-'));
const events = [];
const provider = new ClaudeProvider();
let session;

try {
  session = await provider.startSession({ sessionId: `claude-cancel-live-${Date.now()}`, workingDirectory: root }, event => events.push(event));
  await session.sendText('Do not use tools. Write a very long Chinese technical essay with at least 80 numbered sections, each section at least 100 words. Continue until stopped.', [], 'immediate');
  const runningDeadline = Date.now() + 15_000;
  while (Date.now() < runningDeadline && !events.some(event => event.type === 'session.state' && event.state === 'running')) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!events.some(event => event.type === 'session.state' && event.state === 'running')) throw new Error('Claude Code did not enter running state in time');

  await session.cancel();
  const cancelDeadline = Date.now() + 20_000;
  const isIdle = () => events.filter(event => event.type === 'session.state').at(-1)?.state === 'idle';
  while (Date.now() < cancelDeadline && !isIdle()) await new Promise(resolve => setTimeout(resolve, 50));

  const errors = events.filter(event => event.type === 'provider.error');
  const notifications = events.filter(event => event.type === 'notification').map(event => event.message);
  const states = events.filter(event => event.type === 'session.state').map(event => event.state);
  console.log(JSON.stringify({ states, notifications, providerErrors: errors }, null, 2));
  if (errors.length || !isIdle() || !notifications.some(message => message.includes('已停止当前任务'))) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.stack : String(error), events: events.slice(-30) }, null, 2));
  process.exitCode = 3;
} finally {
  const reference = session?.storageReference;
  await session?.dispose().catch(() => undefined);
  if (reference) await provider.deleteSession(reference).catch(error => console.error('Native session cleanup:', error instanceof Error ? error.message : String(error)));
  if (!root.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true });
}
