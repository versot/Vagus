import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolPresentation, hasToolContent, hasToolInput, toolContentText, toolDiffBlocks } from '../packages/app/src/features/conversation/conversation-presentation.ts';

test('ACP diff content becomes file activity with a path and both versions', () => {
  const activity = {
    id: 'tool-1', name: 'Edit', state: 'done', order: 1,
    content: [{ type: 'diff', path: 'src/main.ts', oldText: 'const value = 1;', newText: 'const value = 2;' }],
  };
  assert.deepEqual(toolDiffBlocks(activity), [{ path: 'src/main.ts', oldText: 'const value = 1;', newText: 'const value = 2;' }]);
  assert.deepEqual(buildToolPresentation(activity), { label: 'Edit', icon: 'edit', summary: 'src/main.ts' });
});

test('ACP file creation diff supports an absent old version and mixed text output', () => {
  const activity = {
    id: 'tool-2', name: 'Write', state: 'done', order: 2,
    content: [
      { type: 'diff', path: 'README.md', newText: '# Example' },
      { type: 'content', content: { type: 'text', text: 'Wrote README.md' } },
    ],
  };
  assert.deepEqual(toolDiffBlocks(activity), [{ path: 'README.md', newText: '# Example' }]);
  assert.deepEqual(toolContentText(activity), ['Wrote README.md']);
});

test('legacy structured output is still recognized, malformed diff blocks are ignored', () => {
  const activity = {
    id: 'tool-3', name: 'Edit', state: 'done', order: 3,
    output: [{ type: 'diff', path: 'src/a.ts', oldText: '', newText: 'export {};' }, { type: 'diff', path: 'bad.ts' }],
  };
  assert.deepEqual(toolDiffBlocks(activity), [{ path: 'src/a.ts', oldText: '', newText: 'export {};' }]);
});

test('a structured diff in tool output remains visible when initial tool content was empty', () => {
  const activity = {
    id: 'tool-output-diff', name: 'Write', state: 'done', order: 4,
    content: [],
    output: [{ type: 'diff', path: 'src/new.ts', newText: 'export const added = true;' }],
  };
  assert.deepEqual(toolDiffBlocks(activity), [{ path: 'src/new.ts', newText: 'export const added = true;' }]);
  assert.equal(buildToolPresentation(activity).summary, 'src/new.ts');
});

test('tool presentation combines terminal content and output diffs without duplicates', () => {
  const diff = { type: 'diff', path: 'src/new.ts', newText: 'export const added = true;' };
  const activity = {
    id: 'tool-merged-diff', name: 'Bash', state: 'done', order: 5,
    content: [{ type: 'terminal', terminalId: 'terminal-1' }],
    output: [diff, diff],
  };
  assert.deepEqual(toolDiffBlocks(activity), [{ path: diff.path, newText: diff.newText }]);
});

test('ACP tool kind keeps native operation semantics when its tool name is provider-specific', () => {
  const activity = { id: 'tool-4', name: 'mcp__workspace__custom_action', title: 'Inspect source file', toolKind: 'read', state: 'done', order: 4, input: { path: 'src/main.ts' } };
  assert.deepEqual(buildToolPresentation(activity), { label: 'Inspect source file', icon: 'read', summary: 'src/main.ts' });
});

test('an empty initial ACP input is not presented as the completed tool arguments', () => {
  assert.equal(hasToolInput({ id: 'tool-empty', name: 'Skill', state: 'running', order: 1, input: {} }), false);
  assert.equal(hasToolInput({ id: 'tool-ready', name: 'Skill', state: 'running', order: 2, input: { skill: 'review' } }), true);
  assert.equal(hasToolInput({ id: 'tool-array', name: 'custom', state: 'done', order: 3, input: [] }), true);
});

test('empty initial tool content is omitted when a later output delta contains the result', () => {
  assert.equal(hasToolContent(''), false);
  assert.equal(hasToolContent('  '), false);
  assert.equal(hasToolContent([]), false);
  assert.equal(hasToolContent({}), false);
  assert.equal(hasToolContent('VAGUS_CODEX_TOOL_CHECK'), true);
});
