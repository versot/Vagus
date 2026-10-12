import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ClaudeProvider } from "../packages/host/dist/agent/providers/claude/claude-provider.js";

const executable = 'isolated-fake-claude-cli';

async function withFakeClaude(run) {
  const previous = process.env.CLAUDE_CODE_EXECUTABLE;
  process.env.CLAUDE_CODE_EXECUTABLE = executable;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE;
    else process.env.CLAUDE_CODE_EXECUTABLE = previous;
  }
}

test('Claude plugin install returns a verified command for explicit user confirmation', async () => {
  await withFakeClaude(async () => {
    const command = 'npm install trusted-plugin';
    const commandSha256 = createHash('sha256').update(command).digest('hex');
    const calls = [];
    const provider = new ClaudeProvider(async (file, args) => {
      calls.push({ file, args });
      return { stdout: JSON.stringify({ shownCommand: { command, sha256: commandSha256 } }), stderr: '' };
    });

    const result = await provider.installPlugin('reviewer@official', 'user');
    assert.deepEqual(result, { providerId: 'claude', pluginId: 'reviewer@official', status: 'confirmation-required', command, commandSha256 });
    assert.deepEqual(calls, [{ file: executable, args: ['plugin', 'install', 'reviewer@official', '--scope', 'user', '--json'] }]);
  });
});

test('Claude plugin install rejects a marketplace command whose digest does not match', async () => {
  await withFakeClaude(async () => {
    const provider = new ClaudeProvider(async () => ({
      stdout: JSON.stringify({ shownCommand: { command: 'unsafe command', sha256: '0'.repeat(64) } }),
      stderr: '',
    }));
    await assert.rejects(provider.installPlugin('reviewer@official'), /摘要不匹配/u);
  });
});

test('Claude plugin lifecycle and marketplace mutations invoke the expected CLI actions', async () => {
  await withFakeClaude(async () => {
    const calls = [];
    const provider = new ClaudeProvider(async (file, args) => {
      calls.push({ file, args });
      return { stdout: '', stderr: '' };
    });

    for (const action of ['enable', 'disable', 'uninstall']) {
      const result = await provider.managePlugin('reviewer@official', action, 'user');
      assert.equal(result.completed, true);
    }
    for (const [action, options] of [
      ['add', { source: 'https://example.invalid/marketplace.git', scope: 'user' }],
      ['update', { name: 'official' }],
      ['update', {}],
      ['remove', { name: 'official', scope: 'user' }],
    ]) {
      const result = await provider.managePluginMarketplace(action, options);
      assert.equal(result.completed, true);
    }

    assert.deepEqual(calls, [
      { file: executable, args: ['plugin', 'enable', 'reviewer@official', '--scope', 'user', '--json'] },
      { file: executable, args: ['plugin', 'disable', 'reviewer@official', '--scope', 'user', '--json'] },
      { file: executable, args: ['plugin', 'uninstall', 'reviewer@official', '--scope', 'user', '--json'] },
      { file: executable, args: ['plugin', 'marketplace', 'add', 'https://example.invalid/marketplace.git', '--scope', 'user'] },
      { file: executable, args: ['plugin', 'marketplace', 'update', 'official'] },
      { file: executable, args: ['plugin', 'marketplace', 'update'] },
      { file: executable, args: ['plugin', 'marketplace', 'remove', 'official', '--scope', 'user'] },
    ]);
  });
});

test('Claude plugin mutation rejects malformed identifiers and marketplace sources before invoking a CLI', async () => {
  await withFakeClaude(async () => {
    let calls = 0;
    const provider = new ClaudeProvider(async () => { calls++; return { stdout: '', stderr: '' }; });
    await assert.rejects(provider.installPlugin('bad plugin'), /标识无效/u);
    await assert.rejects(provider.managePlugin('../plugin', 'uninstall'), /标识无效/u);
    await assert.rejects(provider.managePluginMarketplace('add', { source: '--help' }), /有效的插件 marketplace 来源/u);
    await assert.rejects(provider.managePluginMarketplace('remove', { name: '../market' }), /名称无效/u);
    assert.equal(calls, 0);
  });
});
