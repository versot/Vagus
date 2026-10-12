import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeMcpDetails, parseClaudeMcpList } from "../packages/host/dist/agent/providers/claude/mcp.js";

test('Claude MCP inventory parsing keeps only the sanitized server summary', () => {
  const output = [
    'filesystem: npx -y @modelcontextprotocol/server-filesystem D:\\work - Connected',
    'remote-api: https://example.invalid/mcp?token=secret - Disconnected',
    'websocket-svc (websocket) - Connecting',
  ].join('\n');
  const result = parseClaudeMcpList(output);
  assert.deepEqual(result, [
    { name: 'filesystem', scope: 'unknown', transport: 'stdio', status: 'connected' },
    { name: 'remote-api', scope: 'unknown', transport: 'http', status: 'disconnected' },
    { name: 'websocket-svc', scope: 'unknown', transport: 'websocket', status: 'pending' },
  ]);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('example.invalid'), false);
  assert.equal(JSON.stringify(result).includes('D:\\work'), false);
});

test('Claude MCP inventory parser ignores empty inventory hints and malformed output', () => {
  assert.deepEqual(parseClaudeMcpList('No MCP servers configured.\n\u001b[31m\u001b[0m'), []);
});

test('Claude MCP inventory preserves native approval, authentication and disabled states', () => {
  assert.deepEqual(parseClaudeMcpList([
    'needs-approval: npx server - ⏸ Pending approval (run claude to approve)',
    'private-api: https://private.invalid/mcp - ! Needs authentication',
    'off-here: npx server - ⊘ Disabled for this project',
    'bad-config: https://private.invalid - ✘ Failed to connect: secret=do-not-return',
    'cached-api: https://private.invalid/mcp - cached 2h ago · 5 tools',
    'placeholder: not configured',
  ].join('\n')), [
    { name: 'needs-approval', scope: 'unknown', transport: 'stdio', status: 'pending' },
    { name: 'private-api', scope: 'unknown', transport: 'http', status: 'needs-authentication' },
    { name: 'off-here', scope: 'unknown', transport: 'stdio', status: 'disabled' },
    { name: 'bad-config', scope: 'unknown', transport: 'http', status: 'error' },
    { name: 'cached-api', scope: 'unknown', transport: 'http', status: 'cached' },
    { name: 'placeholder', scope: 'unknown', transport: 'unknown', status: 'not-configured' },
  ]);
});

test('Claude MCP detail parsing extracts only safe scope, transport and status metadata', () => {
  const detail = parseClaudeMcpDetails('server', [
    'server:',
    '  Status: Needs authentication',
    '  Type: streamable-http',
    '  Scope: local (D:\\private\\project)',
    '  Command: secret-command --token supersecret',
    '  Environment: TOKEN=supersecret',
    '  URL: https://private.invalid/?token=supersecret',
  ].join('\n'));
  assert.deepEqual(detail, { name: 'server', scope: 'local', transport: 'http', status: 'needs-authentication' });
  assert.equal(JSON.stringify(detail).includes('supersecret'), false);
  assert.equal(JSON.stringify(detail).includes('private.invalid'), false);
  assert.equal(JSON.stringify(detail).includes('private\\project'), false);
});
