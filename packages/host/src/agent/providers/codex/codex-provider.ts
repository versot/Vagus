import type { AgentProvider, AgentSession, ImportedProviderSession, SessionStorageReference, StartSessionOptions } from "@vagus/agent-core";
import type { AgentEvent, ProviderImportCandidate, ProviderModelCatalog, ProviderModelInfo, ProviderPluginCatalog, ProviderPluginInstallResult, ProviderPluginMutationResult, ProviderPluginScope, SessionTimelineEntry } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { CodexSession } from "./codex-session.js";
import { CODEX_PERMISSION_MODES } from "./commands.js";
import { readCodexTimeline } from "./history.js";
import { codexMarketplacePluginRows, codexUserPluginRoot, isGitMarketplacePath, isWithinPath, mapCodexPluginCatalog, readCodexMarketplaces } from "./plugins.js";
import { CodexAppServer, resolveCodexExecutable } from "./runtime.js";
import { type JsonRecord } from "./types.js";
import { codexDate, isRecord, safeError } from "./utils.js";

export class CodexProvider implements AgentProvider {
  private importSources = new Map<string, ProviderImportCandidate>();

  readonly descriptor = {
    id: "codex",
    displayName: "Codex",
    capabilities: [
      { id: "session.local", status: "implemented" as const, note: "通过本机 Codex CLI app-server 启动与恢复会话；新会话默认仅在工作区内读写，支持切换 Codex 权限模式" },
      { id: "session.model-selection", status: "implemented" as const, note: "从本机 app-server 动态读取模型与思考程度，并通过线程设置立即应用" },
      { id: "message.attachments", status: "partial" as const, note: "支持本地图片输入；其他附件类型暂未映射" },
      { id: "session.queue", status: "implemented" as const, note: "支持 follow-up 队列与 Codex 原生 turn/steer；当前 Turn 不可转向时安全回退到队列" },
      { id: "session.context", status: "partial" as const, note: "支持 Codex 原生手动压缩；Codex 不接受自定义压缩指令，Vagus 会明确提示此限制" },
      { id: "session.import", status: "implemented" as const, note: "通过 Codex app-server 读取本机历史会话，并将消息、工具活动和可读取的图片导入 Vagus；原生会话保持不变" },
      { id: "session.fork", status: "implemented" as const, note: "通过 Codex app-server 原生 thread/fork 分支；分支点按 Codex Turn 粒度定位" },
      { id: "session.commands", status: "partial" as const, note: "手动映射 /goal、/review、/mcp、/fast、/feedback 与 /compact；Codex app-server 没有原生斜杠命令发现接口" },
      { id: "ui.extension", status: "partial" as const, note: "映射标准工具与审批事件；Codex 专有应用 UI 暂未适配" },
      { id: "interaction.dialog", status: "partial" as const, note: "命令、文件变更和权限审批映射到 Vagus 卡片；支持单题、多题表单及标准 MCP 询问，秘密输入和不支持的字段会被拒绝" },
      { id: "provider.plugins", status: "implemented" as const, note: "通过本机 Codex app-server 读取插件与 marketplace，并支持安装、卸载及 marketplace 管理；插件开关由 Codex 当前接口决定，Vagus 不虚构未公开的控制项" },
    ],
  };

  async listPlugins(): Promise<ProviderPluginCatalog> {
    const server = await this.openModelServer();
    try {
      const [available, installed] = await Promise.all([
        server.request<unknown>("plugin/list", { forceRefetch: false }),
        server.request<unknown>("plugin/installed", {}),
      ]);
      return mapCodexPluginCatalog(available, installed);
    } finally { await server.close(); }
  }

