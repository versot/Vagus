import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AcpProvider } from '../packages/host/dist/agent/providers/acp/acp-provider.js';

test('a missing ACP executable rejects discovery without crashing the Host', { timeout: 6000 }, async () => {
  const provider = new AcpProvider({ id: 'missing-agent', displayName: 'Missing Agent', command: join(tmpdir(), `vagus-missing-agent-${randomUUID()}`), args: [], modelSource: 'test' });
  await assert.rejects(provider.listModels(), /找不到本机 Missing Agent/);
});

test('an ACP process exiting during initialization rejects promptly and contains pipe errors', { timeout: 6000 }, async () => {
  const provider = new AcpProvider({ id: 'early-exit', displayName: 'Early Exit Agent', command: process.execPath, args: ['-e', 'process.exit(1)'], modelSource: 'test' });
  const started = Date.now();
  await assert.rejects(provider.listModels(), error => error instanceof Error && !error.message.includes('初始化超时'));
  assert.ok(Date.now() - started < 4000, 'an exited Agent must not leave initialization waiting for its 20 second timeout');
});
