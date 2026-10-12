import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapCodexPluginCatalog } from "../packages/host/dist/agent/providers/codex/plugins.js";

test('Codex plugin catalog maps native marketplaces without exposing controls for runtime plugins', () => {
  const userMarketplacePath = 'C:\\Users\\tester\\.codex\\plugins\\marketplaces\\trusted\\marketplace.json';
  const available = {
    marketplaces: [{
      name: 'trusted', path: userMarketplacePath,
      plugins: [
        { id: 'installed@trusted', name: 'installed', installed: false, source: { type: 'remote' }, interface: { displayName: 'Installed Plugin', shortDescription: 'Already present' } },
        { id: 'new@trusted', name: 'new', installed: false, source: { type: 'remote' }, interface: { displayName: 'New Plugin', shortDescription: 'Ready to install' } },
      ],
    }],
  };
  const installed = {
    marketplaces: [
      { name: 'trusted', path: userMarketplacePath, plugins: [{ id: 'installed@trusted', name: 'installed', installed: true, enabled: true, installPolicy: 'AVAILABLE', version: '1.2.3', installedAt: 1791637474, source: { type: 'remote' } }] },
      { name: 'openai-bundled', path: 'C:\\Users\\tester\\.cache\\codex-runtimes\\plugins\\marketplace.json', plugins: [{ id: 'bundled@openai-bundled', name: 'bundled', installed: true, enabled: true, installPolicy: 'INSTALLED_BY_DEFAULT', source: { type: 'local', path: 'C:\\Users\\tester\\.cache\\codex-runtimes\\plugins\\bundled' } }] },
    ],
  };

  const catalog = mapCodexPluginCatalog(available, installed, '2026-10-10T12:00:00.000Z', { CODEX_HOME: 'C:\\Users\\tester\\.codex' });
  assert.equal(catalog.providerId, 'codex');
  assert.deepEqual(catalog.installed.map(plugin => plugin.id), ['installed@trusted', 'bundled@openai-bundled']);
  assert.equal(catalog.installed[0].canToggle, false);
  assert.equal(catalog.installed[0].canUninstall, true);
  assert.equal(catalog.installed[1].scope, 'local');
  assert.equal(catalog.installed[1].canUninstall, false);
  assert.deepEqual(catalog.available.map(plugin => plugin.id), ['new@trusted']);
  assert.equal(catalog.available[0].name, 'New Plugin');
  assert.equal(catalog.marketplaces.find(item => item.name === 'trusted').canManage, true);
  assert.equal(catalog.marketplaces.find(item => item.name === 'trusted').canUpdate, false);
  assert.equal(catalog.marketplaces.find(item => item.name === 'openai-bundled').canManage, false);
});

test('Codex plugin catalog refuses marketplace paths outside CODEX_HOME for destructive management', () => {
  const catalog = mapCodexPluginCatalog({ marketplaces: [] }, {
    marketplaces: [{ name: 'outside', path: 'C:\\shared\\marketplace.json', plugins: [] }],
  }, '2026-10-10T12:00:00.000Z', { CODEX_HOME: 'C:\\Users\\tester\\.codex' });
  assert.equal(catalog.marketplaces[0].canManage, false);
});

test('Codex plugins installed from a marketplace in CODEX_HOME remain user-manageable when sourced from local files', () => {
  const root = 'C:\\Users\\tester\\.codex\\plugins\\marketplaces\\local';
  const catalog = mapCodexPluginCatalog({ marketplaces: [] }, {
    marketplaces: [{ name: 'local', path: `${root}\\marketplace.json`, plugins: [{ id: 'local-tool@local', name: 'local-tool', installed: true, enabled: true, installPolicy: 'AVAILABLE', source: { type: 'local', path: `${root}\\plugins\\local-tool` } }] }],
  }, '2026-10-10T12:00:00.000Z', { CODEX_HOME: 'C:\\Users\\tester\\.codex' });
  assert.equal(catalog.installed[0].scope, 'user');
  assert.equal(catalog.installed[0].canUninstall, true);
  assert.equal(catalog.marketplaces[0].canManage, true);
  assert.equal(catalog.marketplaces[0].canUpdate, false);
});

test('Codex marketplace sources remain visible after their last plugin is uninstalled', () => {
  const marketplacePath = 'C:\\Users\\tester\\.codex\\plugins\\marketplaces\\local\\.agents\\plugins\\marketplace.json';
  const catalog = mapCodexPluginCatalog({ marketplaces: [{ name: 'local', path: marketplacePath, plugins: [{ id: 'local-tool@local', name: 'local-tool', installed: false }] }] }, { marketplaces: [] }, '2026-10-10T12:00:00.000Z', { CODEX_HOME: 'C:\\Users\\tester\\.codex' });
  assert.equal(catalog.marketplaces.length, 1);
  assert.equal(catalog.marketplaces[0].name, 'local');
  assert.equal(catalog.marketplaces[0].canManage, true);
});

test('Codex marketplace update is offered only for Git marketplace checkouts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vagus-codex-marketplace-'));
  try {
    const marketplaceRoot = join(root, 'plugins', 'marketplaces', 'remote');
    const gitRoot = join(marketplaceRoot, 'repo');
    const marketplacePath = join(gitRoot, '.agents', 'plugins', 'marketplace.json');
    await mkdir(join(gitRoot, '.git'), { recursive: true });
    const catalog = mapCodexPluginCatalog({ marketplaces: [{ name: 'remote', path: marketplacePath, plugins: [] }] }, { marketplaces: [] }, '2026-10-10T12:00:00.000Z', { CODEX_HOME: root });
    assert.equal(catalog.marketplaces[0].canManage, true);
    assert.equal(catalog.marketplaces[0].canUpdate, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
