import assert from 'node:assert/strict';
import test from 'node:test';
import { codexAppServerArgs } from "../packages/host/dist/agent/providers/codex/runtime.js";
import { codexCommands } from "../packages/host/dist/agent/providers/codex/commands.js";
import { mapCodexFileChangeDiffs, mapCodexMcpToolProgressMessage, mapCodexMcpToolResult, mapCodexThreadTokenUsage, mapCodexTurnDiff, mapCodexTurnPlan } from "../packages/host/dist/agent/providers/codex/events.js";

test('uses MXC for Windows Codex app-server tools without changing other platforms', () => {
  assert.deepEqual(codexAppServerArgs('win32'), [
    '-c', 'windows.sandbox=mxc', 'app-server', '--listen', 'stdio://',
  ]);
  assert.deepEqual(codexAppServerArgs('linux'), [
    'app-server', '--listen', 'stdio://',
  ]);
});

test('offers the Codex operations Vagus dispatches without native command discovery', () => {
  assert.deepEqual(codexCommands().map(({ name, source, action }) => ({ name, source, action })), [
    { name: 'goal', source: 'builtin', action: 'goal' },
    { name: 'review', source: 'builtin', action: 'review' },
    { name: 'mcp', source: 'builtin', action: 'mcp-status' },
    { name: 'fast', source: 'builtin', action: 'fast-mode' },
    { name: 'feedback', source: 'builtin', action: 'feedback' },
    { name: 'compact', source: 'builtin', action: 'compact' },
  ]);
});

test('maps Codex cumulative tokens and latest request context usage', () => {
  assert.deepEqual(mapCodexThreadTokenUsage({
    total: { totalTokens: 140, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 5 },
    last: { totalTokens: 52, inputTokens: 40, cachedInputTokens: 8, cacheWriteInputTokens: 0, outputTokens: 12, reasoningOutputTokens: 2 },
    modelContextWindow: 128000,
  }), {
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 40,
    contextWindowUsedTokens: 52,
    contextWindowMaxTokens: 128000,
  });
});

test('does not invent usage fields or accept invalid token values', () => {
  assert.deepEqual(mapCodexThreadTokenUsage({
    total: { inputTokens: -1, cachedInputTokens: 'unknown', outputTokens: 2 },
    last: { totalTokens: Number.NaN },
    modelContextWindow: null,
  }), { outputTokens: 2 });
  assert.equal(mapCodexThreadTokenUsage(null), null);
  assert.equal(mapCodexThreadTokenUsage({ total: {}, last: {} }), null);
});

test('preserves non-empty Codex MCP progress messages', () => {
  assert.equal(mapCodexMcpToolProgressMessage({ message: 'Fetching records' }), 'Fetching records');
  assert.equal(mapCodexMcpToolProgressMessage({ message: '  ' }), null);
  assert.equal(mapCodexMcpToolProgressMessage({}), null);
});

test('maps Codex MCP text and structured results to Vagus tool content without exposing metadata', () => {
  assert.deepEqual(mapCodexMcpToolResult({
    content: [{ type: 'text', text: 'Found two matching records.' }],
    structuredContent: { count: 2, records: ['one', 'two'] },
    _meta: { internal: 'must not be shown' },
  }), {
    content: [
      { type: 'content', content: { type: 'text', text: 'Found two matching records.' } },
      { type: 'content', content: { type: 'text', text: '{\n  "count": 2,\n  "records": [\n    "one",\n    "two"\n  ]\n}' } },
    ],
  });
  assert.deepEqual(mapCodexMcpToolResult({ content: [] }), {});
});

test('maps Codex MCP resource and error results safely', () => {
  assert.deepEqual(mapCodexMcpToolResult({ content: [
    { type: 'resource', resource: { uri: 'file:///private/result.txt', text: 'resource text' } },
    { type: 'image', mimeType: 'image/png', data: 'large-base64-payload' },
  ] }, { message: 'MCP request failed' }), {
    content: [
      { type: 'content', content: { type: 'text', text: '资源：file:///private/result.txt\nresource text' } },
      { type: 'content', content: { type: 'text', text: 'MCP 返回了图片（image/png）；当前工具结果卡片仅展示文本内容。' } },
    ],
    output: 'MCP request failed',
  });
  assert.deepEqual(mapCodexMcpToolResult({
    isError: true,
    content: [{ type: 'text', text: 'The requested record was not found.' }],
  }), {
    content: [{ type: 'content', content: { type: 'text', text: 'The requested record was not found.' } }],
    isError: true,
  });
});

test('bounds oversized Codex MCP text results', () => {
  const result = mapCodexMcpToolResult({ content: [{ type: 'text', text: 'x'.repeat(200_100) }] });
  const text = result.content?.[0]?.content?.text;
  assert.equal(text.startsWith('x'.repeat(200_000)), true);
  assert.equal(text.endsWith('[结果过长，已截断]'), true);
  assert.equal(text.length < 200_100, true);
});

test('maps stable Codex plan updates and bounds untrusted plan payloads', () => {
  assert.deepEqual(mapCodexTurnPlan({
    explanation: 'Implement and verify the change',
    plan: [
      { step: 'Inspect the implementation', status: 'completed' },
      { step: 'Add the mapping', status: 'inProgress' },
      { step: 'Run verification', status: 'pending' },
      { step: '', status: 'pending' },
      { step: 'Ignore unknown statuses safely', status: 'unexpected' },
    ],
  }), {
    explanation: 'Implement and verify the change',
    steps: [
      { step: 'Inspect the implementation', status: 'completed' },
      { step: 'Add the mapping', status: 'inProgress' },
      { step: 'Run verification', status: 'pending' },
      { step: 'Ignore unknown statuses safely', status: 'pending' },
    ],
  });
  assert.equal(mapCodexTurnPlan({ plan: [] }), null);
  assert.equal(mapCodexTurnPlan({ plan: 'invalid' }), null);
});

test('preserves Codex turn diffs and bounds oversized payloads', () => {
  assert.deepEqual(mapCodexTurnDiff('diff --git a/a.txt b/a.txt\n+new'), { diff: 'diff --git a/a.txt b/a.txt\n+new', truncated: false });
  assert.deepEqual(mapCodexTurnDiff(''), { diff: '', truncated: false });
  assert.equal(mapCodexTurnDiff(null), null);
  const oversized = mapCodexTurnDiff('x'.repeat(500_010));
  assert.equal(oversized?.diff.length, 500_000);
  assert.equal(oversized?.truncated, true);
});

test('maps Codex create and update patches to Vagus highlighted file diffs', () => {
  assert.deepEqual(mapCodexFileChangeDiffs([
    { path: 'src/new.ts', kind: { type: 'add' }, diff: 'export const ready = true;\n' },
    { path: 'src/value.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n' },
  ]), {
    input: { path: 'src/new.ts', changes: [{ path: 'src/new.ts', kind: 'add' }, { path: 'src/value.ts', kind: 'update' }] },
    content: [
      { type: 'diff', path: 'src/new.ts', newText: 'export const ready = true;' },
      { type: 'diff', path: 'src/value.ts', oldText: 'const value = 1;', newText: 'const value = 2;' },
    ],
  });
});

test('keeps unrecognized Codex binary or patch formats on the raw-data fallback', () => {
  assert.equal(mapCodexFileChangeDiffs([
    { path: 'assets/image.bin', kind: { type: 'update', move_path: null }, diff: 'Binary files differ' },
  ]), null);
});
