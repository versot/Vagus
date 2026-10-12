import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

// This live check intentionally reads the user's existing Claude Code inventory
// only. It never changes plugins, marketplaces, or MCP configuration. Only counts
// and status totals are written to stdout.
const root = await mkdtemp(join(tmpdir(), 'vagus-claude-inventory-'));
let host;
let client;
let diagnostics = '';
let output = '';

async function reservePort() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function waitUntil(condition, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    if (host.exitCode !== null) throw new Error(`Host exited (${host.exitCode}): ${diagnostics}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${label}: ${diagnostics.slice(-2000)}`);
}

try {
  const port = await reservePort();
  const token = randomBytes(32).toString('hex');
  host = spawn(process.execPath, [resolve('packages/host/dist/server.js')], {
    cwd: resolve('.'),
    env: { ...process.env, VAGUS_HOST_TOKEN: token, VAGUS_HOST_PORT: String(port), VAGUS_DATA_DIR: join(root, 'vagus-data'), VAGUS_MANAGED_HOST: '1' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  host.stdout.on('data', chunk => { output += chunk; });
  host.stderr.on('data', chunk => { diagnostics += chunk; });
  client = new HostClient(`ws://127.0.0.1:${port}/rpc`, { token });
  await waitUntil(() => output.includes('VAGUS_HOST_READY'), 'Host did not start');
  await client.connect();

  const plugins = await client.request('providers.plugins', { providerId: 'claude' });
  const mcp = await client.request('providers.mcp', { providerId: 'claude' });
  if (plugins.providerId !== 'claude' || !Array.isArray(plugins.installed) || !Array.isArray(plugins.available) || !Array.isArray(plugins.marketplaces)) throw new Error('Plugin inventory response is malformed');
  if (mcp.providerId !== 'claude' || !Array.isArray(mcp.servers)) throw new Error('MCP inventory response is malformed');

  const detailScopes = [];
  for (const server of mcp.servers) {
    const detail = await client.request('providers.mcp.detail', { providerId: 'claude', serverName: server.name });
    if (detail.name !== server.name || !['local', 'project', 'user', 'managed', 'unknown'].includes(detail.scope)) throw new Error('MCP detail response contains invalid or missing safe metadata');
    detailScopes.push(detail.scope);
  }

  const rejectedMutations = [];
  for (const [type, payload] of [
    ['providers.mcp.manage', { providerId: 'claude', serverName: 'inventory-check', action: 'remove' }],
  ]) {
    let rejected = false;
    try { await client.request(type, payload); }
    catch (error) { rejected = error instanceof Error && /unknown command/iu.test(error.message); }
    if (!rejected) throw new Error(`Expected ${type} to be rejected as an unknown RPC`);
    rejectedMutations.push(type);
  }

  const countByStatus = Object.fromEntries(mcp.servers.reduce((counts, server) => counts.set(server.status, (counts.get(server.status) ?? 0) + 1), new Map()));
  console.log(JSON.stringify({
    inventoryIsReadOnly: true,
    installedPluginCount: plugins.installed.length,
    availablePluginCount: plugins.available.length,
    configuredMarketplaceCount: plugins.marketplaces.length,
    mcpServerCount: mcp.servers.length,
    mcpStatuses: countByStatus,
    mcpSafeDetailsRead: detailScopes.length,
    mcpMutationRpcsRejected: rejectedMutations.length,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.stack : String(error), diagnostics: diagnostics.slice(-2000) }, null, 2));
  process.exitCode = 3;
} finally {
  client?.close();
  if (host && host.exitCode === null) {
    host.stdin.end('shutdown\n');
    await Promise.race([once(host, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (host.exitCode === null) { host.kill(); await once(host, 'exit'); }
  }
  const safeRoot = resolve(tmpdir());
  if (!resolve(root).startsWith(`${safeRoot}${sep}`)) throw new Error(`Refusing cleanup outside temp: ${root}`);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