  async installPlugin(pluginId: string, scope: ProviderPluginScope): Promise<ProviderPluginInstallResult> {
    if (scope !== "user") throw new Error("Codex 插件目前只支持用户范围安装");
    const server = await this.openModelServer();
    try {
      const catalog = await server.request<unknown>("plugin/list", { forceRefetch: false });
      const match = codexMarketplacePluginRows(catalog).find(({ plugin }) => plugin.id === pluginId);
      if (!match || match.plugin.installed === true || typeof match.plugin.name !== "string") throw new Error("Codex 插件已不可用，请重新读取插件目录");
      if (match.plugin.installPolicy === "NOT_AVAILABLE" || match.plugin.availability === "DISABLED_BY_ADMIN") throw new Error("Codex 当前策略不允许安装这个插件");
      if (typeof match.marketplace.name !== "string") throw new Error("Codex 插件缺少 marketplace 来源信息");
      const params: JsonRecord = { pluginName: match.plugin.name, installAttemptId: randomUUID() };
      if (typeof match.marketplace.path === "string" && isAbsolute(match.marketplace.path)) params.marketplacePath = match.marketplace.path;
      else params.remoteMarketplaceName = match.marketplace.name;
      const result = await server.request<unknown>("plugin/install", params, 180_000);
      const appsNeedingAuth = isRecord(result) && Array.isArray(result.appsNeedingAuth)
        ? result.appsNeedingAuth.flatMap((app) => isRecord(app) && typeof app.name === "string" ? [app.name] : [])
        : [];
      return { providerId: "codex", pluginId, status: "installed", ...(appsNeedingAuth.length ? { appsNeedingAuth } : {}) };
    } finally { await server.close(); }
  }

  async managePlugin(pluginId: string, action: "enable" | "disable" | "uninstall", scope: ProviderPluginScope = "user"): Promise<ProviderPluginMutationResult> {
    if (scope !== "user") throw new Error("Codex 插件目前只允许管理用户范围插件");
    if (action !== "uninstall") throw new Error("本机 Codex app-server 未提供插件启用/禁用操作");
    const server = await this.openModelServer();
    try {
      const catalog = await server.request<unknown>("plugin/installed", {});
      const match = codexMarketplacePluginRows(catalog).find(({ plugin }) => plugin.id === pluginId && plugin.installed === true);
      const source = match && isRecord(match.plugin.source) ? match.plugin.source : null;
      const userMarketplace = match && typeof match.marketplace.path === "string" && isWithinPath(codexUserPluginRoot(), match.marketplace.path);
      const userOwned = Boolean(source && ["remote", "git", "npm"].includes(String(source.type))) || Boolean(userMarketplace);
      if (!match || !userOwned || match.plugin.installPolicy === "INSTALLED_BY_DEFAULT") {
        throw new Error("这个 Codex 插件由本机或组织配置管理，不能从 Vagus 卸载");
      }
      await server.request("plugin/uninstall", { pluginId }, 180_000);
      return { providerId: "codex", target: pluginId, action: "uninstall", completed: true };
    } finally { await server.close(); }
  }

