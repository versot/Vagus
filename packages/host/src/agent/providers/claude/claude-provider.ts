import { methods, type CloseSessionRequest, type CloseSessionResponse, type DeleteSessionRequest, type DeleteSessionResponse, type NewSessionRequest, type NewSessionResponse } from "@agentclientprotocol/sdk";
import type { AgentProvider, AgentSession, ImportedProviderSession, SessionStorageReference, StartSessionOptions } from "@vagus/agent-core";
import type { AgentEvent, ProviderImportCandidate, ProviderMcpCatalog, ProviderMcpServer, ProviderModelCatalog, ProviderPluginCatalog, ProviderPluginInstallResult, ProviderPluginMutationResult, ProviderPluginScope } from "@vagus/protocol";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { providerEnvironmentWithSearchPath } from "../../provider-environment.js";
import { ClaudeAcpSession } from "./claude-session.js";
import { claudePluginOperationError, parseClaudePluginCommandResult } from "./commands.js";
import { claudeConversation, deleteClaudeSessionTranscript, discoverClaudeSessionFiles } from "./history.js";
import { parseClaudeMcpDetails, parseClaudeMcpList } from "./mcp.js";
import { execFileAsync, openAcpConnection, resolveClaudeExecutable } from "./runtime.js";
import { catalogFrom } from "./settings.js";
import { isObject, withTimeout } from "./utils.js";

export class ClaudeProvider implements AgentProvider {
  private readonly importSources = new Map<string, string>();
  constructor(private readonly runCommand: typeof execFileAsync = execFileAsync) {}

  readonly descriptor = {
    id: "claude",
    displayName: "Claude Code",
    capabilities: [
      { id: "session.import", status: "implemented" as const, note: "可读取并导入本机 Claude Code JSONL 历史会话" },
      { id: "session.local", status: "implemented" as const, note: "通过 ACP 启动本机 Claude Code；沿用其本地配置和认证" },
      { id: "provider.plugins", status: "implemented" as const, note: "读取、安装和管理 Claude Code 插件与 marketplace；marketplace 声明的本机命令必须逐条向用户展示并确认后才执行" },
      { id: "provider.mcp.read", status: "implemented" as const, note: "只读呈现用户已通过本机 Claude Code 配置的 MCP 服务及脱敏详情，并适配其现有工具调用；添加、移除、OAuth 登录与凭据由 Claude Code 负责" },
      { id: "message.attachments", status: "implemented" as const, note: "通过 ACP image content 发送图片附件" },
      { id: "session.fork", status: "implemented" as const, note: "通过 Claude ACP session/fork 从指定助手回复创建独立会话" },
      { id: "session.model-selection", status: "implemented" as const, note: "通过 ACP 动态读取并切换本机 Claude Code 发布的模型与思考选项" },
      { id: "session.modes", status: "implemented" as const, note: "通过 ACP 会话模式支持 Plan、Default 等本机 Claude Code 模式" },
      { id: "session.queue", status: "implemented" as const, note: "支持完成后发送、查看和清空待处理消息；本机 ACP bridge 协商支持时，转向会注入当前 Claude Code 任务" },
      { id: "session.context", status: "partial" as const, note: "展示 ACP 用量并支持手动压缩；自动压缩没有独立设置控件。本机 ACP 已发布 /autocompact，通用命令入口可读取当前阈值；切换阈值后的持久化仍未验证" },
      { id: "session.commands", status: "partial" as const, note: "通过 ACP 动态发现 Claude Code 命令；命令具体行为由本机 Claude Code 决定" },
      { id: "session.plan", status: "partial" as const, note: "结构化计划显示为聊天中的进度状态；ACP 文件型计划仍无法直接展示" },
      { id: "session.subagents", status: "partial" as const, note: "呈现子代理状态、消息和嵌套工具活动；Agent 明确授权时可单独取消，尚无独立子代理会话视图" },
      { id: "interaction.dialog", status: "partial" as const, note: "ACP 工具权限与结构化表单映射到 Vagus 共用交互卡片" },
      { id: "interaction.form", status: "implemented" as const, note: "ACP 文本、数字、布尔、单选、多选及选项说明/预览均映射到 Vagus 共用表单控件" },
      { id: "interaction.url-elicitation", status: "partial" as const, note: "Vagus 已实现 ACP URL 授权卡片；但本机 Claude Code MCP 客户端没有声明 URL elicitation 能力，URL 模式请求会在到达 Vagus 前被拒绝。表单 elicitation 已验证可用" },
      { id: "ui.extension", status: "partial" as const, note: "ACP 表单请求映射到共用交互卡片；Claude ACP 不提供 Pi 式任意 TUI 小组件流" },
    ],
  };

