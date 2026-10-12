import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { ClaudeAcpSession } from "../packages/host/dist/agent/providers/claude/claude-session.js";
import { applyToolStarted } from '../packages/app/src/features/conversation/conversation-events.ts';
import { toolDiffBlocks } from '../packages/app/src/features/conversation/conversation-presentation.ts';

const projectionBundle = await build({ entryPoints: ['packages/app/src/features/conversation/conversation-projection.ts'], bundle: true, write: false, format: 'esm', platform: 'node', banner: { js: 'const window = {};' }, logLevel: 'silent' });
const { ConversationProjection } = await import(`data:text/javascript;base64,${Buffer.from(projectionBundle.outputFiles[0].text).toString('base64')}`);

test('Claude restore does not publish replayed text, tools, thinking, plans or compaction as live work', () => {
  const events = [];
  const session = new ClaudeAcpSession({ sessionId: 'vagus-session', resumeReference: { sessionId: 'native-session' } }, event => events.push(event));
  const updates = [
    { sessionUpdate: 'agent_message_chunk', messageId: 'old-message', content: { type: 'text', text: 'Old final answer' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Old thought' } },
    { sessionUpdate: 'tool_call', toolCallId: 'old-tool', name: 'Edit', title: 'Edit', status: 'completed', rawInput: { file_path: 'a.txt', old_string: 'old', new_string: 'new' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'old-tool', status: 'completed', rawOutput: 'done' },
    { sessionUpdate: 'subagent_update', sessionId: 'old-child', title: 'Old task', state: { state: 'completed' } },
    { sessionUpdate: 'plan', entries: [{ content: 'Old plan', status: 'completed' }] },
    { sessionUpdate: 'compaction_update', compactionId: 'old-compaction', status: 'in_progress' },
  ];
  for (const update of updates) session.onUpdate({ sessionId: 'native-session', update });
  assert.deepEqual(events, []);
  assert.equal(session.currentMessageId, null);
  assert.equal(session.toolStates.size, 0);
  assert.equal(session.subagents.size, 0);
  session.onUpdate({ sessionId: 'native-session', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact' }] } });
  session.onUpdate({ sessionId: 'native-session', update: { sessionUpdate: 'usage_update', used: 100, size: 1000 } });
  assert.deepEqual(events.map(event => event.type), ['session.commands.updated', 'session.usage.updated']);
});

test('Claude accepts live messages and tools after the first resumed prompt', async () => {
  const events = [];
  const session = new ClaudeAcpSession({ sessionId: 'vagus-session', resumeReference: { sessionId: 'native-session' } }, event => events.push(event));
  session.connection = { agent: { request: async () => {
    session.onUpdate({ sessionId: 'native-session', update: { sessionUpdate: 'tool_call', toolCallId: 'new-tool', name: 'Read', title: 'Read', status: 'completed', rawInput: { file_path: 'a.txt' }, rawOutput: 'content' } });
    session.onUpdate({ sessionId: 'native-session', update: { sessionUpdate: 'agent_message_chunk', messageId: 'new-message', content: { type: 'text', text: 'New final answer' } } });
    return { stopReason: 'end_turn' };
  } } };
  await session.sendText('New prompt');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.some(event => event.type === 'tool.started' && event.toolCallId === 'new-tool'));
  assert.ok(events.some(event => event.type === 'tool.completed' && event.toolCallId === 'new-tool'));
  assert.ok(events.some(event => event.type === 'message.delta' && event.text === 'New final answer'));
  assert.ok(events.some(event => event.type === 'message.completed' && event.messageId === 'new-message'));
  assert.equal(events.find(event => event.type === 'message.started' && event.role === 'assistant').replay, undefined);
  assert.equal(events.at(-1).type, 'session.queue.updated');
});

test('duplicate tool starts preserve original turn, position, completion and diff for every provider', () => {
  for (const provider of ['pi', 'claude', 'codex', 'opencode', 'qoder']) {
    const historicalTool = { id: `${provider}-edit`, name: 'Edit', state: 'done', order: 2, turnId: 'old-turn', input: { path: 'a.txt' }, content: [{ type: 'diff', path: 'a.txt', oldText: 'old', newText: 'new' }] };
    const current = [historicalTool];
    const replay = { type: 'tool.started', sessionId: 'session', toolCallId: historicalTool.id, name: 'Edit', input: {}, content: [] };
    assert.equal(applyToolStarted(current, replay, 100), current);
    assert.equal(applyToolStarted(current, { ...replay, turnId: 'new-turn' }, 101), current);
    assert.deepEqual(toolDiffBlocks(current[0]), [{ path: 'a.txt', oldText: 'old', newText: 'new' }]);
    const fresh = applyToolStarted(current, { ...replay, toolCallId: 'new-tool', turnId: 'new-turn' }, 102);
    assert.equal(fresh.length, 2);
    assert.equal(fresh[1].turnId, 'new-turn');
    assert.equal(fresh[1].state, 'running');
  }
});

test('resend and optimistic preview keep old tools inside their fold and old final answers intact', () => {
  const occurredAt = '2026-10-11T12:00:00.000Z';
  const messages = [
    { id: 'old-user', role: 'user', text: 'Edit', complete: true, order: 1, turnId: 'old-turn', occurredAt },
    { id: 'old-final', role: 'assistant', text: 'Done', complete: true, order: 3, turnId: 'old-turn', occurredAt, completedAt: occurredAt },
  ];
  const oldTool = { id: 'old-tool', name: 'Edit', state: 'done', order: 2, turnId: 'old-turn' };
  const activities = applyToolStarted([oldTool], { type: 'tool.started', sessionId: 'session', toolCallId: 'old-tool', name: 'Edit' }, 100);
  const input = { messages, displayMessages: messages, activities, statuses: [], interactions: [], notices: [], busy: false };
  const projection = new ConversationProjection();
  projection.update(input);
  const pending = { id: 'pending-user', role: 'user', text: 'Edit again', complete: false, order: 101, occurredAt };
  const entries = projection.update({ ...input, displayMessages: [...messages, pending], busy: true });
  const previousTurn = projection.getDurations().find(turn => turn.turnId === 'old-turn');
  assert.equal(previousTurn.active, false);
  assert.equal(previousTurn.finalAssistantMessageId, 'old-final');
  assert.ok(entries.findIndex(entry => entry.kind === 'tool') < entries.findIndex(entry => entry.kind === 'message' && entry.value.id === 'pending-user'));
  assert.equal(entries.find(entry => entry.kind === 'tool').value.turnId, 'old-turn');
});
