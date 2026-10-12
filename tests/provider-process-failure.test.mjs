import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRpcProcess } from '../packages/host/dist/agent/providers/pi/pi-rpc-process.js';
import { CodexAppServer } from '../packages/host/dist/agent/providers/codex/runtime.js';

test('missing Pi and Codex executables reject pending requests without unhandled pipe errors', { timeout: 6000 }, async () => {
  const command = join(tmpdir(), `vagus-missing-provider-${randomUUID()}`);
  const pi = new PiRpcProcess({ command, cwd: process.cwd() });
  try { await assert.rejects(pi.request('get_state')); }
  finally { await pi.close(); }
  const codex = new CodexAppServer(command, process.cwd());
  try { await assert.rejects(codex.start()); }
  finally { await codex.close(); }
});
