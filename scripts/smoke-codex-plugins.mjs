import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

const root = await mkdtemp(join(tmpdir(), "vagus-codex-plugin-e2e-"));
const codexHome = join(root, "codex-home");
const marketRoot = join(codexHome, "plugins", "marketplaces", "vagus-smoke-marketplace");
const pluginRoot = join(marketRoot, "plugins", "vagus-smoke-plugin");

try {
  await mkdir(join(marketRoot, ".agents", "plugins"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "smoke"), { recursive: true });
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({
    name: "vagus-smoke-plugin",
    version: "0.0.1",
    description: "Temporary isolated Vagus integration test",
  }, null, 2));
  await writeFile(join(pluginRoot, "skills", "smoke", "SKILL.md"), "---\nname: smoke\ndescription: Temporary isolated test skill.\n---\n\nThis skill is only for a local integration test.\n");
  await writeFile(join(marketRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "vagus-smoke-marketplace",
    interface: { displayName: "Vagus Smoke Test" },
    plugins: [{
      name: "vagus-smoke-plugin",
      source: { source: "local", path: "./plugins/vagus-smoke-plugin" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  }, null, 2));

  // Set before loading the provider and starting app-server: every Codex
  // profile read/write in this test is isolated under this temporary folder.
  process.env.CODEX_HOME = codexHome;
  const { CodexProvider } = await import("../packages/host/dist/agent/providers/codex/codex-provider.js");
  const provider = new CodexProvider();

  const added = await provider.managePluginMarketplace("add", { source: resolve(marketRoot), scope: "user" });
  const afterAdd = await provider.listPlugins();
  const candidate = afterAdd.available.find((plugin) => plugin.id.includes("vagus-smoke-plugin"));
  if (!candidate) throw new Error(`Plugin was not listed after marketplace add. ${JSON.stringify(added)}`);

  const installed = await provider.installPlugin(candidate.id, "user");
  const afterInstall = await provider.listPlugins();
  if (!afterInstall.installed.some((plugin) => plugin.id === candidate.id)) {
    throw new Error(`Plugin was not listed as installed after install: ${candidate.id}`);
  }

  const uninstalled = await provider.managePlugin(candidate.id, "uninstall", "user");
  const afterUninstall = await provider.listPlugins();
  if (afterUninstall.installed.some((plugin) => plugin.id === candidate.id)) {
    throw new Error(`Plugin remained installed after uninstall: ${candidate.id}`);
  }

  let localUpdateRejected = false;
  try {
    await provider.managePluginMarketplace("update", { name: "vagus-smoke-marketplace", scope: "user" });
  } catch (error) {
    localUpdateRejected = error instanceof Error && error.message.includes("本地来源");
  }
  if (!localUpdateRejected) throw new Error("Local marketplace update was not rejected with an actionable explanation.");

  const removed = await provider.managePluginMarketplace("remove", { name: "vagus-smoke-marketplace", scope: "user" });
  const afterRemove = await provider.listPlugins();
  if (afterRemove.marketplaces.some((marketplace) => marketplace.name === "vagus-smoke-marketplace")) {
    throw new Error("Marketplace remained after remove.");
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    isolatedCodexHome: true,
    added,
    candidateId: candidate.id,
    installed,
    uninstalled,
    localUpdateRejected,
    removed,
    finalInstalledCount: afterRemove.installed.length,
    finalMarketplaceNames: afterRemove.marketplaces.map((marketplace) => marketplace.name),
  }, null, 2)}\n`);
} finally {
  const tempRoot = resolve(tmpdir());
  const resolvedRoot = resolve(root);
  if (!resolvedRoot.startsWith(`${tempRoot}${sep}`) || !basename(resolvedRoot).startsWith("vagus-codex-plugin-e2e-")) {
    throw new Error(`Refusing to remove an unexpected test directory: ${resolvedRoot}`);
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}
