import { CreateElicitationRequest, methods, type ClientConnection, type CreateElicitationResponse, type ForkSessionRequest, type ForkSessionResponse, type RequestPermissionRequest, type RequestPermissionResponse, type ResumeSessionRequest, type ResumeSessionResponse, type SessionConfigOption, type SessionModeState, type SessionNotification, type SetSessionConfigOptionRequest, type SetSessionConfigOptionResponse, type SetSessionModeRequest, type SetSessionModeResponse } from "@agentclientprotocol/sdk";
import type { AgentSendResult, AgentSession, SessionStorageReference, StartSessionOptions } from "@vagus/agent-core";
import type { AgentCommandInfo, AgentEvent, AgentRuntimeSettings, AgentUsage, BrowserElementReference, InteractionResponse, MessageAttachment, SessionId, SessionQueueState } from "@vagus/protocol";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { browserContext, embeddedResourceBlock, imageAttachment, imageBlock } from "./content.js";
import { elicitationField, validElicitationContent } from "./elicitation.js";
import { type AcpAgentProfile } from "./profiles.js";
import { openAcp } from "./runtime.js";
import { catalogFrom, choices, modeStateFromConfigOptions, settingsFromAcpOptions } from "./settings.js";
import { type AcpRecord, type PendingAcpPrompt, type PendingElicitation, type PendingPermission } from "./types.js";
import { acpErrorMessage, isRecord, locationPath, parseDirectories, timeout } from "./utils.js";

export class AcpSession implements AgentSession {
  readonly id: SessionId;
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private nativeSessionId: string | null = null;
  private sessionCapabilities: AcpRecord = {};
  private supportsImages = false;
  private supportsEmbeddedContext = false;
  private configOptions: SessionConfigOption[] = [];
  private modeState: SessionModeState | null = null;
  private settings: AgentRuntimeSettings;
  private commands: AgentCommandInfo[] = [];
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly elicitations = new Map<string, PendingElicitation>();
  private readonly toolIds = new Set<string>();
  private readonly childSessions = new Map<string, string>();
  private pendingSessionUpdates: SessionNotification[] = [];
  private currentMessageId: string | null = null;
  private active = false;
  private disposed = false;
  private cancelled = false;
  private suppressLoadedHistory = false;
  private activityStatus: string | null = null;
  private usage: AgentUsage | null = null;
  private promptQueue: PendingAcpPrompt[] = [];
  private drainingQueue = false;
  private manualCompaction = false;

  constructor(private readonly profile: AcpAgentProfile, private readonly options: StartSessionOptions, private readonly emit: (event: AgentEvent) => void) {
    this.id = options.sessionId ?? randomUUID();
    this.settings = { providerId: profile.id, modelId: null, thinkingLevel: null, thinkingLevels: [] };
  }

  get storageReference() {
    if (!this.nativeSessionId) return undefined;
    const cwd = this.options.resumeReference?.cwd || this.options.workingDirectory || homedir();
    const additionalDirectories = this.options.additionalDirectories ?? parseDirectories(this.options.resumeReference?.additionalDirectories);
    return { sessionId: this.nativeSessionId, cwd, additionalDirectories: JSON.stringify(additionalDirectories) };
  }
  get available() { return !this.disposed && this.connection !== null; }

