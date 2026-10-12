import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeProvider } from "../packages/host/dist/agent/providers/claude/claude-provider.js";

const root = await mkdtemp(join(tmpdir(), 'vagus-claude-delete-live-'));
const projectRoot = join(root, 'workspace');
const configRoot = join(root, 'claude-config');
const projectStore = join(configRoot, 'projects', 'isolated-project');
const unrelatedProjectStore = join(configRoot, 'projects', 'unrelated-project');
const outsideStore = join(root, 'outside-projects');
const sessionId = randomUUID();
const sessionFile = join(projectStore, `${sessionId}.jsonl`);
const sameNameWrongSessionFile = join(unrelatedProjectStore, `${sessionId}.jsonl`);
const unrelatedFile = join(outsideStore, `${sessionId}.jsonl`);
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

try {
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
    mkdir(projectStore, { recursive: true }),
    mkdir(unrelatedProjectStore, { recursive: true }),
    mkdir(outsideStore, { recursive: true }),
  ]);
  await writeFile(sessionFile, `${JSON.stringify({ type: 'user', sessionId, cwd: projectRoot, message: { role: 'user', content: 'isolated deletion check' } })}\n`, 'utf8');
  await writeFile(sameNameWrongSessionFile, `${JSON.stringify({ type: 'user', sessionId: randomUUID(), cwd: projectRoot, message: { role: 'user', content: 'must remain untouched' } })}\n`, 'utf8');
  await writeFile(unrelatedFile, `${JSON.stringify({ type: 'user', sessionId, cwd: projectRoot, message: { role: 'user', content: 'must remain untouched' } })}\n`, 'utf8');
  process.env.CLAUDE_CONFIG_DIR = configRoot;

  await new ClaudeProvider().deleteSession({ sessionId });

  let sessionExists = true;
  try { await stat(sessionFile); } catch (error) { if (error.code === 'ENOENT') sessionExists = false; else throw error; }
  const mismatchedHeaderPreserved = (await readFile(sameNameWrongSessionFile, 'utf8')).includes('must remain untouched');
  const unrelatedContent = await readFile(unrelatedFile, 'utf8');
  const result = { matchedTranscriptDeleted: !sessionExists, mismatchedHeaderPreserved, unrelatedFilePreserved: unrelatedContent.includes('must remain untouched'), isolatedConfigDirectory: true };
  console.log(JSON.stringify(result, null, 2));
  if (sessionExists || !result.mismatchedHeaderPreserved || !result.unrelatedFilePreserved) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }, null, 2));
  process.exitCode = 3;
} finally {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  const tempRoot = resolve(tmpdir());
  if (!resolve(root).startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
