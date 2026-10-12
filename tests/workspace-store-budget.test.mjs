import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../packages/host/dist/storage/workspace-store.js';

test('workspace store bounds its pending worker queue', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vagus-store-budget-'));
  const store = new WorkspaceStore(directory);
  try {
    const pending = Array.from({ length: 128 }, () => store.request('performance'));
    await assert.rejects(store.request('performance'), /历史存储请求队列已满/);
    await Promise.all(pending);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
