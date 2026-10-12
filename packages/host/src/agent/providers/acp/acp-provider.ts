import { methods, type DeleteSessionRequest, type DeleteSessionResponse, type SessionModeState, type SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentProvider, AgentSession, ImportedProviderSession, SessionStorageReference, StartSessionOptions } from "@vagus/agent-core";
import type { AgentEvent, ProviderImportCandidate, ProviderModelCatalog, SessionTimelineEntry } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { AcpSession } from "./acp-session.js";
import { timelineFromSessionUpdates } from "./content.js";
import { type AcpAgentProfile } from "./profiles.js";
import { openAcp } from "./runtime.js";
import { catalogFrom } from "./settings.js";
import { isRecord, parseDirectories, timeout } from "./utils.js";

export class AcpProvider implements AgentProvider {
  private readonly importSources = new Map<string, { sessionId: string; cwd: string; additionalDirectories: string[]; title: string; updatedAt: string }>();
  readonly descriptor: AgentProvider["descriptor"];
  constructor(readonly profile: AcpAgentProfile) {
    this.descriptor = {
      id: profile.id,
      displayName: profile.displayName,
      capabilities: [
        { id: "session.local", status: "implemented", note: "通过本机 Agent 的 ACP stdio 接口运行" },
        { id: "session.import", status: "implemented", note: "通过 ACP session/list 和 session/load 导入本机会话；索引未提供的消息数会在读取历史后补齐" },
        { id: "session.additional-directories", status: "partial", note: "将项目的附加工作目录按 ACP 声明传给新建和恢复会话" },
        { id: "session.model-selection", status: "partial", note: "模型和思考程度按 Agent 实际公布的 ACP 会话选项提供" },
        { id: "session.modes", status: "partial", note: "支持 ACP session modes 与 configOptions 的 mode 类别；仅展示 Agent 实际公布的模式" },
        { id: "session.fork", status: "partial", note: "仅在 Agent 声明 ACP session/fork 时提供；ACP 未提供消息边界，因此只允许从最新已完成回复创建分支" },
        { id: "session.commands", status: "partial", note: "显示 Agent 通过 ACP 发布的命令" },
        { id: "session.subagents", status: "partial", note: "显示 Agent 通过 ACP 元数据公布的子代理状态和工具活动；不提供独立子会话视图" },
        { id: "session.queue", status: "partial", note: "支持 ACP 会话内完成后发送、查看和清空队列；ACP 未定义任务转向，新消息不能中断当前工具" },
        { id: "message.attachments", status: "partial", note: "图片按 ACP image 能力发送；支持 embeddedContext 的 Agent 可接收文本和二进制文件" },
        { id: "interaction.dialog", status: "implemented", note: "ACP 工具权限和表单 elicitation 映射到 Vagus 统一交互卡片" },
        { id: "session.context", status: "partial", note: "显示 ACP 公布的上下文窗口用量和成本；仅在 Agent 发布 compact 命令时支持手动压缩，OpenCode 另使用内置 /compact" },
        { id: "session.delete", status: "partial", note: "仅当本机 Agent 声明 ACP session/delete 时，才同时删除其原生会话记录" },
      ],
    };
  }

  async listModels(): Promise<ProviderModelCatalog> {
    const runtime = await openAcp(this.profile, homedir());
    let sessionId: string | undefined;
    const sessionCapabilities = isRecord(runtime.capabilities.sessionCapabilities) ? runtime.capabilities.sessionCapabilities : {};
    try {
      const created = await timeout(runtime.connection.agent.request(methods.agent.session.new, { cwd: homedir(), mcpServers: [] }), `${this.profile.displayName} 模型目录读取超时`);
      if (isRecord(created) && typeof created.sessionId === "string") sessionId = created.sessionId;
      return catalogFrom(this.profile, isRecord(created) && Array.isArray(created.configOptions) ? created.configOptions : [], isRecord(created) && isRecord(created.modes) ? created.modes as SessionModeState : null);
    } finally {
      try {
        if (sessionId && sessionCapabilities.delete) {
          // OpenCode persists session/new immediately. A close only detaches the
          // ACP process and leaves an empty conversation in its native history.
          await timeout(runtime.connection.agent.request(methods.agent.session.delete, { sessionId }), `${this.profile.displayName} 临时模型会话清理超时`);
        } else if (sessionId && sessionCapabilities.close) {
          await runtime.connection.agent.request(methods.agent.session.close, { sessionId }).catch(() => undefined);
        }
      } finally {
        runtime.connection.close();
        runtime.child.kill();
      }
    }
  }

