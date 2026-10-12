import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeProvider } from "../packages/host/dist/agent/providers/claude/claude-provider.js";

const tempRoot = resolve(tmpdir());
const root = await mkdtemp(join(tempRoot, 'vagus-claude-tool-input-live-'));
const skillDirectory = join(root, '.claude', 'skills', 'vagus-smoke-skill');
await mkdir(skillDirectory, { recursive: true });
await writeFile(join(skillDirectory, 'SKILL.md'), `---\nname: vagus-smoke-skill\ndescription: Use only when explicitly asked to invoke this smoke test skill.\n---\nReturn exactly SKILL_SMOKE_OK and do not call any additional tools.\n`, 'utf8');

const events = [];
const provider = new ClaudeProvider();
let session;

try {
  session = await provider.startSession({ sessionId: `claude-tool-input-live-${Date.now()}`, workingDirectory: root }, event => events.push(event));
  await session.sendText('Invoke the vagus-smoke-skill skill now. Do not inspect or change files and do not use any other tools.', [], 'immediate');
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !events.some(event => event.type === 'session.state' && event.state === 'running')) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!events.some(event => event.type === 'session.state' && event.state === 'running')) throw new Error('Claude Code did not enter running state for the smoke prompt');
  while (Date.now() < deadline && events.filter(event => event.type === 'session.state').at(-1)?.state !== 'idle') {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (events.filter(event => event.type === 'session.state').at(-1)?.state !== 'idle') throw new Error('Claude Code did not finish the smoke prompt within 90 seconds');

  const toolEvents = events.filter(event => event.type === 'tool.started' || event.type === 'tool.updated' || event.type === 'tool.completed');
  const tools = new Map();
  for (const event of toolEvents) {
    const item = tools.get(event.toolCallId) ?? { name: event.name, startInput: undefined, updateInputs: [] };
    if (event.type === 'tool.started') item.startInput = event.input;
    if (event.type === 'tool.updated' && event.input !== undefined) item.updateInputs.push(event.input);
    tools.set(event.toolCallId, item);
  }
  const summary = [...tools.values()].map(item => {
    const input = item.updateInputs.at(-1) ?? item.startInput;
    return { name: item.name, inputType: input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input, inputKeys: input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : [], inputEmpty: input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).length === 0 : input === undefined };
  });
  const providerErrors = events.filter(event => event.type === 'provider.error').map(event => ({ code: event.code, message: event.message }));
  console.log(JSON.stringify({ toolEvents: summary, providerErrors, states: events.filter(event => event.type === 'session.state').map(event => event.state) }, null, 2));
  if (providerErrors.length || !summary.some(item => item.name?.toLowerCase().includes('skill') && !item.inputEmpty)) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.stack : String(error), events: events.slice(-30) }, null, 2));
  process.exitCode = 3;
} finally {
  const reference = session?.storageReference;
  await session?.dispose().catch(() => undefined);
  if (reference) await provider.deleteSession(reference).catch(() => undefined);
  if (!root.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true });
}