  async listImportableSessions(): Promise<ProviderImportCandidate[]> {
    const projectsDirectory = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
    let files: string[];
    try { files = await discoverClaudeSessionFiles(projectsDirectory); }
    catch (error) { throw new Error(`无法读取 Claude Code 会话目录：${error instanceof Error ? error.message : String(error)}`); }
    this.importSources.clear();
    const candidates: ProviderImportCandidate[] = [];
    for (const path of files) {
      try {
        const info = await stat(path);
        if (info.size <= 0 || info.size > 128 * 1024 * 1024) continue;
        const raw = await readFile(path, "utf8");
        const records = raw.split(/\r?\n/u).flatMap((line) => {
          if (!line.trim()) return [];
          try { const value: unknown = JSON.parse(line); return isObject(value) ? [value] : []; } catch { return []; }
        });
        const header = records.find((record) => typeof record.sessionId === "string" && typeof record.cwd === "string");
        if (!header || typeof header.sessionId !== "string" || typeof header.cwd !== "string" || !isAbsolute(header.cwd)) continue;
        const sourceId = header.sessionId;
        if (!/^[0-9a-f-]{36}$/iu.test(sourceId) || basename(path, ".jsonl").toLowerCase() !== sourceId.toLowerCase()) continue;
        const fallbackDate = info.birthtime.toISOString();
        const metadata = claudeConversation(records, sourceId, fallbackDate);
        if (!metadata.messageCount) continue;
        this.importSources.set(sourceId, path);
        candidates.push({ sourceId, providerId: "claude", title: metadata.title, workingDirectory: header.cwd, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt, messageCount: metadata.messageCount, preview: metadata.preview });
      } catch {
        // Claude Code may still be writing a transcript; skip incomplete or inaccessible files.
      }
    }
    return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  isImportSourceImported(sourceId: string, references: readonly SessionStorageReference[]): boolean {
    return references.some((reference) => reference.sessionId === sourceId);
  }

  async importSession(sourceId: string): Promise<ImportedProviderSession> {
    const path = this.importSources.get(sourceId);
    if (!path) throw new Error("Claude Code 会话列表已过期，请重新扫描后再导入");
    const info = await stat(path);
    if (info.size <= 0 || info.size > 128 * 1024 * 1024) throw new Error("Claude Code 会话文件无效或过大");
    const raw = await readFile(path, "utf8");
    const records = raw.split(/\r?\n/u).flatMap((line) => {
      if (!line.trim()) return [];
      try { const value: unknown = JSON.parse(line); return isObject(value) ? [value] : []; } catch { return []; }
    });
    const header = records.find((record) => record.sessionId === sourceId && typeof record.cwd === "string");
    if (!header || typeof header.cwd !== "string" || !isAbsolute(header.cwd)) throw new Error("Claude Code 原生会话文件无效或尚未写入完成");
    const metadata = claudeConversation(records, sourceId, info.birthtime.toISOString());
    const candidate: ProviderImportCandidate = { sourceId, providerId: "claude", title: metadata.title, workingDirectory: header.cwd, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt, messageCount: metadata.messageCount, preview: metadata.preview };
    return { candidate, storageReference: { sessionId: sourceId }, timeline: metadata.timeline };
  }

  async listModels(): Promise<ProviderModelCatalog> {
    const { child, connection } = await openAcpConnection(async () => ({ outcome: { outcome: "cancelled" } }));
    let sessionId: string | undefined;
    try {
      const created = await withTimeout(connection.agent.request<NewSessionResponse, NewSessionRequest>(methods.agent.session.new, { cwd: homedir(), mcpServers: [] }), "Claude Code 模型目录读取超时");
      sessionId = created.sessionId;
      return catalogFrom(created.configOptions, created.modes);
    } finally {
      if (sessionId) await connection.agent.request<CloseSessionResponse, CloseSessionRequest>(methods.agent.session.close, { sessionId }).catch(() => undefined);
      connection.close();
      child.kill();
    }
  }

  async listPlugins(): Promise<ProviderPluginCatalog> {
    const executable = await resolveClaudeExecutable();
    const environment = await providerEnvironmentWithSearchPath();
    try {
      const [pluginResult, marketplaceResult] = await Promise.all([
        this.runCommand(executable, ["plugin", "list", "--json", "--available"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: environment }),
        this.runCommand(executable, ["plugin", "marketplace", "list", "--json"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: environment }),
      ]);
      const pluginData: unknown = JSON.parse(pluginResult.stdout);
      const marketplaceData: unknown = JSON.parse(marketplaceResult.stdout);
      if (!isObject(pluginData)) throw new Error("Claude Code 插件清单格式无效");
      const installed = (Array.isArray(pluginData.installed) ? pluginData.installed : []).flatMap((item) => {
        if (!isObject(item) || typeof item.id !== "string") return [];
        return [{ id: item.id.slice(0, 500), ...(typeof item.version === "string" ? { version: item.version.slice(0, 100) } : {}), ...(typeof item.scope === "string" ? { scope: item.scope.slice(0, 100) } : {}), enabled: item.enabled === true, ...(typeof item.installPath === "string" ? { installPath: item.installPath.slice(0, 4096) } : {}), ...(typeof item.installedAt === "string" ? { installedAt: item.installedAt.slice(0, 100) } : {}), ...(typeof item.lastUpdated === "string" ? { lastUpdated: item.lastUpdated.slice(0, 100) } : {}), ...(typeof item.projectEnabled === "boolean" ? { projectEnabled: item.projectEnabled } : {}) }];
      });
      const available = (Array.isArray(pluginData.available) ? pluginData.available : []).flatMap((item) => {
        if (!isObject(item) || typeof item.pluginId !== "string" || typeof item.name !== "string" || typeof item.marketplaceName !== "string") return [];
        return [{ id: item.pluginId.slice(0, 500), name: item.name.slice(0, 200), ...(typeof item.description === "string" ? { description: item.description.slice(0, 1000) } : {}), marketplace: item.marketplaceName.slice(0, 200), ...(typeof item.source === "string" ? { source: item.source.slice(0, 1000) } : {}) }];
      });
      const marketplaces = (Array.isArray(marketplaceData) ? marketplaceData : []).flatMap((item) => {
        if (!isObject(item) || typeof item.name !== "string") return [];
        return [{ name: item.name.slice(0, 200), ...(typeof item.source === "string" ? { source: item.source.slice(0, 500) } : {}), ...(typeof item.path === "string" ? { path: item.path.slice(0, 4096) } : {}), ...(typeof item.installLocation === "string" ? { installLocation: item.installLocation.slice(0, 4096) } : {}) }];
      });
      return { providerId: "claude", installed, available, marketplaces, fetchedAt: new Date().toISOString() };
    } catch (error) {
      const detail = error as Error & { stderr?: string; killed?: boolean };
      if (detail.killed) throw new Error("读取 Claude Code 插件目录超时，请重试。");
      const cliMessage = detail.stderr?.trim().split(/\r?\n/u).at(-1)?.slice(0, 500);
      throw new Error(cliMessage ? `读取 Claude Code 插件目录失败：${cliMessage}` : `读取 Claude Code 插件目录失败：${detail.message}`);
    }
  }

  async installPlugin(pluginId: string, scope: ProviderPluginScope = "user", acceptCommandSha256?: string): Promise<ProviderPluginInstallResult> {
    if (!/^[\w.-]{1,140}(?:@[\w.-]{1,140})?$/u.test(pluginId)) throw new Error("Claude Code 插件标识无效");
    if (acceptCommandSha256 !== undefined && !/^[a-f0-9]{64}$/iu.test(acceptCommandSha256)) throw new Error("插件安装命令确认标识无效");
    const args = ["plugin", "install", pluginId, "--scope", scope, "--json"];
    if (acceptCommandSha256) args.push("--accept-command", acceptCommandSha256);
    let stdout = "";
    let commandError: unknown;
    try {
      ({ stdout } = await this.runCommand(await resolveClaudeExecutable(), args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: await providerEnvironmentWithSearchPath(), cwd: homedir() }));
    } catch (error) {
      commandError = error;
      const captured = error as Error & { stdout?: string };
      stdout = captured.stdout ?? "";
    }
    const result = parseClaudePluginCommandResult(stdout);
    const shown = isObject(result) && isObject(result.shownCommand) ? result.shownCommand : undefined;
    if (shown) {
      const command = typeof shown.command === "string" ? shown.command : typeof shown.text === "string" ? shown.text : undefined;
      const hash = typeof shown.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(shown.sha256) ? shown.sha256 : undefined;
      if (!command || !hash) throw new Error("Claude Code 要求确认插件安装命令，但返回的数据不完整；未确认该命令");
      if (command.length > 12_000) throw new Error("插件安装命令过长，无法安全展示；未确认该命令");
      const actualHash = createHash("sha256").update(command).digest("hex");
      if (actualHash.toLocaleLowerCase() !== hash.toLocaleLowerCase()) throw new Error("Claude Code 返回的安装命令与确认摘要不匹配；未执行安装");
      return { providerId: "claude", pluginId, status: "confirmation-required", command, commandSha256: hash };
    }
    if (commandError) throw claudePluginOperationError(commandError);
    return { providerId: "claude", pluginId, status: "installed" };
  }