  async listImportableSessions(): Promise<ProviderImportCandidate[]> {
    const runtime = await openAcp(this.profile, homedir());
    try {
      const capabilities = isRecord(runtime.capabilities.sessionCapabilities) ? runtime.capabilities.sessionCapabilities : {};
      if (!capabilities.list || runtime.capabilities.loadSession !== true) throw new Error(`${this.profile.displayName} 未同时公布 ACP 会话列表和读取能力`);
      this.importSources.clear();
      const candidates: ProviderImportCandidate[] = [];
      let cursor: string | undefined;
      const now = new Date().toISOString();
      for (let page = 0; page < 100; page++) {
        const response = await timeout(runtime.connection.agent.request(methods.agent.session.list, { cursor, cwd: null }), `${this.profile.displayName} 会话列表读取超时`);
        if (!isRecord(response) || !Array.isArray(response.sessions)) throw new Error(`${this.profile.displayName} 返回了无效的 ACP 会话列表`);
        for (const item of response.sessions) {
          if (!isRecord(item) || typeof item.sessionId !== "string" || typeof item.cwd !== "string" || !isAbsolute(item.cwd)) continue;
          const sourceId = randomUUID();
          const updatedAt = typeof item.updatedAt === "string" && !Number.isNaN(Date.parse(item.updatedAt)) ? item.updatedAt : now;
          const additionalDirectories = Array.isArray(item.additionalDirectories) ? item.additionalDirectories.filter((value): value is string => typeof value === "string" && isAbsolute(value)) : [];
          const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : `${this.profile.displayName} 会话`;
          this.importSources.set(sourceId, { sessionId: item.sessionId, cwd: item.cwd, additionalDirectories, title, updatedAt });
          candidates.push({ sourceId, providerId: this.profile.id, title, workingDirectory: item.cwd, ...(additionalDirectories.length ? { additionalDirectories } : {}), createdAt: updatedAt, updatedAt, preview: "" });
        }
        cursor = typeof response.nextCursor === "string" && response.nextCursor ? response.nextCursor : undefined;
        if (!cursor) break;
      }
      return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } finally {
      runtime.connection.close();
      runtime.child.kill();
    }
  }

  isImportSourceImported(sourceId: string, references: readonly SessionStorageReference[]): boolean {
    const source = this.importSources.get(sourceId);
    return Boolean(source && references.some((reference) => reference.sessionId === source.sessionId));
  }

  async importSession(sourceId: string): Promise<ImportedProviderSession> {
    const source = this.importSources.get(sourceId);
    if (!source) throw new Error(`${this.profile.displayName} 会话列表已过期，请重新扫描后再导入`);
    const updates: SessionNotification[] = [];
    const runtime = await openAcp(this.profile, source.cwd, (notification) => {
      if (notification.sessionId === source.sessionId) updates.push(notification);
    });
    try {
      if (!runtime.capabilities.loadSession) throw new Error(`${this.profile.displayName} 不支持通过 ACP 读取此会话`);
      await timeout(runtime.connection.agent.request(methods.agent.session.load, { sessionId: source.sessionId, cwd: source.cwd, mcpServers: [], additionalDirectories: source.additionalDirectories }), `${this.profile.displayName} 会话导入超时`);
      const timeline = timelineFromSessionUpdates(updates, source.updatedAt);
      const messages = timeline.filter((entry): entry is Extract<SessionTimelineEntry, { kind: "message" }> => entry.kind === "message");
      const firstUser = messages.find((entry) => entry.role === "user");
      const candidate: ProviderImportCandidate = {
        sourceId,
        providerId: this.profile.id,
        title: source.title,
        workingDirectory: source.cwd,
        ...(source.additionalDirectories.length ? { additionalDirectories: source.additionalDirectories } : {}),
        createdAt: source.updatedAt,
        updatedAt: source.updatedAt,
        messageCount: messages.length,
        preview: firstUser?.text.slice(0, 220) ?? "",
      };
      return { candidate, storageReference: { sessionId: source.sessionId, cwd: source.cwd, additionalDirectories: JSON.stringify(source.additionalDirectories) }, timeline };
    } finally {
      const sessionCapabilities = isRecord(runtime.capabilities.sessionCapabilities) ? runtime.capabilities.sessionCapabilities : {};
      if (sessionCapabilities.close) await runtime.connection.agent.request(methods.agent.session.close, { sessionId: source.sessionId }).catch(() => undefined);
      runtime.connection.close();
      runtime.child.kill();
    }
  }

  async deleteSession(reference: SessionStorageReference): Promise<void> {
    const sessionId = reference.sessionId;
    if (!sessionId) throw new Error(`${this.profile.displayName} ACP 会话引用无效`);
    // ACP agents such as Qoder scope native session lookup to the project cwd.
    // Reconnect in the original workspace so session/delete resolves the same
    // project namespace used when the session was created or imported.
    const cwd = reference.cwd && isAbsolute(reference.cwd) ? reference.cwd : homedir();
    const runtime = await openAcp(this.profile, cwd);
    try {
      const capabilities = isRecord(runtime.capabilities.sessionCapabilities) ? runtime.capabilities.sessionCapabilities : {};
      if (!capabilities.delete) throw new Error(`${this.profile.displayName} 未通过 ACP 声明支持原生会话删除；为避免留下会话数据，Vagus 未删除本地会话记录`);
      // Qoder scopes ACP session operations to a project context established by
      // session/load. A fresh ACP process can resolve the persisted session,
      // but session/delete alone otherwise searches its default project.
      if (this.profile.id === "qoder" && runtime.capabilities.loadSession) {
        await timeout(runtime.connection.agent.request(methods.agent.session.load, {
          sessionId,
          cwd,
          mcpServers: [],
          additionalDirectories: parseDirectories(reference.additionalDirectories),
        }), `${this.profile.displayName} 删除前恢复会话失败`);
      }
      await runtime.connection.agent.request<DeleteSessionResponse, DeleteSessionRequest>(methods.agent.session.delete, { sessionId });
    } finally {
      runtime.connection.close();
      runtime.child.kill();
    }
  }

  async startSession(options: StartSessionOptions, emit: (event: AgentEvent) => void): Promise<AgentSession> {
    const session = new AcpSession(this.profile, options, emit);
    try { await session.start(); return session; }
    catch (error) { await session.dispose(); throw error; }
  }
}
