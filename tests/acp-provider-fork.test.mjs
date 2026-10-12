import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpProvider } from "../packages/host/dist/agent/providers/acp/acp-provider.js";

// Exercise the real adapter over stdio. The bridge fixture reproduces ZCode's
// checkpoint-only default, non-standard result field and nested RPC error.
const bridge = `
  const readline = require('node:readline');
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return;
    let result = {};
    let error;
    if (method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, fork: {} } } };
    if (method === 'session/resume') result = { configOptions: [] };
    if (method === 'session/fork') {
      if (process.argv[1] === 'error') {
        error = { code: -32603, message: 'Internal error', data: { details: 'Native branch is unavailable' } };
      } else if (process.argv[1] === 'standard') {
        if (params.target) error = { code: -32602, message: 'Unexpected ZCode target' };
        else result = { sessionId: 'native-branch' };
      } else if (params.target?.kind !== 'message' || params.target.messageId !== 'native-final-answer') {
        error = { code: -32603, message: 'Internal error', data: { details: 'No workspace checkpoint is available yet.' } };
      } else result = { forkedSessionId: 'native-branch' };
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }));
  });
`;

async function openSession(providerId, behavior = 'zcode') {
  const provider = new AcpProvider({ id: providerId, displayName: providerId, command: process.execPath, args: ['-e', bridge, behavior], modelSource: providerId });
  return provider.startSession({ sessionId: 'vagus-source', workingDirectory: process.cwd(), resumeReference: { sessionId: 'native-source', cwd: process.cwd() } }, () => {});
}

test('ZCode forks a text-only conversation at its native final message and resumes the returned branch', async () => {
  const source = await openSession('zcode');
  try {
    const reference = await source.forkAfterAssistantMessage('Final answer', 0, 'native-final-answer');
    assert.equal(reference.sessionId, 'native-branch');
    assert.equal(reference.cwd, process.cwd());
    const provider = new AcpProvider({ id: 'zcode', displayName: 'ZCode', command: process.execPath, args: ['-e', bridge, 'zcode'], modelSource: 'zcode' });
    const branch = await provider.startSession({ sessionId: 'vagus-branch', workingDirectory: reference.cwd, resumeReference: reference }, () => {});
    try { assert.equal(branch.storageReference.sessionId, 'native-branch'); }
    finally { await branch.dispose(); }
  } finally { await source.dispose(); }
});

test('standard ACP agents receive the standard fork request and response', async () => {
  const source = await openSession('qoder', 'standard');
  try { assert.equal((await source.forkAfterAssistantMessage('Final answer', 0, 'vagus-answer')).sessionId, 'native-branch'); }
  finally { await source.dispose(); }
});

test('ACP branch errors retain the useful native error details', async () => {
  const source = await openSession('zcode', 'error');
  try { await assert.rejects(source.forkAfterAssistantMessage('Final answer', 0, 'native-final-answer'), /Native branch is unavailable/); }
  finally { await source.dispose(); }
});
