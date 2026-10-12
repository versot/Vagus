import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelClaudeSubagent, normalizeClaudeSubagentNotificationLine, readClaudeTerminalExit, readClaudeTerminalOutput } from "../packages/host/dist/agent/providers/claude/subagents.js";
import { zSessionNotification } from '../node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js';
import { methods } from '../node_modules/@agentclientprotocol/sdk/dist/acp.js';

const envelope = update => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'root-session', update } });

test('Claude ACP draft subagent spawn notifications normalize to validated ACP child-session updates', () => {
  const raw = JSON.stringify(envelope({
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: 'child-session',
    name: 'Read-only reviewer',
    task: 'Read README.md',
    capabilities: { cancel: true, close: true },
  }));

  const normalized = JSON.parse(normalizeClaudeSubagentNotificationLine(raw));
  assert.deepEqual(normalized.params.update, {
    sessionUpdate: 'subagent_update',
    sessionId: 'child-session',
    title: 'Read-only reviewer',
    description: 'Read README.md',
    capabilities: { cancel: {} },
    state: { state: 'running' },
  });
  assert.doesNotThrow(() => zSessionNotification.parse(normalized.params));
});

test('Claude ACP object-shaped subagent cancel capability is preserved as an explicit ACP capability', () => {
  const raw = JSON.stringify(envelope({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child-session', name: 'Agent', task: 'Inspect', capabilities: { cancel: {}, close: {} } }));
  const normalized = JSON.parse(normalizeClaudeSubagentNotificationLine(raw));
  assert.deepEqual(normalized.params.update.capabilities, { cancel: {} });
  assert.doesNotThrow(() => zSessionNotification.parse(normalized.params));
});

test('Claude ACP does not grant child cancellation when it was not advertised', () => {
  const raw = JSON.stringify(envelope({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child-session', name: 'Agent', task: 'Inspect' }));
  const normalized = JSON.parse(normalizeClaudeSubagentNotificationLine(raw));
  assert.equal('capabilities' in normalized.params.update, false);
  assert.doesNotThrow(() => zSessionNotification.parse(normalized.params));
});

test('Claude child cancellation sends ACP notification only for an explicitly authorized running child', async () => {
  const notifications = [];
  const connection = { agent: { notify: async (...args) => notifications.push(args) } };
  const children = new Map([
    ['allowed-child', { cancellable: true, state: 'running' }],
    ['denied-child', { cancellable: false, state: 'running' }],
    ['finished-child', { cancellable: true, state: 'completed' }],
  ]);
  await cancelClaudeSubagent(connection, children, 'allowed-child');
  assert.deepEqual(notifications, [[methods.agent.session.cancel, { sessionId: 'allowed-child' }]]);
  for (const childId of ['denied-child', 'finished-child', 'unknown-child']) {
    await assert.rejects(cancelClaudeSubagent(connection, children, childId));
  }
  assert.equal(notifications.length, 1);
});

test('Claude ACP draft subagent terminal notifications retain terminal state through ACP validation', () => {
  for (const state of ['completed', 'failed', 'cancelled', 'disconnected']) {
    const raw = JSON.stringify(envelope({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child-session', state }));
    const normalized = JSON.parse(normalizeClaudeSubagentNotificationLine(raw));
    assert.equal(normalized.params.update.sessionUpdate, 'subagent_update');
    assert.equal(normalized.params.update.state.state, state);
    assert.doesNotThrow(() => zSessionNotification.parse(normalized.params));
  }
});

test('Claude ACP notification normalization leaves unrelated protocol messages unchanged', () => {
  const raw = JSON.stringify(envelope({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }));
  assert.equal(normalizeClaudeSubagentNotificationLine(raw), raw);
});

test('Claude ACP terminal output extension distinguishes output chunks from snapshots', () => {
  assert.deepEqual(readClaudeTerminalOutput({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'bash-1',
    _meta: { terminal_output_delta: { terminal_id: 'bash-1', data: 'hello' } },
  }), { terminalId: 'bash-1', data: 'hello', delta: true });
  assert.deepEqual(readClaudeTerminalOutput({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'bash-1',
    _meta: { terminal_output: { terminal_id: 'bash-1', data: 'complete output' }, terminal_exit: { terminal_id: 'bash-1', exit_code: 0, signal: null } },
  }), { terminalId: 'bash-1', data: 'complete output', delta: false, exitCode: 0 });
  assert.equal(readClaudeTerminalOutput({ _meta: { terminal_output_delta: { terminal_id: 'bash-1', data: 42 } } }), undefined);
  assert.equal(readClaudeTerminalOutput({ _meta: { unrelated: { terminal_id: 'bash-1', data: 'ignored' } } }), undefined);
});

test('Claude ACP terminal exit status is retained when reported in a separate update', () => {
  assert.deepEqual(readClaudeTerminalExit({ _meta: { terminal_exit: { terminal_id: 'bash-1', exit_code: 0, signal: null } } }), { terminalId: 'bash-1', exitCode: 0 });
  assert.deepEqual(readClaudeTerminalExit({ _meta: { terminal_exit: { terminal_id: 'bash-1', exit_code: null, signal: null } } }), { terminalId: 'bash-1', exitCode: null });
  assert.equal(readClaudeTerminalExit({ _meta: { terminal_exit: { terminal_id: 'bash-1', exit_code: '0' } } }), undefined);
});
