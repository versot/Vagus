import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HostClient } from '../packages/client/dist/index.js';
import { ClaudeProvider } from "../packages/host/dist/agent/providers/claude/claude-provider.js";
import { PiProvider } from "../packages/host/dist/agent/providers/pi/pi-provider.js";

test('Claude Code native sessions map to Vagus messages, images and tool events', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vagus-claude-import-'));
  const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = directory;
  t.after(async () => {
    if (previousConfigDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory;
    await rm(directory, { recursive: true, force: true });
  });

  const sessionId = '12345678-1234-4234-8234-123456789abc';
  const projectDirectory = join(directory, 'projects', '-workspace-example');
  const workingDirectory = join(directory, 'workspace');
  const transcript = [
    { type: 'user', sessionId, cwd: workingDirectory, uuid: 'user-1', timestamp: '2026-10-10T01:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Review this image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] } },
    { type: 'assistant', sessionId, cwd: workingDirectory, uuid: 'assistant-1', timestamp: '2026-10-10T01:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'I will inspect it.' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'example.ts' } }] } },
    { type: 'user', sessionId, cwd: workingDirectory, uuid: 'tool-result-1', timestamp: '2026-10-10T01:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }] } },
    { type: 'assistant', sessionId, cwd: workingDirectory, uuid: 'assistant-2', timestamp: '2026-10-10T01:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The image shows a test fixture.' }, { type: 'thinking', thinking: 'private reasoning is omitted' }] } },
    { type: 'assistant', sessionId, cwd: workingDirectory, uuid: 'sidechain-1', isSidechain: true, timestamp: '2026-10-10T01:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Sidechain must not be imported.' }] } },
  ];
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(join(projectDirectory, `${sessionId}.jsonl`), transcript.map(record => JSON.stringify(record)).join('\n'));

  const provider = new ClaudeProvider();
  const candidates = await provider.listImportableSessions();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceId, sessionId);
  assert.equal(candidates[0].providerId, 'claude');
  assert.equal(candidates[0].workingDirectory, workingDirectory);
  assert.equal(candidates[0].messageCount, 3);
  assert.equal(candidates[0].preview, 'Review this image');

  const imported = await provider.importSession(sessionId);
  const messages = imported.timeline.filter(entry => entry.kind === 'message');
  const tools = imported.timeline.filter(entry => entry.kind === 'tool');
  assert.equal(messages.length, 3);
  assert.equal(messages[0].attachments.length, 1);
  assert.equal(messages[0].attachments[0].dataUrl, 'data:image/png;base64,aGVsbG8=');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'Read');
  assert.deepEqual(tools[0].input, { file_path: 'example.ts' });
  assert.equal(tools[0].state, 'done');
  assert.equal(tools[0].output, 'file contents');
  assert.equal(messages.some(message => message.text.includes('private reasoning') || message.text.includes('Sidechain')), false);
  assert.deepEqual(imported.storageReference, { sessionId });
  assert.equal(provider.isImportSourceImported(sessionId, [imported.storageReference]), true);
});

test('Claude Code reports a missing project directory before starting ACP', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vagus-claude-missing-cwd-'));
  const missingDirectory = join(directory, 'removed-workspace');
  await rm(directory, { recursive: true, force: true });
  const provider = new ClaudeProvider();
  await assert.rejects(
    provider.startSession({ sessionId: 'missing-cwd-session', workingDirectory: missingDirectory }, () => {}),
    error => error instanceof Error && error.message.includes('Claude Code 工作目录不存在或无法访问') && error.message.includes(missingDirectory),
  );
});

test('Pi reports a missing project directory before spawning cmd.exe', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vagus-pi-missing-cwd-'));
  const missingDirectory = join(directory, 'removed-workspace');
  await rm(directory, { recursive: true, force: true });
  const emitted = [];
  await assert.rejects(
    new PiProvider().startSession({ sessionId: 'missing-pi-cwd-session', workingDirectory: missingDirectory }, event => emitted.push(event)),
    error => error instanceof Error && error.message.includes('Pi 工作目录不存在或无法访问') && error.message.includes(missingDirectory),
  );
  assert.deepEqual(emitted, [], 'do not mark the session as starting when its project directory is missing');
});