  async managePluginMarketplace(action: "add" | "update" | "remove", options: { source?: string; name?: string; scope?: ProviderPluginScope }): Promise<ProviderPluginMutationResult> {
    if (options.scope !== undefined && options.scope !== "user") throw new Error("Codex marketplace 目前只支持用户范围管理");
    const server = await this.openModelServer();
    try {
      if (action === "add") {
        const source = options.source?.trim();
        if (!source || source.length > 2048) throw new Error("Codex marketplace 来源无效");
        const result = await server.request<unknown>("marketplace/add", { source }, 180_000);
        const name = isRecord(result) && typeof result.marketplaceName === "string" ? result.marketplaceName : source;
        return { providerId: "codex", target: name, action, completed: true };
      }
      const name = options.name?.trim();
      if (action === "remove") {
        if (!name) throw new Error("请指定要移除的 Codex marketplace");
        const [available, installed] = await Promise.all([
          server.request<unknown>("plugin/list", { forceRefetch: false }),
          server.request<unknown>("plugin/installed", {}),
        ]);
        const marketplace = [...readCodexMarketplaces(available), ...readCodexMarketplaces(installed)].find((item) => item.name === name);
        if (!marketplace || typeof marketplace.path !== "string" || !isWithinPath(codexUserPluginRoot(), marketplace.path)) {
          throw new Error("只能移除 CODEX_HOME 下由用户添加的 marketplace");
        }
        await server.request("marketplace/remove", { marketplaceName: name }, 180_000);
        return { providerId: "codex", target: name, action, completed: true };
      }
      if (name) {
        const [available, installed] = await Promise.all([
          server.request<unknown>("plugin/list", { forceRefetch: false }),
          server.request<unknown>("plugin/installed", {}),
        ]);
        const marketplace = [...readCodexMarketplaces(available), ...readCodexMarketplaces(installed)].find((item) => item.name === name);
        const path = marketplace && typeof marketplace.path === "string" ? marketplace.path : undefined;
        if (!isGitMarketplacePath(path, codexUserPluginRoot())) {
          throw new Error("这个 Codex marketplace 是本地来源，不能通过远程更新；请在来源目录中更新文件后重新读取");
        }
      }
      const params = name ? { marketplaceName: name } : {};
      const result = await server.request<unknown>("marketplace/upgrade", params, 240_000);
      if (isRecord(result) && Array.isArray(result.errors) && result.errors.length) {
        const failed = result.errors.flatMap((entry) => isRecord(entry) && typeof entry.marketplaceName === "string" ? [entry.marketplaceName] : []);
        throw new Error(failed.length ? `Codex marketplace 更新部分失败：${failed.join("、")}` : "Codex marketplace 更新未能全部完成");
      }
      return { providerId: "codex", target: name ?? "all", action, completed: true };
    } finally { await server.close(); }
  }

  async listModels(): Promise<ProviderModelCatalog> {
    const fetchedAt = new Date().toISOString();
    const server = await this.openModelServer();
    try {
      const response = await server.request<unknown>("model/list", { limit: 200, includeHidden: false });
      const rows = isRecord(response) && Array.isArray(response.data) ? response.data : [];
      const models: ProviderModelInfo[] = rows.flatMap((item) => {
        if (!isRecord(item) || item.hidden === true || typeof item.id !== "string") return [];
        const levels = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.flatMap((entry) => isRecord(entry) && typeof entry.reasoningEffort === "string" ? [entry.reasoningEffort] : []) : [];
        return [{ id: item.id, name: typeof item.displayName === "string" ? item.displayName : item.id, source: "codex", ...(levels.length ? { thinkingLevels: levels } : {}) }];
      });
      const selected = rows.find((item) => isRecord(item) && item.isDefault === true);
      if (!models.length) throw new Error("本机 Codex app-server 没有返回可用模型");
      return { providerId: "codex", models, currentModelId: isRecord(selected) && typeof selected.id === "string" ? selected.id : models[0]?.id ?? null, ...(isRecord(selected) && typeof selected.defaultReasoningEffort === "string" ? { currentThinkingLevel: selected.defaultReasoningEffort } : {}), currentModeId: ":danger-full-access", availableModes: CODEX_PERMISSION_MODES.map(({ id, name }) => ({ id, name })), fetchedAt, status: "ready", stale: false };
    } finally { await server.close(); }
  }

