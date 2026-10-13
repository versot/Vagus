import { type AgentEvent, type ProviderModelCatalog } from "@vagus/protocol";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { HostContext } from "../runtime/host-context.js";

export interface ProviderCatalogServicesContract {
  loadProviderModelCache(): Promise<void>;
  loadProviderSettings(): Promise<void>;
  persistProviderSettings(): Promise<void>;
  providerHealth(providerId: string): "checking" | "healthy" | "unavailable";
  publicProviders(): import("@vagus/protocol").ProviderInfo[];
  persistProviderModelCache(): Promise<void>;
  publishProviderModelCatalog(catalog: ProviderModelCatalog): void;
  refreshProviderModels(providerId: string): Promise<ProviderModelCatalog>;
}

type ProviderCatalogServicesDependencies = Pick<
  HostContext,
  | "broadcast"
  | "providerEnabled"
  | "providerModelCatalogs"
  | "providerModelRefreshes"
  | "providerModelsFile"
  | "providerSettingsFile"
  | "providers"
>;

export function createProviderCatalogServices(
  ctx: ProviderCatalogServicesDependencies,
): ProviderCatalogServicesContract {
  async function loadProviderModelCache(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(ctx.providerModelsFile, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      for (const [providerId, value] of Object.entries(parsed)) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const catalog = value as Partial<ProviderModelCatalog>;
        if (
          catalog.providerId !== providerId ||
          !Array.isArray(catalog.models) ||
          typeof catalog.fetchedAt !== "string" ||
          !(catalog.currentModelId === null || typeof catalog.currentModelId === "string")
        )
          continue;
        ctx.providerModelCatalogs.set(providerId, {
          providerId,
          models: catalog.models
            .filter(
              (model) =>
                model &&
                typeof model.id === "string" &&
                typeof model.name === "string" &&
                typeof model.source === "string",
            )
            .map((model) => ({
              ...model,
              ...(Array.isArray(model.thinkingLevels)
                ? { thinkingLevels: model.thinkingLevels.filter((level) => typeof level === "string") }
                : {}),
            })),
          currentModelId: catalog.currentModelId,
          ...(typeof catalog.currentThinkingLevel === "string" || catalog.currentThinkingLevel === null
            ? { currentThinkingLevel: catalog.currentThinkingLevel }
            : {}),
          ...(typeof catalog.currentModeId === "string" || catalog.currentModeId === null
            ? { currentModeId: catalog.currentModeId }
            : {}),
          ...(Array.isArray(catalog.availableModes)
            ? {
                availableModes: catalog.availableModes
                  .filter((mode) => mode && typeof mode.id === "string" && typeof mode.name === "string")
                  .map((mode) => ({
                    id: mode.id,
                    name: mode.name,
                    ...(typeof mode.description === "string" ? { description: mode.description } : {}),
                  })),
              }
            : {}),
          ...(typeof catalog.executablePath === "string" ? { executablePath: catalog.executablePath } : {}),
          ...(typeof catalog.executableSource === "string" ? { executableSource: catalog.executableSource } : {}),
          fetchedAt: catalog.fetchedAt,
          status: "ready",
          stale: true,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        process.stderr.write(`Vagus provider cache read failed: ${String(error)}\n`);
    }
  }

  async function loadProviderSettings(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(ctx.providerSettingsFile, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      for (const [providerId, enabled] of Object.entries(parsed)) {
        if (ctx.providers.has(providerId) && typeof enabled === "boolean") ctx.providerEnabled.set(providerId, enabled);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        process.stderr.write(`Vagus provider settings read failed: ${String(error)}\n`);
    }
  }

  async function persistProviderSettings(): Promise<void> {
    const temporary = `${ctx.providerSettingsFile}.tmp`;
    await writeFile(temporary, JSON.stringify(Object.fromEntries(ctx.providerEnabled), null, 2), "utf8");
    await rename(temporary, ctx.providerSettingsFile);
  }

  function providerHealth(providerId: string): "checking" | "healthy" | "unavailable" {
    const catalog = ctx.providerModelCatalogs.get(providerId);
    if (!catalog || catalog.status === "loading") return "checking";
    if (catalog.status === "error" || catalog.error) return "unavailable";
    if (catalog.status === "ready" && !catalog.stale) return "healthy";
    return "checking";
  }

  function publicProviders() {
    return [...ctx.providers.values()].map((provider) => ({
      ...provider.descriptor,
      enabled: ctx.providerEnabled.get(provider.descriptor.id) !== false,
      health: providerHealth(provider.descriptor.id),
    }));
  }

  async function persistProviderModelCache(): Promise<void> {
    const temporary = `${ctx.providerModelsFile}.tmp`;
    await writeFile(temporary, JSON.stringify(Object.fromEntries(ctx.providerModelCatalogs), null, 2), "utf8");
    await rename(temporary, ctx.providerModelsFile);
  }

  function publishProviderModelCatalog(catalog: ProviderModelCatalog): void {
    ctx.providerModelCatalogs.set(catalog.providerId, catalog);
    const event: AgentEvent = { type: "provider.models.updated", catalog };
    ctx.broadcast(event);
  }

  function refreshProviderModels(providerId: string): Promise<ProviderModelCatalog> {
    const pending = ctx.providerModelRefreshes.get(providerId);
    if (pending) return pending;
    const refresh = (async () => {
      const provider = ctx.providers.get(providerId);
      if (!provider) throw new Error("找不到这个 Agent 提供方");
      if (!provider.listModels) throw new Error("这个 Agent 暂不提供模型目录");
      try {
        const catalog = await provider.listModels();
        publishProviderModelCatalog({ ...catalog, status: "ready", stale: false, error: undefined });
        await persistProviderModelCache().catch((error: unknown) => {
          process.stderr.write(`Vagus provider cache write failed: ${String(error)}\n`);
        });
        return ctx.providerModelCatalogs.get(providerId)!;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        const previous = ctx.providerModelCatalogs.get(providerId);
        const catalog: ProviderModelCatalog = previous
          ? { ...previous, status: "ready", stale: true, error: message }
          : {
              providerId,
              models: [],
              currentModelId: null,
              fetchedAt: "",
              status: "error",
              stale: true,
              error: message,
            };
        publishProviderModelCatalog(catalog);
        if (previous) await persistProviderModelCache().catch(() => undefined);
        throw reason;
      }
    })().finally(() => ctx.providerModelRefreshes.delete(providerId));
    ctx.providerModelRefreshes.set(providerId, refresh);
    return refresh;
  }
  return {
    loadProviderModelCache,
    loadProviderSettings,
    persistProviderSettings,
    providerHealth,
    publicProviders,
    persistProviderModelCache,
    publishProviderModelCatalog,
    refreshProviderModels,
  };
}