  async start(): Promise<void> {
    const cwd = this.options.workingDirectory || homedir();
    const resumeId = this.options.resumeReference?.sessionId;
    const runtime = await openAcp(this.profile, cwd, (params) => this.receiveUpdate(params), (params) => this.onPermission(params), (params) => this.onElicitation(params));
    this.child = runtime.child;
    this.connection = runtime.connection;
    const sessionCapabilities = isRecord(runtime.capabilities.sessionCapabilities) ? runtime.capabilities.sessionCapabilities : {};
    this.sessionCapabilities = sessionCapabilities;
    const supportsResumeWithoutReplay = isRecord(sessionCapabilities.resume);
    // `session/load` replays the native transcript. Vagus already persists its
    // canonical timeline, so suppress that replay only when falling back from
    // the lighter `session/resume` method.
    this.suppressLoadedHistory = Boolean(resumeId && !supportsResumeWithoutReplay);
    this.supportsImages = isRecord(runtime.capabilities.promptCapabilities) && runtime.capabilities.promptCapabilities.image === true;
    this.supportsEmbeddedContext = isRecord(runtime.capabilities.promptCapabilities) && runtime.capabilities.promptCapabilities.embeddedContext === true;
    const additionalDirectories = this.options.additionalDirectories ?? parseDirectories(this.options.resumeReference?.additionalDirectories);
    const workspaceOptions = sessionCapabilities.additionalDirectories ? { additionalDirectories } : {};
    if (resumeId) {
      const sessionCwd = this.options.resumeReference?.cwd || cwd;
      let loaded: unknown;
      if (supportsResumeWithoutReplay) {
        loaded = await timeout(runtime.connection.agent.request<ResumeSessionResponse, ResumeSessionRequest>(methods.agent.session.resume, { sessionId: resumeId, cwd: sessionCwd, mcpServers: [], ...workspaceOptions }), `${this.profile.displayName} 会话恢复超时`);
      } else {
        if (!runtime.capabilities.loadSession) throw new Error(`${this.profile.displayName} 不支持通过 ACP 恢复此会话`);
        loaded = await timeout(runtime.connection.agent.request(methods.agent.session.load, { sessionId: resumeId, cwd: sessionCwd, mcpServers: [], ...workspaceOptions }), `${this.profile.displayName} 会话恢复超时`);
      }
      if (!isRecord(loaded)) throw new Error(`${this.profile.displayName} 未能恢复 ACP 会话`);
      this.nativeSessionId = resumeId;
      this.configOptions = Array.isArray(loaded.configOptions) ? loaded.configOptions : [];
      this.modeState = isRecord(loaded.modes) ? loaded.modes as SessionModeState : null;
    } else {
      const created = await timeout(runtime.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [], ...workspaceOptions }), `${this.profile.displayName} 会话创建超时`);
      if (!isRecord(created) || typeof created.sessionId !== "string") throw new Error(`${this.profile.displayName} 返回了无效的 ACP 会话`);
      this.nativeSessionId = created.sessionId;
      this.configOptions = Array.isArray(created.configOptions) ? created.configOptions : [];
      this.modeState = isRecord(created.modes) ? created.modes as SessionModeState : null;
    }
    // ACP agents may publish initial commands, title, or runtime updates while
    // session/new or session/load is still resolving. The native session ID is
    // only known from that response, so keep those notifications until then.
    this.flushPendingSessionUpdates();
    this.settings = settingsFromAcpOptions(this.profile.id, this.configOptions, this.modeState);
    this.child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => this.onExit(code, signal));
    this.emit({ type: "session.settings.updated", sessionId: this.id, settings: this.getSettingsSnapshot() });
    this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
  }

  private onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const interactionId = randomUUID();
    const labels = new Map<string, number>();
    const options = params.options.map((option) => {
      const base = option.name.trim() || option.kind;
      const count = labels.get(base) ?? 0;
      labels.set(base, count + 1);
      return { optionId: option.optionId, kind: option.kind, label: count ? `${base} (${count + 1})` : base };
    });
    const result = new Promise<string | null>((resolve) => this.permissions.set(interactionId, { resolve, options }));
    const call = params.toolCall as unknown as AcpRecord;
    const details = [typeof call.title === "string" ? call.title : "", isRecord(call.rawInput) ? JSON.stringify(call.rawInput).slice(0, 800) : ""].filter(Boolean).join("\n");
    this.emit({ type: "interaction.requested", sessionId: this.id, interactionId, interaction: { kind: "choice", title: typeof call.name === "string" ? call.name : "ACP 工具权限", message: details, options: options.map((item) => item.label) } });
    return result.then((optionId): RequestPermissionResponse => optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
  }

  private onElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    if (!("sessionId" in params) || typeof params.sessionId !== "string" || params.sessionId !== this.nativeSessionId || !CreateElicitationRequest.isForm(params)) return Promise.resolve({ action: "decline" });
    const schema = params.requestedSchema;
    const fields = Object.entries(schema.properties ?? {}).flatMap(([id, property]) => ["string", "number", "integer", "boolean", "array"].includes(property.type) ? [elicitationField(id, property, (schema.required ?? []).includes(id))] : []);
    const interactionId = randomUUID();
    const response = new Promise<CreateElicitationResponse>((resolve) => this.elicitations.set(interactionId, { resolve, params }));
    this.emit({ type: "interaction.requested", sessionId: this.id, interactionId, interaction: { kind: "form", title: schema.title ?? undefined, message: schema.description ?? params.message, fields } });
    return response;
  }

  private onUpdate(params: SessionNotification): void {
    if (!this.nativeSessionId || params.sessionId !== this.nativeSessionId || !isRecord(params.update)) return;
    const update = { ...params.update } as AcpRecord;
    if (this.suppressLoadedHistory) {
      if (!["available_commands_update", "config_option_update", "current_mode_update", "session_info_update", "usage_update"].includes(String(update.sessionUpdate))) return;
      // session_info_update also carries replayed retry/compaction markers. Keep
      // the restored title, but do not resurrect old transient activity.
      if (update.sessionUpdate === "session_info_update") delete update._meta;
    }
    this.observeOpenCodeChildSession(update);
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        // zcode-acp-server emits a synthetic `turninfo_*` assistant message
        // after the actual answer (for example, "✓ completed · cache …").
        // If treated as a normal answer, Vagus marks that status line as the
        // turn's final assistant message and folds the real answer into the
        // elapsed-time section. Ignore this bridge-only status message.
        if (this.profile.id === "zcode" && typeof update.messageId === "string" && update.messageId.startsWith("turninfo_")) break;
        // A slash-command-backed compact returns a short ACP assistant
        // acknowledgement rather than a model answer. Keep it out of chat.
        if (this.manualCompaction) break;
        const content = update.content as AcpRecord;
        if (!content) break;
        this.setActivityStatus(null);
        if (content.type === "image") {
          const attachment = imageAttachment(content);
          if (attachment) {
            const imageMessageId = `acp-image-${randomUUID()}`;
            this.emit({ type: "message.started", sessionId: this.id, messageId: imageMessageId, role: "assistant", attachments: [attachment] });
            this.emit({ type: "message.completed", sessionId: this.id, messageId: imageMessageId });
          }
          break;
        }
        if (content.type !== "text" || typeof content.text !== "string") break;
        const messageId = typeof update.messageId === "string" ? update.messageId : this.currentMessageId ?? randomUUID();
        if (this.currentMessageId !== messageId) {
          if (this.currentMessageId) this.emit({ type: "message.completed", sessionId: this.id, messageId: this.currentMessageId });
          this.currentMessageId = messageId;
          this.emit({ type: "message.started", sessionId: this.id, messageId, role: "assistant" });
        }
        this.emit({ type: "message.delta", sessionId: this.id, messageId, text: content.text });
        break;
      }
      case "agent_thought_chunk":
        this.setActivityStatus("正在思考");
        break;
      case "tool_call":
        this.setActivityStatus(null);
        this.startTool(update);
        break;
      case "tool_call_update":
        this.updateTool(update);
        break;
      case "plan": {
        // ZCode's ACP bridge publishes its internal plan updates, but Vagus
        // does not need to surface that extra plan card in ZCode conversations.
        if (this.profile.id === "zcode") break;
        const entries = Array.isArray(update.entries) ? update.entries : [];
        this.emit({ type: "session.plan.updated", sessionId: this.id, planId: `acp-plan-${params.sessionId}`, steps: entries.flatMap((entry: AcpRecord) => typeof entry.content === "string" ? [{ step: entry.content, status: entry.status === "completed" ? "completed" as const : entry.status === "in_progress" ? "inProgress" as const : "pending" as const }] : []) });
        break;
      }
      case "available_commands_update":
        this.commands = (Array.isArray(update.availableCommands) ? update.availableCommands : []).flatMap((item: AcpRecord) => {
          if (typeof item.name !== "string") return [];
          const normalizedName = item.name.trim().replace(/^\/+/, "").toLowerCase();
          // Use Vagus's native session operations where ACP exposes equivalent
          // commands. ACP fork must be available or the slash command would
          // otherwise create a native branch that Vagus does not open.
          if (normalizedName === "fork" && !this.sessionCapabilities.fork) return [];
          const action = normalizedName === "compact" ? "compact" as const : normalizedName === "fork" ? "fork" as const : undefined;
          return [{ name: item.name, ...(typeof item.description === "string" ? { description: item.description } : {}), ...(isRecord(item.input) && typeof item.input.hint === "string" ? { inputHint: item.input.hint } : {}), source: "other" as const, ...(action ? { action } : {}) }];
        });
        this.emit({ type: "session.commands.updated", sessionId: this.id, commands: this.commands });
        break;
      case "current_mode_update":
        if (typeof update.currentModeId === "string") {
          if (this.modeState) this.modeState = { ...this.modeState, currentModeId: update.currentModeId };
          else this.configOptions = this.configOptions.map((option) => option.category === "mode" && option.type === "select" ? { ...option, currentValue: update.currentModeId } : option);
        }
        this.settings = settingsFromAcpOptions(this.profile.id, this.configOptions, this.modeState, this.settings);
        this.emit({ type: "session.settings.updated", sessionId: this.id, settings: this.getSettingsSnapshot() });
        break;
      case "config_option_update":
        if (Array.isArray(update.configOptions)) {
          this.configOptions = update.configOptions as SessionConfigOption[];
          this.settings = settingsFromAcpOptions(this.profile.id, this.configOptions, this.modeState, this.settings);
          this.emit({ type: "session.settings.updated", sessionId: this.id, settings: this.getSettingsSnapshot() });
          this.emit({ type: "provider.models.updated", catalog: catalogFrom(this.profile, this.configOptions, this.modeState) });
        }
        break;
      case "session_info_update":
        if (typeof update.title === "string" && update.title.trim()) this.emit({ type: "ui.title", sessionId: this.id, title: update.title.trim() });
        if (isRecord(update._meta)) {
          if (Object.prototype.hasOwnProperty.call(update._meta, "opencode/retry")) {
            const retry = update._meta["opencode/retry"];
            if (isRecord(retry)) {
              const attempt = Number.isInteger(retry.attempt) && retry.attempt > 0 ? `第 ${retry.attempt} 次` : "";
              const retryAt = typeof retry.nextRetryAt === "string" && !Number.isNaN(Date.parse(retry.nextRetryAt)) ? `，计划于 ${new Date(retry.nextRetryAt).toLocaleTimeString()} 重试` : "";
              const detail = isRecord(retry.error) && typeof retry.error.message === "string" ? `：${retry.error.message}` : "";
              this.setRetryStatus(`${this.profile.displayName} 自动重试${attempt ? `（${attempt}）` : ""}${retryAt}${detail}`);
            } else if (retry === null) this.setRetryStatus(null);
          }
          const compaction = update._meta["opencode/compaction"];
          if (isRecord(compaction) && !this.manualCompaction) {
            const reason = typeof compaction.reason === "string" ? compaction.reason : undefined;
            if (compaction.status === "started") this.emit({ type: "session.compaction", sessionId: this.id, state: "started", ...(reason ? { reason } : {}) });
            else if (compaction.status === "completed") this.emit({ type: "session.compaction", sessionId: this.id, state: "completed", ...(reason ? { reason } : {}) });
            else if (compaction.status === "failed") {
              this.emit({ type: "session.compaction", sessionId: this.id, state: "completed", reason: "failed" });
              const detail = isRecord(compaction.error) && typeof compaction.error.message === "string" ? `：${compaction.error.message}` : "";
              this.emit({ type: "notification", sessionId: this.id, level: "warning", message: `${this.profile.displayName} 上下文压缩失败${detail}` });
            }
          }
        }
        break;
      case "usage_update": {
        if (typeof update.used !== "number" || typeof update.size !== "number") break;
        const cost = isRecord(update.cost) && update.cost.currency === "USD" && typeof update.cost.amount === "number" ? { totalCostUsd: update.cost.amount } : {};
        this.usage = { contextWindowUsedTokens: update.used, contextWindowMaxTokens: update.size, ...cost };
        this.emit({ type: "session.usage.updated", sessionId: this.id, usage: this.usage });
        break;
      }
    }
  }

  private observeOpenCodeChildSession(update: AcpRecord): void {
    if (this.profile.id !== "opencode" || !isRecord(update._meta)) return;
    const child = update._meta["opencode/child-session"];
    if (!isRecord(child) || typeof child.id !== "string" || !child.id) return;
    const id = child.id;
    const title = typeof child.title === "string" && child.title.trim() ? child.title.trim() : "OpenCode 子代理";
    const previousTitle = this.childSessions.get(id);
    if (!previousTitle) this.childSessions.set(id, title);
    const name = previousTitle ?? title;
    this.emit({
      type: "ui.status",
      sessionId: this.id,
      key: `subagent:opencode:${id}`,
      text: `子代理「${name}」正在运行`,
      subagentSessionId: id,
      subagentState: "running",
    });
  }

  private finishOpenCodeChildSessions(state: "completed" | "failed" | "cancelled" | "disconnected"): void {
    if (this.profile.id !== "opencode" || !this.childSessions.size) return;
    for (const [id, title] of this.childSessions) {
      const stateText = state === "completed" ? "已完成" : state === "cancelled" ? "已取消" : state === "disconnected" ? "连接中断" : "失败";
      this.emit({
        type: "ui.status",
        sessionId: this.id,
        key: `subagent:opencode:${id}`,
        text: `子代理「${title}」${stateText}`,
        subagentSessionId: id,
        subagentState: state,
      });
    }
    this.childSessions.clear();
  }

  private receiveUpdate(params: SessionNotification): void {
    if (!this.nativeSessionId) {
      this.pendingSessionUpdates.push(params);
      return;
    }
    this.onUpdate(params);
  }

  private flushPendingSessionUpdates(): void {
    const pending = this.pendingSessionUpdates;
    this.pendingSessionUpdates = [];
    for (const notification of pending) this.onUpdate(notification);
  }

  private setRetryStatus(text: string | null): void {
    this.setActivityStatus(text);
  }

  private setActivityStatus(text: string | null): void {
    if (this.activityStatus === text) return;
    this.activityStatus = text;
    this.emit({ type: "ui.status", sessionId: this.id, key: "agent-activity", text });
  }

  private startTool(update: AcpRecord): void {
    if (typeof update.toolCallId !== "string") return;
    const id = update.toolCallId;
    this.toolIds.add(id);
    this.emit({ type: "tool.started", sessionId: this.id, toolCallId: id, name: typeof update.kind === "string" ? update.kind : "tool", ...(typeof update.title === "string" ? { title: update.title } : {}), ...(update.rawInput !== undefined ? { input: update.rawInput } : {}), ...(Array.isArray(update.locations) ? { locations: locationPath(update.locations) } : {}) });
    if (update.content !== undefined) this.emit({ type: "tool.updated", sessionId: this.id, toolCallId: id, ...(Array.isArray(update.content) ? { content: update.content } : {}) });
    if (update.status === "completed" || update.status === "failed") this.finishTool(id, update.status === "failed", update.rawOutput);
  }

  private updateTool(update: AcpRecord): void {
    if (typeof update.toolCallId !== "string") return;
    const id = update.toolCallId;
    if (!this.toolIds.has(id)) this.startTool(update);
    if (update.rawInput !== undefined || update.content !== undefined || update.locations !== undefined || update.rawOutput !== undefined) {
      this.emit({ type: "tool.updated", sessionId: this.id, toolCallId: id, ...(update.rawInput !== undefined ? { input: update.rawInput } : {}), ...(update.content !== undefined ? { content: update.content } : {}), ...(Array.isArray(update.locations) ? { locations: locationPath(update.locations) } : {}), ...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}) });
    }
    if (update.status === "completed" || update.status === "failed") this.finishTool(id, update.status === "failed", update.rawOutput);
  }

  private finishTool(id: string, isError: boolean, output?: unknown): void {
    if (!this.toolIds.delete(id)) return;
    this.emit({ type: "tool.completed", sessionId: this.id, toolCallId: id, isError, ...(output !== undefined ? { output } : {}) });
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.disposed) return;
    this.connection?.close(); this.connection = null; this.child = null;
    const abandonedPrompts = this.promptQueue.length;
    this.promptQueue = [];
    if (abandonedPrompts) {
      this.publishQueue();
      this.emit({ type: "notification", sessionId: this.id, level: "warning", message: `${this.profile.displayName} ACP 进程已退出；${abandonedPrompts} 条待处理消息未发送，请重试` });
    }
    this.active = false;
    this.finishOpenCodeChildSessions("disconnected");
    this.setRetryStatus(null);
    this.finishMessage();
    for (const [interactionId, pending] of this.permissions) {
      pending.resolve(null);
      this.emit({ type: "interaction.responded", sessionId: this.id, interactionId, value: null, reason: "interrupted" });
    }
    this.permissions.clear();
    for (const [interactionId, pending] of this.elicitations) {
      pending.resolve({ action: "cancel" });
      this.emit({ type: "interaction.responded", sessionId: this.id, interactionId, value: null, reason: "interrupted" });
    }
    this.elicitations.clear();
    for (const id of this.toolIds) this.finishTool(id, true, "ACP Agent 在工具结束前退出");
    this.emit({ type: "provider.error", sessionId: this.id, code: "acp_agent_exit", message: `${this.profile.displayName} ACP 进程已退出 (${signal ?? code ?? "unknown"})`, recoverable: true });
    this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
  }

  private finishMessage(): void {
    if (!this.currentMessageId) return;
    this.emit({ type: "message.completed", sessionId: this.id, messageId: this.currentMessageId });
    this.currentMessageId = null;
  }

  async sendText(text: string, attachments: MessageAttachment[] = [], deliveryMode: "immediate" | "steer" | "follow-up" = "immediate", clientMessageId?: string, browserElements: BrowserElementReference[] = []): Promise<AgentSendResult> {
    if (this.disposed || !this.connection || !this.nativeSessionId) throw new Error(`${this.profile.displayName} ACP 会话不可用`);
    if (!text.trim() && !attachments.length && !browserElements.length) throw new Error("消息不能为空");
    if (attachments.some((attachment) => attachment.mimeType.startsWith("image/")) && !this.supportsImages && !this.supportsEmbeddedContext) throw new Error(`${this.profile.displayName} 未通过 ACP 声明支持图片或嵌入式上下文`);
    if (attachments.some((attachment) => !attachment.mimeType.startsWith("image/")) && !this.supportsEmbeddedContext) throw new Error(`${this.profile.displayName} 未通过 ACP 声明支持嵌入式文件上下文`);
    const displayText = text.trim() || (browserElements.length ? "请分析我选中的网页元素。" : "请查看附件中的图片。");
    if (this.active || this.drainingQueue) {
      if (deliveryMode === "steer") this.emit({ type: "notification", sessionId: this.id, level: "info", message: `${this.profile.displayName} ACP 不支持中断当前任务；这条消息会在当前回复后发送` });
      this.promptQueue.push({ text: displayText, attachments, browserElements, ...(clientMessageId ? { clientMessageId } : {}) });
      this.publishQueue();
      return { disposition: "queued" };
    }
    await this.runPrompt({ text: displayText, attachments, browserElements, ...(clientMessageId ? { clientMessageId } : {}) });
    return { disposition: "submitted" };
  }

  async compact(instructions?: string): Promise<void> {
    if (this.disposed || !this.connection || !this.nativeSessionId) throw new Error(`${this.profile.displayName} ACP 会话不可用`);
    if (this.active || this.drainingQueue || this.promptQueue.length) throw new Error("请等待当前回复完成后再压缩上下文");
    const compactCommand = this.commands.find((command) => command.name.trim().replace(/^\/+/, "").toLowerCase() === "compact");
    // OpenCode publishes its built-in /compact through available_commands_update,
    // but that session notification can arrive after the first user action (or
    // not be replayed when resuming). Do not mistake a delayed command catalog
    // for missing compaction support.
    if (!compactCommand && this.profile.id !== "opencode") throw new Error(`${this.profile.displayName} 未通过 ACP 发布 /compact 命令`);

    this.active = true;
    this.cancelled = false;
    this.suppressLoadedHistory = false;
    this.manualCompaction = true;
    this.emit({ type: "session.compaction", sessionId: this.id, state: "started" });
    this.emit({ type: "session.state", sessionId: this.id, state: "running" });
    let failure: unknown;
    try {
      const detail = instructions?.trim();
      const commandText = detail ? `/compact ${detail}` : "/compact";
      const response = await this.connection.agent.request(methods.agent.session.prompt, {
        sessionId: this.nativeSessionId,
        prompt: [{ type: "text", text: commandText }],
      });
      this.finishMessage();
      for (const id of this.toolIds) this.finishTool(id, false);
      if (isRecord(response) && response.stopReason === "cancelled") throw new Error(`${this.profile.displayName} 上下文压缩已取消`);
    } catch (error) {
      failure = error;
      this.finishMessage();
      for (const id of this.toolIds) this.finishTool(id, true, error instanceof Error ? error.message : String(error));
    } finally {
      this.manualCompaction = false;
      this.finishOpenCodeChildSessions(failure ? "failed" : "completed");
      this.setRetryStatus(null);
      this.active = false;
      this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
      this.emit({ type: "session.compaction", sessionId: this.id, state: "completed", ...(failure ? { reason: this.cancelled ? "cancelled" : "failed" } : {}) });
      if (this.promptQueue.length) void this.drainQueue();
    }
    if (failure) throw failure;
  }

  async forkAfterAssistantMessage(_text: string, _occurrence: number, messageId?: string): Promise<SessionStorageReference> {
    if (this.disposed || !this.connection || !this.nativeSessionId) throw new Error(`${this.profile.displayName} ACP 会话不可用`);
    if (this.active || this.drainingQueue || this.promptQueue.length) throw new Error("请等待当前回复及排队消息完成后再创建分支");
    if (!this.sessionCapabilities.fork) throw new Error(`${this.profile.displayName} 未通过 ACP 声明会话分支能力`);

    const cwd = this.options.resumeReference?.cwd || this.options.workingDirectory || homedir();
    const additionalDirectories = this.options.additionalDirectories ?? parseDirectories(this.options.resumeReference?.additionalDirectories);
    const request: ForkSessionRequest & { target?: { kind: "message"; messageId: string } } = {
      sessionId: this.nativeSessionId,
      cwd,
      mcpServers: [],
      ...(this.sessionCapabilities.additionalDirectories ? { additionalDirectories } : {}),
      // The ZCode bridge defaults to a workspace checkpoint, which a text-only
      // conversation may never create. Its extension accepts a native message
      // target; ZCode publishes that same ID in its ACP message chunks.
      ...(this.profile.id === "zcode" && messageId ? { target: { kind: "message" as const, messageId } } : {}),
    };
    const forked = await timeout(
      this.connection.agent.request<ForkSessionResponse, ForkSessionRequest>(methods.agent.session.fork, request),
      `${this.profile.displayName} ACP 分支创建超时`,
    ).catch((error: unknown) => { throw new Error(acpErrorMessage(error)); });
    // zcode-acp-server currently forwards ZCode's app-server response as-is.
    // That API names the newly created session `forkedSessionId`, while ACP
    // calls it `sessionId`. Normalize the bridge's response at this adapter
    // boundary so the rest of Vagus can resume the native fork normally.
    const zcodeForkedSessionId = this.profile.id === "zcode"
      ? (forked as ForkSessionResponse & { forkedSessionId?: unknown } | null)?.forkedSessionId
      : undefined;
    const forkedSessionId = forked && typeof forked.sessionId === "string"
      ? forked.sessionId
      : typeof zcodeForkedSessionId === "string" ? zcodeForkedSessionId : undefined;
    if (!forkedSessionId || forkedSessionId === this.nativeSessionId) {
      throw new Error(`${this.profile.displayName} 返回了无效的 ACP 分支会话`);
    }
    return { sessionId: forkedSessionId, cwd, additionalDirectories: JSON.stringify(additionalDirectories) };
  }

  private async runPrompt(item: PendingAcpPrompt): Promise<void> {
    if (this.disposed || !this.connection || !this.nativeSessionId) throw new Error(`${this.profile.displayName} ACP 会话不可用`);
    const messageId = randomUUID();
    const promptText = `${item.text}${browserContext(item.browserElements)}`;
    const content: AcpRecord[] = [{ type: "text", text: promptText }, ...item.attachments.flatMap((attachment) => {
      if (attachment.mimeType.startsWith("image/") && this.supportsImages) {
        const block = imageBlock(attachment);
        return block ? [block] : [];
      }
      const block = this.supportsEmbeddedContext ? embeddedResourceBlock(attachment) : null;
      return block ? [block] : [];
    })];
    this.emit({ type: "message.started", sessionId: this.id, messageId, role: "user", attachments: item.attachments, browserElements: item.browserElements, ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}) });
    this.emit({ type: "message.delta", sessionId: this.id, messageId, text: item.text });
    this.emit({ type: "message.completed", sessionId: this.id, messageId });
    this.active = true;
    this.cancelled = false;
    this.suppressLoadedHistory = false;
    this.emit({ type: "session.state", sessionId: this.id, state: "running" });
    let childState: "completed" | "failed" | "cancelled" = "completed";
    try {
      const response = await this.connection.agent.request(methods.agent.session.prompt, { sessionId: this.nativeSessionId, prompt: content });
      this.finishMessage();
      for (const id of this.toolIds) this.finishTool(id, false);
      if (isRecord(response) && response.stopReason === "cancelled") {
        childState = "cancelled";
        this.emit({ type: "notification", sessionId: this.id, level: "info", message: `${this.profile.displayName} 已停止当前任务` });
      }
    } catch (error) {
      childState = this.cancelled ? "cancelled" : "failed";
      this.finishMessage();
      if (this.cancelled) this.emit({ type: "notification", sessionId: this.id, level: "info", message: `${this.profile.displayName} 已停止当前任务` });
      else this.emit({ type: "provider.error", sessionId: this.id, code: "acp_prompt_failed", message: acpErrorMessage(error), recoverable: true });
      for (const id of this.toolIds) this.finishTool(id, this.cancelled, this.cancelled ? "任务已停止" : undefined);
      if (!this.cancelled) throw error;
    } finally {
      this.finishOpenCodeChildSessions(childState);
      this.setRetryStatus(null);
      this.active = false;
      this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
      if (this.promptQueue.length) void this.drainQueue();
    }
  }

  private publishQueue(): SessionQueueState {
    const queue: SessionQueueState = { steering: [], followUp: this.promptQueue.map((item) => item.text) };
    this.emit({ type: "session.queue.updated", sessionId: this.id, queue });
    return queue;
  }

  private async drainQueue(): Promise<void> {
    if (this.drainingQueue || this.active || this.disposed) return;
    this.drainingQueue = true;
    try {
      while (this.promptQueue.length && !this.disposed) {
        const item = this.promptQueue.shift()!;
        this.publishQueue();
        try { await this.runPrompt(item); }
        catch { /* runPrompt emits the provider error; keep later queued messages usable. */ }
      }
    } finally {
      this.drainingQueue = false;
      if (this.promptQueue.length && !this.active && !this.disposed) void this.drainQueue();
    }
  }

  async respond(response: InteractionResponse): Promise<void> {
    const elicitation = this.elicitations.get(response.interactionId);
    if (elicitation) {
      this.elicitations.delete(response.interactionId);
      let answer: CreateElicitationResponse = { action: "cancel" };
      if (typeof response.value === "string") {
        try {
          const content = JSON.parse(response.value) as Record<string, unknown>;
          if (content && typeof content === "object" && !Array.isArray(content) && validElicitationContent(content, elicitation.params)) answer = { action: "accept", content };
        } catch { /* Invalid form responses are cancelled instead of sent to the Agent. */ }
      }
      elicitation.resolve(answer);
      this.emit({ type: "interaction.responded", sessionId: this.id, interactionId: response.interactionId, value: response.value });
      return;
    }
    const pending = this.permissions.get(response.interactionId);
    if (!pending) throw new Error("这个 ACP 权限请求已结束");
    this.permissions.delete(response.interactionId);
    const option = typeof response.value === "string" ? pending.options.find((item) => item.label === response.value)
      : response.value === true ? pending.options.find((item) => item.kind === "allow_once" || item.kind === "allow_always")
        : pending.options.find((item) => item.kind === "reject_once" || item.kind === "reject_always");
    pending.resolve(option?.optionId ?? null);
    this.emit({ type: "interaction.responded", sessionId: this.id, interactionId: response.interactionId, value: response.value });
  }

  async cancel(): Promise<void> {
    const queueWasCleared = this.promptQueue.length > 0;
    this.promptQueue = [];
    if (queueWasCleared) this.publishQueue();
    if (!this.connection || !this.nativeSessionId || !this.active) return;
    this.cancelled = true;
    // ACP session/cancel is a notification, not a request.
    await this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.nativeSessionId });
  }

  async getRuntimeSettings(): Promise<AgentRuntimeSettings> { return this.getSettingsSnapshot(); }
  async getUsage(): Promise<AgentUsage | null> { return this.usage ? { ...this.usage } : null; }
  private getSettingsSnapshot(): AgentRuntimeSettings { return { ...this.settings, ...(this.settings.availableModes ? { availableModes: this.settings.availableModes.map((mode) => ({ ...mode })) } : {}) }; }
  async getCommands(): Promise<AgentCommandInfo[]> { return [...this.commands]; }

  async setModel(modelId: string): Promise<AgentRuntimeSettings> { return this.setConfig("model", modelId); }
  async setThinkingLevel(level: string): Promise<AgentRuntimeSettings> { return this.setConfig("thought_level", level); }
  private async setConfig(category: "model" | "thought_level", value: string): Promise<AgentRuntimeSettings> {
    if (!this.connection || !this.nativeSessionId) throw new Error(`${this.profile.displayName} ACP 会话不可用`);
    const option = this.configOptions.find((item) => item.category === category);
    if (!option || option.type !== "select" || !choices(option).some((item) => item.value === value)) throw new Error(`${this.profile.displayName} 未公布此${category === "model" ? "模型" : "思考程度"}选项`);
    const response = await this.connection.agent.request<SetSessionConfigOptionResponse, SetSessionConfigOptionRequest>(methods.agent.session.setConfigOption, { sessionId: this.nativeSessionId, configId: option.id, value });
    if (!Array.isArray(response.configOptions)) throw new Error(`${this.profile.displayName} 未返回更新后的会话选项`);
    this.configOptions = response.configOptions;
    this.settings = settingsFromAcpOptions(this.profile.id, this.configOptions, this.modeState, this.settings);
    const updated = this.getSettingsSnapshot();
    this.emit({ type: "session.settings.updated", sessionId: this.id, settings: updated });
    return updated;
  }

  async setMode(modeId: string): Promise<AgentRuntimeSettings> {
    const availableModes = this.modeState?.availableModes ?? modeStateFromConfigOptions(this.configOptions)?.availableModes ?? [];
    if (!this.connection || !this.nativeSessionId || !availableModes.some((item) => item.id === modeId)) throw new Error(`${this.profile.displayName} 未公布此会话模式`);
    await this.connection.agent.request<SetSessionModeResponse, SetSessionModeRequest>(methods.agent.session.setMode, { sessionId: this.nativeSessionId, modeId });
    if (this.modeState) this.modeState = { ...this.modeState, currentModeId: modeId };
    else this.configOptions = this.configOptions.map((option) => option.category === "mode" && option.type === "select" ? { ...option, currentValue: modeId } : option);
    this.settings = settingsFromAcpOptions(this.profile.id, this.configOptions, this.modeState, this.settings);
    const updated = this.getSettingsSnapshot();
    this.emit({ type: "session.settings.updated", sessionId: this.id, settings: updated });
    return updated;
  }

  async clearQueue(): Promise<SessionQueueState> { this.promptQueue = []; return this.publishQueue(); }

  async suspend(): Promise<void> { await this.closeRuntime(); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; await this.closeRuntime(); }
  private async closeRuntime(): Promise<void> {
    const connection = this.connection; const child = this.child; const sessionId = this.nativeSessionId;
    this.connection = null; this.child = null;
    this.finishOpenCodeChildSessions(this.cancelled ? "cancelled" : "disconnected");
    if (this.promptQueue.length) { this.promptQueue = []; this.publishQueue(); }
    if (connection && sessionId && this.sessionCapabilities.close) await connection.agent.request(methods.agent.session.close, { sessionId }).catch(() => undefined);
    connection?.close();
    if (child && child.exitCode === null) child.kill();
    this.finishMessage();
    for (const [interactionId, pending] of this.permissions) {
      pending.resolve(null);
      this.emit({ type: "interaction.responded", sessionId: this.id, interactionId, value: null, reason: "interrupted" });
    }
    this.permissions.clear();
    for (const [interactionId, pending] of this.elicitations) {
      pending.resolve({ action: "cancel" });
      this.emit({ type: "interaction.responded", sessionId: this.id, interactionId, value: null, reason: "interrupted" });
    }
    this.elicitations.clear();
    if (this.disposed) this.emit({ type: "session.state", sessionId: this.id, state: "ended" });
  }
}