  async listImportableSessions(): Promise<ProviderImportCandidate[]> {
    const server = await this.openModelServer();
    const sources = new Map<string, ProviderImportCandidate>();
    try {
      let cursor: string | null = null;
      for (let page = 0; page < 50; page++) {
        const response: unknown = await server.request("thread/list", { limit: 100, sortDirection: "desc", useStateDbOnly: true, ...(cursor ? { cursor } : {}) });
        if (!isRecord(response) || !Array.isArray(response.data)) break;
        const threads = response.data.filter(isRecord);
        const candidates = threads.flatMap((thread) => {
          if (typeof thread.id !== "string" || thread.ephemeral === true || thread.parentThreadId) return [];
          const cwd = typeof thread.cwd === "string" ? thread.cwd : "";
          if (!cwd || !/^(?:[a-z]:[\\/]|\\\\|\/)/iu.test(cwd)) return [];
          const createdAt = codexDate(thread.createdAt, new Date().toISOString());
          const updatedAt = codexDate(thread.updatedAt, createdAt);
          const preview = typeof thread.preview === "string" ? thread.preview.trim() : "";
          const name = typeof thread.name === "string" ? thread.name.trim() : "";
          const source: ProviderImportCandidate = {
            sourceId: thread.id,
            providerId: "codex",
            title: name || (preview ? Array.from(preview).slice(0, 80).join("") : "Codex 会话"),
            workingDirectory: cwd,
            createdAt,
            updatedAt,
            messageCount: 0,
            preview: preview.slice(0, 220),
          };
          return [source];
        });
        const withCounts = await Promise.all(candidates.map(async (candidate) => {
          try {
            const turns = await server.request<unknown>("thread/turns/list", { threadId: candidate.sourceId, limit: 500, sortDirection: "asc", itemsView: "summary" });
            if (!isRecord(turns) || !Array.isArray(turns.data)) return candidate;
            const count = turns.data.filter(isRecord).reduce((total, turn) => {
              if (!Array.isArray(turn.items)) return total + (turn.itemsView === "notLoaded" ? 0 : 1);
              return total + turn.items.filter((item: unknown) => isRecord(item) && (item.type === "userMessage" || item.type === "agentMessage")).length;
            }, 0);
            return { ...candidate, messageCount: count };
          } catch { return candidate; }
        }));
        for (const candidate of withCounts) sources.set(candidate.sourceId, candidate);
        cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
        if (!cursor) break;
      }
    } finally { await server.close(); }
    this.importSources = sources;
    return [...sources.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  isImportSourceImported(sourceId: string, references: readonly SessionStorageReference[]): boolean {
    return references.some((reference) => reference.threadId === sourceId);
  }

  async importSession(sourceId: string): Promise<ImportedProviderSession> {
    const candidate = this.importSources.get(sourceId);
    if (!candidate) throw new Error("Codex 会话列表已过期，请重新扫描后再试");
    const server = await this.openModelServer();
    try {
      const timeline = await readCodexTimeline(server, sourceId, candidate.updatedAt);
      const firstUserMessage = timeline.find((entry): entry is Extract<SessionTimelineEntry, { kind: "message" }> => entry.kind === "message" && entry.role === "user");
      const title = candidate.title === "Codex 会话" && firstUserMessage?.text ? Array.from(firstUserMessage.text.replace(/\s+/gu, " ").trim()).slice(0, 80).join("") : candidate.title;
      const importedCandidate = { ...candidate, title, preview: firstUserMessage?.text.slice(0, 220) ?? candidate.preview, messageCount: timeline.filter((entry) => entry.kind === "message").length };
      return { candidate: importedCandidate, storageReference: { threadId: sourceId }, timeline };
    } finally { await server.close(); }
  }

  async startSession(options: StartSessionOptions, emit: (event: AgentEvent) => void): Promise<AgentSession> {
    const session = new CodexSession(options, emit, resolveCodexExecutable());
    try { await session.start(); return session; }
    catch (error) { await session.dispose(); throw safeError(error); }
  }

  async deleteSession(reference: SessionStorageReference): Promise<void> {
    if (!reference.threadId) throw new Error("Codex 会话引用无效");
    const server = await this.openModelServer();
    try {
      await server.request("thread/delete", { threadId: reference.threadId });
    } catch (error) {
      // An empty thread has no persisted rollout yet, so Codex reports it as
      // absent. There is no native conversation content to retain in that case.
      if (!/no rollout found for thread id/iu.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    finally { await server.close(); }
  }

  private async openModelServer(): Promise<CodexAppServer> {
    const server = new CodexAppServer(resolveCodexExecutable(), homedir());
    await server.start();
    return server;
  }
}
