import test from 'node:test';
import assert from 'node:assert/strict';
import { isClaudeConfigOptionApplied } from "../packages/host/dist/agent/providers/claude/settings.js";
import { normalizeClaudeCommands } from "../packages/host/dist/agent/providers/claude/commands.js";

test('Claude compact slash command uses the canonical context compaction action', () => {
  assert.deepEqual(normalizeClaudeCommands([
    { name: 'compact', description: 'Compact the conversation', input: { hint: '<instructions>' } },
    { name: 'context', description: 'Show context usage' },
  ]), [
    { name: 'compact', description: 'Compact the conversation', inputHint: '<instructions>', source: 'builtin', action: 'compact' },
    { name: 'context', description: 'Show context usage', source: 'other' },
  ]);
});

test('Claude command normalization drops nameless records, Vagus UI duplicates, and internal commands', () => {
  assert.deepEqual(normalizeClaudeCommands([
    { description: 'malformed' },
    { name: '', description: 'empty' },
    { name: 'model', input: { hint: '<model>' } },
    { name: 'effort', input: { hint: '<low|high>' } },
    { name: 'rename', input: { hint: '[name]' } },
    { name: 'new', description: 'Start a new session' },
    { name: 'clear', description: 'Clear and start a new session' },
    { name: 'resume', description: 'Resume a session' },
    { name: 'branch', description: 'Branch this session' },
    { name: 'fork', description: 'Branch this session' },
    { name: 'color', description: 'Change terminal prompt color' },
    { name: 'focus', description: 'Toggle terminal focus view' },
    { name: 'heapdump', description: 'Write a CLI memory dump' },
    { name: 'theme', description: 'Change terminal theme' },
    { name: 'tui', description: 'Change terminal renderer' },
    { name: 'terminal-setup', description: 'Configure terminal bindings' },
    { name: '__remote-workflow' },
    { name: 'workflow-launch-exec' },
    { name: 'agents', input: { hint: '[--all]' } },
  ]), [{ name: 'agents', inputHint: '[--all]', source: 'other' }]);
});

test('Claude config readback only succeeds when the requested select value was applied', () => {
  assert.equal(isClaudeConfigOptionApplied([{ id: 'model', type: 'select', currentValue: 'sonnet', options: [] }], 'model', 'sonnet'), true);
  assert.equal(isClaudeConfigOptionApplied([{ id: 'model', type: 'select', currentValue: 'haiku', options: [] }], 'model', 'sonnet'), false);
  assert.equal(isClaudeConfigOptionApplied([], 'model', 'sonnet'), false);
  assert.equal(isClaudeConfigOptionApplied([{ id: 'model', type: 'boolean', currentValue: true }], 'model', 'sonnet'), false);
});
