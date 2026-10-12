import type { ProviderPluginCatalog } from "@vagus/protocol";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type JsonRecord } from "./types.js";
import { codexDate, isRecord } from "./utils.js";

export function readCodexMarketplaces(value: unknown): JsonRecord[] {
  return isRecord(value) && Array.isArray(value.marketplaces) ? value.marketplaces.filter(isRecord) : [];
}

export function codexMarketplacePluginRows(value: unknown): Array<{ marketplace: JsonRecord; plugin: JsonRecord }> {
  return readCodexMarketplaces(value).flatMap((marketplace) => Array.isArray(marketplace.plugins)
    ? marketplace.plugins.filter(isRecord).map((plugin) => ({ marketplace, plugin }))
    : []);
}

export function codexUserPluginRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const codexHome = environment.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return resolve(codexHome, "plugins", "marketplaces");
}

export function isWithinPath(root: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function isGitMarketplacePath(path: string | undefined, marketplaceRoot: string): boolean {
  if (!path || !isWithinPath(marketplaceRoot, path)) return false;
  let current = dirname(path);
  while (isWithinPath(marketplaceRoot, current)) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

export function mapCodexPluginCatalog(availableValue: unknown, installedValue: unknown, fetchedAt = new Date().toISOString(), environment: NodeJS.ProcessEnv = process.env): ProviderPluginCatalog {
  const userRoot = codexUserPluginRoot(environment);
  const installedRows = codexMarketplacePluginRows(installedValue).filter(({ plugin }) => plugin.installed === true);
  const installedIds = new Set(installedRows.flatMap(({ plugin }) => typeof plugin.id === "string" ? [plugin.id] : []));
  const installed = installedRows.flatMap(({ marketplace, plugin }) => {
    if (typeof plugin.id !== "string") return [];
    const source = isRecord(plugin.source) ? plugin.source : {};
    const isUserMarketplace = typeof marketplace.path === "string" && isWithinPath(userRoot, marketplace.path);
    const isUserOwned = isUserMarketplace || source.type === "remote" || source.type === "git" || source.type === "npm";
    const defaultManaged = plugin.installPolicy === "INSTALLED_BY_DEFAULT";
    const installedAt = typeof plugin.installedAt === "number" && Number.isFinite(plugin.installedAt) ? codexDate(plugin.installedAt, fetchedAt) : undefined;
    return [{
      id: plugin.id,
      ...(typeof plugin.version === "string" ? { version: plugin.version } : typeof plugin.localVersion === "string" ? { version: plugin.localVersion } : {}),
      scope: isUserOwned && !defaultManaged ? "user" : "local",
      enabled: plugin.enabled === true,
      ...(typeof source.path === "string" ? { installPath: source.path } : {}),
      ...(installedAt ? { installedAt } : {}),
      canToggle: false,
      canUninstall: isUserOwned && !defaultManaged,
    }];
  });
  const availableRows = codexMarketplacePluginRows(availableValue);
  const available = availableRows.flatMap(({ marketplace, plugin }) => {
    if (typeof plugin.id !== "string" || typeof plugin.name !== "string" || installedIds.has(plugin.id) || plugin.installPolicy === "NOT_AVAILABLE" || plugin.availability === "DISABLED_BY_ADMIN") return [];
    const marketplaceName = typeof marketplace.name === "string" ? marketplace.name : "marketplace";
    const description = isRecord(plugin.interface) ? plugin.interface.shortDescription : undefined;
    const source = isRecord(plugin.source) ? plugin.source : {};
    return [{ id: plugin.id, name: typeof plugin.interface === "object" && isRecord(plugin.interface) && typeof plugin.interface.displayName === "string" ? plugin.interface.displayName : plugin.name, ...(typeof description === "string" && description ? { description } : {}), marketplace: marketplaceName, source: source.type === "remote" ? `remote:${marketplaceName}` : marketplaceName }];
  });
  const marketplaceByName = new Map<string, JsonRecord>();
  for (const marketplace of readCodexMarketplaces(availableValue)) {
    if (typeof marketplace.name === "string") marketplaceByName.set(marketplace.name, marketplace);
  }
  for (const marketplace of readCodexMarketplaces(installedValue)) {
    if (typeof marketplace.name === "string") marketplaceByName.set(marketplace.name, marketplace);
  }
  const marketplaces = [...marketplaceByName.values()].flatMap((marketplace) => {
    if (typeof marketplace.name !== "string") return [];
    const path = typeof marketplace.path === "string" ? marketplace.path : undefined;
    // Keep Codex-bundled/runtime catalogs visible as sources, but expose destructive
    // management only for marketplace directories rooted in the user's CODEX_HOME.
    const canManage = Boolean(path && isWithinPath(userRoot, path));
    const canUpdate = Boolean(canManage && isGitMarketplacePath(path, userRoot));
    return [{ name: marketplace.name, ...(path ? { path, source: path } : {}), canManage, canUpdate }];
  });
  return { providerId: "codex", installed, available, marketplaces, fetchedAt };
}