test('Host exposes Claude imports, assigns the workspace, and hides duplicates', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vagus-claude-host-import-'));
  const configDirectory = join(directory, 'claude-config');
  const sessionId = '87654321-4321-4321-8321-cba987654321';
  const workingDirectory = join(directory, 'workspace');
  const sessionDirectory = join(configDirectory, 'projects', '-workspace-e2e');
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, `${sessionId}.jsonl`), [
    { type: 'user', sessionId, cwd: workingDirectory, uuid: 'user-e2e', timestamp: '2026-10-10T01:00:00.000Z', message: { role: 'user', content: 'Import through Host' } },
    { type: 'assistant', sessionId, cwd: workingDirectory, uuid: 'assistant-e2e', timestamp: '2026-10-10T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Imported.' }] } },
  ].map(record => JSON.stringify(record)).join('\n'));

  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const token = randomBytes(32).toString('hex');
  const host = spawn(process.execPath, [resolve('packages/host/dist/server.js')], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDirectory, VAGUS_HOST_TOKEN: token, VAGUS_HOST_PORT: String(port), VAGUS_DATA_DIR: join(directory, 'data'), VAGUS_MANAGED_HOST: '1' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  let diagnostics = '';
  host.stdout.on('data', chunk => output += chunk);
  host.stderr.on('data', chunk => diagnostics += chunk);
  const client = new HostClient(`ws://127.0.0.1:${port}/rpc`, { token });
  const waitUntil = async condition => {
    const deadline = Date.now() + 12000;
    while (!await condition()) {
      if (host.exitCode !== null) throw new Error(`Host exited: ${diagnostics}`);
      if (Date.now() > deadline) throw new Error(`Host fixture timed out: ${diagnostics}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  t.after(async () => {
    client.close();
    if (host.exitCode === null) {
      host.stdin.end('shutdown\n');
      await Promise.race([once(host, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
      if (host.exitCode === null) { host.kill(); await once(host, 'exit'); }
    }
    await rm(directory, { recursive: true, force: true });
  });

  await waitUntil(() => output.includes('VAGUS_HOST_READY'));
  await client.connect();
  const discovered = await client.request('providers.sessions.importable', { providerId: 'claude' });
  assert.equal(discovered.error, undefined, diagnostics);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].providerId, 'claude');
  assert.equal(discovered[0].alreadyImported, false);

  const imported = await client.request('sessions.import', { providerId: 'claude', sourceId: sessionId });
  assert.equal(imported.error, undefined, diagnostics);
  assert.equal(imported.providerId, 'claude');
  assert.equal(imported.providerStorageReference, undefined, 'native provider references stay Host-owned');
  const opened = await client.request('sessions.open', { sessionId: imported.id });
  assert.equal(opened.error, undefined, diagnostics);
  assert.deepEqual(opened.messages.map(message => message.text), ['Import through Host', 'Imported.']);
  await assert.rejects(
    client.request('sessions.send', { sessionId: imported.id, text: 'This should fail locally because the imported workspace was removed.' }),
    /Claude Code 工作目录不存在或无法访问/u,
  );
  const afterFailedSend = await client.request('workspace.snapshot', {});
  assert.equal(afterFailedSend.error, undefined, 'a stale Claude workspace must not terminate the Host');
  const workspace = await client.request('workspace.snapshot', {});
  assert.equal(workspace.projects.length, 1);
  assert.equal(workspace.projects[0].root, workingDirectory);
  for (const providerId of ['pi', 'claude']) {
    const provider = workspace.providers.find(item => item.id === providerId);
    assert.ok(provider?.capabilities.some(capability => capability.id === 'session.import' && capability.status === 'implemented'), `${providerId} is exposed as importable to the shared UI`);
  }

  const rescanned = await client.request('providers.sessions.importable', { providerId: 'claude' });
  assert.equal(rescanned[0].alreadyImported, true);
  await assert.rejects(client.request('sessions.import', { providerId: 'claude', sourceId: sessionId }), /已经导入过/u);
  assert.equal(output.includes(token) || diagnostics.includes(token), false);
});
