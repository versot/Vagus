import type { RpcRequest as Request } from "@vagus/protocol";
import { type AgentEvent, type ProviderModelCatalog } from "@vagus/protocol";
import type { WebSocket } from "ws";
import type { HostContext } from "../runtime/host-context.js";

export interface ProviderRequestHandlerContract {
  handleProviderRequest(client: WebSocket, request: Request): Promise<boolean>;
}

type ProviderRequestHandlerDependencies = Pick<HostContext, "broadcast" | "database" | "persistProviderSettings" | "providerEnabled" | "providerExtensionReads" | "providerMcpReads" | "providerModelCatalogs" | "providerPackageInstalls" | "providerPluginMutations" | "providerPluginReads" | "providers" | "publicProviders" | "publishProviderModelCatalog" | "refreshProviderModels" | "respond">;

export function createProviderRequestHandler(ctx: ProviderRequestHandlerDependencies): ProviderRequestHandlerContract {
  async function handleProviderRequest(client: WebSocket, request: Request): Promise<boolean> {
    switch (request.type) {
      case "providers.set-enabled": {
        const providerId = String(request.payload.providerId ?? "");
        const enabled = request.payload.enabled;
        if (!ctx.providers.has(providerId)) throw new Error("找不到这个 Agent 提供方");
        if (typeof enabled !== "boolean") throw new Error("提供方启用状态无效");
        ctx.providerEnabled.set(providerId, enabled);
        await ctx.persistProviderSettings();
        const event: AgentEvent = { type: "provider.enabled.updated", providerId, enabled };
        ctx.broadcast(event);
        ctx.respond(client, request.id, ctx.publicProviders().find((provider) => provider.id === providerId));
        return true;
      }
      case "providers.models": {
        const providerId = String(request.payload.providerId ?? "");
        const provider = ctx.providers.get(providerId);
        if (!provider) throw new Error("找不到这个 Agent 提供方");
        if (!provider.listModels) throw new Error("这个 Agent 暂不提供模型目录");
        if (!ctx.providerModelCatalogs.has(providerId)) {
          const loading: ProviderModelCatalog = {
            providerId,
            models: [],
            currentModelId: null,
            fetchedAt: "",
            status: "loading",
            stale: true,
          };
          ctx.publishProviderModelCatalog(loading);
          void ctx.refreshProviderModels(providerId).catch(() => undefined);
        }
        ctx.respond(client, request.id, ctx.providerModelCatalogs.get(providerId));
        return true;
      }
      case "providers.models.refresh": {
        const providerId = String(request.payload.providerId ?? "");
        ctx.respond(client, request.id, await ctx.refreshProviderModels(providerId));
        return true;
      }
      case "providers.extensions": {
        const providerId = String(request.payload.providerId ?? "");
        const provider = ctx.providers.get(providerId);
        if (!provider) throw new Error("找不到这个 Agent 提供方");
        if (!provider.listExtensions) throw new Error("这个 Agent 暂不提供扩展目录");
        const installing = ctx.providerPackageInstalls.get(providerId);
        if (installing) await installing.catch(() => undefined);
        let reading = ctx.providerExtensionReads.get(providerId);
        if (!reading) {
          reading = provider.listExtensions().finally(() => { ctx.providerExtensionReads.delete(providerId); });
          ctx.providerExtensionReads.set(providerId, reading);
        }
        ctx.respond(client, request.id, await reading);
        return true;
      }
      case "providers.plugins": {
        const providerId = String(request.payload.providerId ?? "");
        const provider = ctx.providers.get(providerId);
        if (!provider) throw new Error("找不到这个 Agent 提供方");
        if (!provider.listPlugins) throw new Error("这个 Agent 暂不提供插件目录");
        let reading = ctx.providerPluginReads.get(providerId);
        if (!reading) {
          reading = provider.listPlugins().finally(() => { ctx.providerPluginReads.delete(providerId); });
          ctx.providerPluginReads.set(providerId, reading);
        }
        ctx.respond(client, request.id, await reading);
        return true;
      }
      case "providers.plugins.install":
      case "providers.plugins.manage":
      case "providers.plugins.marketplace": {
        const providerId = String(request.payload.providerId ?? "");
        const provider = ctx.providers.get(providerId);
        if (!provider) throw new Error("找不到这个 Agent 提供方");
        if (ctx.providerPluginMutations.has(providerId)) throw new Error("Claude Code 插件目录正在更新，请稍后重试。");
        ctx.providerPluginMutations.add(providerId);
        try {
          if (request.type === "providers.plugins.install") {
            if (!provider.installPlugin) throw new Error("这个 Agent 暂不支持安装插件");
            const result = await provider.installPlugin(
              String(request.payload.pluginId ?? ""),
              (request.payload.scope as "user" | "project" | "local" | undefined) ?? "user",
              typeof request.payload.acceptCommandSha256 === "string" ? request.payload.acceptCommandSha256 : undefined,
            );
            ctx.providerPluginReads.delete(providerId);
            ctx.respond(client, request.id, result);
            return true;
          }
          if (request.type === "providers.plugins.manage") {
            if (!provider.managePlugin) throw new Error("这个 Agent 暂不支持管理插件");
            const result = await provider.managePlugin(
              String(request.payload.pluginId ?? ""),
              request.payload.action as "enable" | "disable" | "uninstall",
              request.payload.scope as "user" | "project" | "local" | undefined,
            );
            ctx.providerPluginReads.delete(providerId);
            ctx.respond(client, request.id, result);
            return true;
          }
          if (!provider.managePluginMarketplace) throw new Error("这个 Agent 暂不支持管理插件 marketplace");
          const result = await provider.managePluginMarketplace(
            request.payload.action as "add" | "update" | "remove",
            {
              ...(typeof request.payload.source === "string" ? { source: request.payload.source } : {}),
              ...(typeof request.payload.name === "string" ? { name: request.payload.name } : {}),
              ...(request.payload.scope === "user" || request.payload.scope === "project" || request.payload.scope === "local" ? { scope: request.payload.scope } : {}),
            },
          );
          ctx.providerPluginReads.delete(providerId);
          ctx.respond(client, request.id, result);
          return true;
        } finally {
          ctx.providerPluginMutations.delete(providerId);
        }
      }
      case "providers.mcp": {
        const providerId = String(request.payload.providerId ?? "");
        const provider = ctx.providers.get(providerId);
        if (!provider) throw new Error("找不到这个 Agent 提供方");
        if (!provider.listMcpServers) throw new Error("这个 Agent 暂不提供 MCP server 清单");
        let reading = ctx.providerMcpReads.get(providerId);
        if (!reading) {
          reading = provider.listMcpServers().finally(() => { ctx.providerMcpReads.delete(providerId); });
          ctx.providerMcpReads.set(providerId, reading);
        }
        ctx.respond(client, request.id, await reading);
        return true;
      }
      case "providers.mcp.detail": {
        const providerId = String(request.payload.providerId ?? "");
        const provider = ctx.providers.get(providerId);
        if (!provider) throw new Error("找不到这个 Agent 提供方");
        if (!provider.getMcpServer) throw new Error("这个 Agent 暂不提供 MCP 服务详情");
        if (typeof request.payload.serverName !== "string") throw new Error("Claude Code MCP 服务名称无效");
        ctx.respond(client, request.id, await provider.getMcpServer(request.payload.serverName));
        return true;
      }
      case "providers.packages.install": {
        const providerId = String(request.payload.providerId ?? "");
        const provider = ctx.providers.get(providerId);
        if (!provider) throw new Error("找不到这个 Agent 提供方");
        if (!provider.installPackage) throw new Error("这个 Agent 暂不支持安装包");
        if (typeof request.payload.source !== "string") throw new Error("请输入有效的 Pi 包来源。");
        if (ctx.providerPackageInstalls.has(providerId)) throw new Error("正在安装包，请等待完成后重试。");
        const source = request.payload.source;
        const install = (async () => {
          await ctx.providerExtensionReads.get(providerId)?.catch(() => undefined);
          return provider.installPackage!(source);
        })().finally(() => { ctx.providerPackageInstalls.delete(providerId); });
        ctx.providerPackageInstalls.set(providerId, install);
        ctx.respond(client, request.id, await install);
        return true;
      }
      case "providers.sessions.importable": {
        const providerId = String(request.payload.providerId ?? "");
        const provider = ctx.providers.get(providerId);
        if (!provider) throw new Error("找不到这个 Agent 提供方");
        if (!provider.listImportableSessions) throw new Error("这个 Agent 暂不支持导入本机会话");
        const candidates = await provider.listImportableSessions();
        const importedSessions = ctx.database.sessions.filter((session) => session.providerId === providerId);
        const importedIds = new Set(importedSessions.map((session) => session.providerImportSourceId).filter((id): id is string => Boolean(id)));
        const importedReferences = importedSessions.flatMap((session) => session.providerStorageReference ? [session.providerStorageReference] : []);
        ctx.respond(client, request.id, candidates.map((candidate) => ({ ...candidate, alreadyImported: importedIds.has(candidate.sourceId) || Boolean(provider.isImportSourceImported?.(candidate.sourceId, importedReferences)) })));
        return true;
      }
      default: return false;
    }
  }
  return { handleProviderRequest };
}