  async managePlugin(pluginId: string, action: "enable" | "disable" | "uninstall", scope?: ProviderPluginScope): Promise<ProviderPluginMutationResult> {
    if (!/^[\w.-]{1,140}(?:@[\w.-]{1,140})?$/u.test(pluginId)) throw new Error("Claude Code 插件标识无效");
    const args = ["plugin", action, pluginId, ...(scope ? ["--scope", scope] : []), "--json"];
    try {
      await this.runCommand(await resolveClaudeExecutable(), args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: await providerEnvironmentWithSearchPath(), cwd: homedir() });
    } catch (error) { throw claudePluginOperationError(error); }
    return { providerId: "claude", target: pluginId, action, completed: true };
  }

  async managePluginMarketplace(action: "add" | "update" | "remove", options: { source?: string; name?: string; scope?: ProviderPluginScope }): Promise<ProviderPluginMutationResult> {
    let args: string[];
    let target: string;
    if (action === "add") {
      const source = options.source?.trim();
      if (!source || source.startsWith("-") || source.length > 4096) throw new Error("请输入有效的插件 marketplace 来源");
      args = ["plugin", "marketplace", "add", source, ...(options.scope ? ["--scope", options.scope] : [])];
      target = source;
    } else if (action === "update") {
      if (options.name && !/^[\w.-]{1,200}$/u.test(options.name)) throw new Error("插件 marketplace 名称无效");
      args = ["plugin", "marketplace", "update", ...(options.name ? [options.name] : [])];
      target = options.name ?? "all";
    } else {
      const name = options.name?.trim();
      if (!name || !/^[\w.-]{1,200}$/u.test(name)) throw new Error("插件 marketplace 名称无效");
      args = ["plugin", "marketplace", "remove", name, ...(options.scope ? ["--scope", options.scope] : [])];
      target = name;
    }
    try {
      await this.runCommand(await resolveClaudeExecutable(), args, { timeout: 180_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: await providerEnvironmentWithSearchPath(), cwd: homedir() });
    } catch (error) { throw claudePluginOperationError(error); }
    return { providerId: "claude", target, action, completed: true };
  }

  async listMcpServers(): Promise<ProviderMcpCatalog> {
    try {
      const result = await execFileAsync(await resolveClaudeExecutable(), ["mcp", "list"], {
        timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true,
        env: await providerEnvironmentWithSearchPath(), cwd: homedir(),
      });
      return { providerId: "claude", servers: parseClaudeMcpList(result.stdout), fetchedAt: new Date().toISOString() };
    } catch (error) {
      const detail = error as Error & { killed?: boolean };
      if (detail.killed) throw new Error("读取 Claude Code MCP 清单超时，请重试。");
      // CLI error streams can include MCP URLs, commands, or environment values.
      // Never return or log them through the UI RPC.
      throw new Error("读取 Claude Code MCP 清单失败；详细连接配置已隐藏，请检查本机 Claude Code CLI 后重试。");
    }
  }

  async getMcpServer(serverName: string): Promise<ProviderMcpServer> {
    if (!/^[\w.-]{1,128}$/u.test(serverName)) throw new Error("Claude Code MCP 服务名称无效");
    const listed = await this.listMcpServers();
    if (!listed.servers.some(server => server.name === serverName)) throw new Error("找不到这个 MCP 服务；请刷新清单后重试。");
    try {
      const result = await execFileAsync(await resolveClaudeExecutable(), ["mcp", "get", serverName], {
        timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true,
        env: await providerEnvironmentWithSearchPath(), cwd: homedir(),
      });
      return parseClaudeMcpDetails(serverName, result.stdout);
    } catch {
      // Do not include stderr/stdout: get output can contain commands and secrets.
      throw new Error("无法读取该 MCP 服务的安全详情；连接配置已隐藏，请刷新清单后重试。");
    }
  }

  async startSession(options: StartSessionOptions, emit: (event: AgentEvent) => void): Promise<AgentSession> {
    const session = new ClaudeAcpSession(options, emit);
    try { await session.start(); return session; }
    catch (error) { await session.dispose(); throw error; }
  }

  async deleteSession(reference: SessionStorageReference): Promise<void> {
    const sessionId = reference.sessionId;
    if (!sessionId) throw new Error("Claude ACP 会话引用无效");
    let acpDeleteError: unknown;
    try {
      const { child, connection, sessionDeleteSupported } = await openAcpConnection(async () => ({ outcome: { outcome: "cancelled" } }));
      try {
        if (sessionDeleteSupported) {
          await connection.agent.request<DeleteSessionResponse, DeleteSessionRequest>(methods.agent.session.delete, { sessionId });
          return;
        }
      } catch (error) {
        acpDeleteError = error;
      } finally {
        connection.close();
        child.kill();
      }
    } catch (error) {
      acpDeleteError = error;
    }
    try {
      await deleteClaudeSessionTranscript(sessionId);
    } catch (error) {
      const nativeError = error instanceof Error ? error.message : String(error);
      const acpError = acpDeleteError instanceof Error ? `（ACP 删除也失败：${acpDeleteError.message}）` : "";
      throw new Error(`无法删除 Claude Code 原生会话：${nativeError}${acpError}`);
    }
  }
}
