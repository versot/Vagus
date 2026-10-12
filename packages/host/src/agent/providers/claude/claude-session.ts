import type { AcpSessionNotification } from "@agentclientprotocol/claude-agent-acp/dist/acp-subagents.js";
import { CreateElicitationRequest, methods, type ClientConnection, type CloseSessionRequest, type CloseSessionResponse, type CreateElicitationResponse, type ForkSessionRequest, type ForkSessionResponse, type LoadSessionRequest, type LoadSessionResponse, type NewSessionRequest, type NewSessionResponse, type PromptRequest, type PromptResponse, type SessionConfigOption, type SessionModeState, type SetSessionConfigOptionRequest, type SetSessionConfigOptionResponse, type SetSessionModeRequest, type SetSessionModeResponse } from "@agentclientprotocol/sdk";
import type { AgentSendResult, AgentSession, SessionStorageReference, StartSessionOptions } from "@vagus/agent-core";
import type { AgentEvent, AgentRuntimeSettings, AgentUsage, BrowserElementReference, InteractionResponse, MessageAttachment, SessionId, SessionQueueState } from "@vagus/protocol";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { normalizeClaudeCommands } from "./commands.js";
import { browserContext, imageContent } from "./content.js";
import { elicitationField, validElicitationContent } from "./elicitation.js";
import { ClaudeCliNoticeFilter } from "./gateway-notice.js";
import { openAcpConnection } from "./runtime.js";
import { configSelectOptions, isClaudeConfigOptionApplied, settingsFrom } from "./settings.js";
import { cancelClaudeSubagent, parentToolCallIdFromMeta, readClaudeTerminalExit, readClaudeTerminalOutput, subagentState } from "./subagents.js";
import { type PendingPermission, type PendingPrompt } from "./types.js";
import { isObject, withTimeout } from "./utils.js";

export class ClaudeAcpSession implements AgentSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private nativeSessionId: string | undefined;
  private modeState: SessionModeState | null = null;
  private disposed = false;
  private activePrompt = false;
  private activePromptInFlight = false;
  private suppressLoadedHistory = false;
  private cancelRequested = false;
  private promptQueue: PendingPrompt[] = [];
  private steeringSupported = false;
  private currentMessageId: string | null = null;
  private activeRootMessageId: string | null = null;
  private readonly cliNoticeFilter = new ClaudeCliNoticeFilter();
  private agentActivityText: string | null = null;
  private toolStates = new Map<string, string>();
  private terminalOutputs = new Map<string, string>();
  private terminalExitCodes = new Map<string, number | null>();
  private subagents = new Map<string, { name: string; task: string; cancellable: boolean; state: "running" | "idle" | "requires_action" | "unknown" | "completed" | "failed" | "cancelled" | "disconnected" }>();

  private permissions = new Map<string, PendingPermission>();
  private elicitations = new Map<string, { resolve: (response: CreateElicitationResponse) => void; params: CreateElicitationRequest }>();
  private urlElicitations = new Map<string, string>();
  private configOptions: SessionConfigOption[] = [];
  private commands: import("@vagus/protocol").AgentCommandInfo[] = [];
  private planEntries: Array<{ content: string; status: string }> | null = null;
  private activeCompactionId: string | null = null;
  private readonly finishedCompactionIds = new Set<string>();
  private settings: AgentRuntimeSettings = { providerId: "claude", modelId: null, thinkingLevel: null, thinkingLevels: [] };

  constructor(private readonly options: StartSessionOptions, private readonly emit: (event: AgentEvent) => void) {
    this.nativeSessionId = options.resumeReference?.sessionId;
    this.suppressLoadedHistory = Boolean(this.nativeSessionId);
  }

  get id(): SessionId { return this.options.sessionId ?? "" as SessionId; }
  get available(): boolean { return !this.disposed && Boolean(this.connection); }
  get storageReference(): SessionStorageReference | undefined { return this.nativeSessionId ? { sessionId: this.nativeSessionId } : undefined; }

  async start(): Promise<void> {
    if (this.disposed) throw new Error("Claude ACP session is closed");
    const cwd = this.options.workingDirectory || homedir();
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`Claude Code 工作目录不存在或无法访问：${cwd}。请检查项目目录是否已移动、删除或断开。`);
    }
    const opened = await openAcpConnection(async (params) => {
      const interactionId = randomUUID();
      const kindLabels: Record<string, string> = { allow_once: "允许一次", allow_always: "始终允许", reject_once: "拒绝一次", reject_always: "始终拒绝" };
      const labelCounts = new Map<string, number>();
      const options = params.options.map((option) => {
        const baseLabel = option.name.trim() || kindLabels[option.kind] || option.kind;
        const duplicateCount = labelCounts.get(baseLabel) ?? 0;
        labelCounts.set(baseLabel, duplicateCount + 1);
        return { optionId: option.optionId, kind: option.kind, label: duplicateCount ? `${baseLabel} (${duplicateCount + 1})` : baseLabel };
      });
      const allowed = new Promise<string | null>((resolve) => this.permissions.set(interactionId, { resolve, options }));
      const details = [params.toolCall.title, params.toolCall.rawInput ? JSON.stringify(params.toolCall.rawInput).slice(0, 800) : ""].filter(Boolean).join("\n");
      this.emit({ type: "interaction.requested", sessionId: this.id, interactionId, interaction: { kind: "choice", title: params.toolCall.name ?? "Claude Code 工具权限", message: details, options: options.map((option) => option.label), optionHints: params.options.map((option) => kindLabels[option.kind] ?? option.kind) } });
      const optionId = await allowed;
      return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
    }, (params) => this.onUpdate(params), async (params) => {
      if (!("sessionId" in params) || typeof params.sessionId !== "string" || (params.sessionId !== this.nativeSessionId && !this.subagents.has(params.sessionId))) return { action: "decline" };
      const interactionId = randomUUID();
      const response = new Promise<CreateElicitationResponse>((resolve) => this.elicitations.set(interactionId, { resolve, params }));
      if (CreateElicitationRequest.isUrl(params)) {
        let authorizationUrl: URL;
        try { authorizationUrl = new URL(params.url); }
        catch { this.elicitations.delete(interactionId); return { action: "decline" }; }
        const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(authorizationUrl.hostname.toLowerCase());
        if ((authorizationUrl.protocol !== "https:" && !(authorizationUrl.protocol === "http:" && isLoopback)) || authorizationUrl.username || authorizationUrl.password || !authorizationUrl.hostname) {
          this.elicitations.delete(interactionId);
          return { action: "decline" };
        }
        this.urlElicitations.set(params.elicitationId, interactionId);
        this.emit({ type: "interaction.requested", sessionId: this.id, interactionId, interaction: { kind: "url-consent", message: params.message, url: authorizationUrl.href, host: authorizationUrl.host } });
        return response;
      }
      if (!CreateElicitationRequest.isForm(params)) {
        this.elicitations.delete(interactionId);
        return { action: "decline" };
      }
      const schema = params.requestedSchema as import("@agentclientprotocol/sdk").ElicitationSchema;
      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties ?? {}).map(([id, property]) => elicitationField(id, property, required.has(id)));
      this.emit({ type: "interaction.requested", sessionId: this.id, interactionId, interaction: { kind: "form", title: schema.title ?? undefined, message: schema.description ?? params.message, fields } });
      return response;
    }, (elicitationId) => {
      const interactionId = this.urlElicitations.get(elicitationId);
      if (!interactionId) return;
      this.urlElicitations.delete(elicitationId);
      this.emit({ type: "notification", sessionId: this.id, level: "info", message: "MCP 服务网页登录授权已完成" });
    }, (message) => {
      this.emit({ type: "provider.error", sessionId: this.id, code: "claude_sdk_model_rejected", message, recoverable: true });
      if (this.activePromptInFlight) void this.cancel().catch(() => undefined);
    });
    this.child = opened.child;
    this.connection = opened.connection;
    this.steeringSupported = opened.steeringSupported;
    this.child.once("exit", (code, signal) => {
      if (this.disposed) return;
      this.markSubagentsDisconnected();
      this.connection = null;
      this.promptQueue = [];
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
      this.urlElicitations.clear();
      for (const toolCallId of this.toolStates.keys()) this.finishTool(toolCallId, true, "Claude Code ACP process exited before reporting a result");
      this.emit({ type: "provider.error", sessionId: this.id, code: "claude_acp_exit", message: `Claude Code ACP 已退出 (${signal ?? code ?? "unknown"})`, recoverable: true });
      this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
    });
    if (this.nativeSessionId) {
      const loaded = await withTimeout(this.connection.agent.request<LoadSessionResponse, LoadSessionRequest>(methods.agent.session.load, { sessionId: this.nativeSessionId, cwd, mcpServers: [] }), "恢复 Claude Code 会话超时");
      this.configOptions = loaded.configOptions ?? [];
      this.modeState = loaded.modes ?? null;
    } else {
      const created = await withTimeout(this.connection.agent.request<NewSessionResponse, NewSessionRequest>(methods.agent.session.new, { cwd, mcpServers: [] }), "创建 Claude Code 会话超时");
      this.nativeSessionId = created.sessionId;
      this.configOptions = created.configOptions ?? [];
      this.modeState = created.modes ?? null;
    }
    this.settings = settingsFrom(this.configOptions, undefined, this.modeState);
    this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
  }

  private onUpdate(notification: AcpSessionNotification): void {
    const isRootSession = notification.sessionId === this.nativeSessionId;
    const subagent = this.subagents.get(notification.sessionId);
    if (!isRootSession && !subagent) return;
    const update = notification.update;
    // Host already owns the persisted/imported timeline. session/load replays
    // native messages and tools without their Vagus turn IDs; publishing them
    // as live work moves old tools to the tail and destroys per-turn diffs.
    // Keep suppression until the first prompt so late restore notifications
    // cannot resurrect historical activity either.
    if (this.suppressLoadedHistory && !["available_commands_update", "config_option_update", "current_mode_update", "session_info_update", "usage_update"].includes(update.sessionUpdate)) return;
    switch (update.sessionUpdate) {
      case "agent_thought_chunk":
        this.setAgentActivity(subagent ? `子代理「${subagent.name}」正在思考` : "正在思考");
        break;
      case "agent_message_chunk":
        if (isRootSession) this.setAgentActivity(null);
        else this.setAgentActivity(`子代理「${subagent?.name ?? "Agent"}」正在回复`);
        if (update.content.type === "text") {
          const messageId = subagent && update.messageId ? `${notification.sessionId}:${update.messageId}` : update.messageId;
          if (isRootSession) {
            if (this.activeRootMessageId && messageId && this.activeRootMessageId !== messageId) this.finishMessage();
            if (messageId) this.activeRootMessageId = messageId;
            const filtered = this.cliNoticeFilter.push(update.content.text);
            if (filtered.notice) this.emit({ type: "notification", sessionId: this.id, level: "warning", message: filtered.notice });
            if (filtered.text) this.appendText(filtered.text, messageId);
          } else {
            this.appendText(update.content.text, messageId);
          }
        }
        break;
      case "tool_call": {
        if (isRootSession) this.setAgentActivity(null);
        const id = update.toolCallId;
        this.toolStates.set(id, "running");
        this.emit({
          type: "tool.started", sessionId: this.id, toolCallId: id,
          name: update.name ?? update.title, title: update.title,
          ...(update.kind ? { toolKind: update.kind } : {}),
          ...(parentToolCallIdFromMeta(update._meta) ? { parentToolCallId: parentToolCallIdFromMeta(update._meta) } : {}),
          ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
          ...(update.content !== undefined ? { content: update.content } : {}),
          ...(update.locations !== undefined ? { locations: update.locations } : {}),
        });
        const terminal = readClaudeTerminalOutput(update as unknown as Record<string, unknown>);
        if (terminal?.data) {
          this.terminalOutputs.set(id, terminal.data);
          this.emit({ type: "tool.updated", sessionId: this.id, toolCallId: id, output: terminal.data });
        }
        if (update.status === "completed" || update.status === "failed") this.finishTool(id, update.status === "failed", update.rawOutput);
        break;
      }
      case "tool_call_update": {
        const id = update.toolCallId;
        const output = update.rawOutput;
        const terminal = readClaudeTerminalOutput(update as unknown as Record<string, unknown>);
        const terminalExit = readClaudeTerminalExit(update as unknown as Record<string, unknown>);
        let outputDelta: string | undefined;
        let terminalSnapshot: string | undefined;
        if (terminal) {
          if (terminal.delta) outputDelta = terminal.data;
          else terminalSnapshot = terminal.data;
          this.terminalOutputs.set(id, terminal.delta ? `${this.terminalOutputs.get(id) ?? ""}${terminal.data}` : terminal.data);
          if (terminal.exitCode !== undefined) this.terminalExitCodes.set(id, terminal.exitCode);
        }
        if (terminalExit) this.terminalExitCodes.set(id, terminalExit.exitCode);
        if (update.name !== undefined || update.title !== undefined || update.kind !== undefined || update.rawInput !== undefined || update.content !== undefined || update.locations !== undefined || output !== undefined || outputDelta !== undefined || terminalSnapshot !== undefined || terminalExit !== undefined) this.emit({
          type: "tool.updated",
          sessionId: this.id,
          toolCallId: id,
          ...(parentToolCallIdFromMeta(update._meta) ? { parentToolCallId: parentToolCallIdFromMeta(update._meta) } : {}),
          ...(update.name !== undefined ? { name: update.name ?? undefined } : {}),
          ...(update.title !== undefined ? { title: update.title ?? undefined } : {}),
          ...(update.kind !== undefined ? { toolKind: update.kind ?? undefined } : {}),
          ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
          ...(update.content !== undefined ? { content: update.content } : {}),
          ...(update.locations !== undefined ? { locations: update.locations } : {}),
          ...(terminalSnapshot !== undefined ? { output: terminalSnapshot } : output !== undefined ? { output } : {}),
          ...(outputDelta !== undefined ? { outputDelta } : {}),
          ...(terminalExit !== undefined ? { terminalExitCode: terminalExit.exitCode } : terminal?.exitCode !== undefined ? { terminalExitCode: terminal.exitCode } : {}),
        });
        if (update.status === "completed" || update.status === "failed") this.finishTool(id, update.status === "failed", output);
        break;
      }
      case "subagent_update": {
        const childId = update.sessionId;
        const previous = this.subagents.get(childId);
        const cancelAllowed = isObject(update.capabilities) && isObject(update.capabilities.cancel);
        const child = {
          name: update.title === null ? "Agent" : typeof update.title === "string" ? update.title : previous?.name ?? "Agent",
          task: update.description === null ? "" : typeof update.description === "string" ? update.description : previous?.task ?? "",
          cancellable: update.capabilities === null ? false : update.capabilities === undefined ? previous?.cancellable ?? false : cancelAllowed,
          state: update.state === null ? "unknown" : update.state ? subagentState(update.state.state) : previous?.state ?? "running",
        };
        const state = update.state?.state;
        this.subagents.set(childId, child);
        this.emit({ type: "ui.status", sessionId: this.id, key: `claude-subagent:${childId}`, text: this.subagentStatusText(child), subagentSessionId: childId, subagentCancellable: child.cancellable, subagentState: child.state });
        if (state === "running") {
          this.setAgentActivity(`子代理「${child.name}」正在运行${child.task ? `：${child.task}` : ""}`);
        } else if (state === "idle") {
          this.setAgentActivity(`子代理「${child.name}」已准备好`);
        } else if (state && !["idle", "requires_action", "unknown"].includes(state)) {
          const stateText = state === "completed" ? "已完成" : state === "failed" ? "执行失败" : state === "cancelled" ? "已取消" : state === "disconnected" ? "连接中断" : `状态：${state}`;
          this.setAgentActivity(`子代理「${child.name}」${stateText}`);
        } else if (state === "requires_action") {
          this.setAgentActivity(`子代理「${child.name}」等待用户操作`);
        }
        break;
      }
      case "subagent_spawned": {
        const child = { name: update.name, task: update.task, cancellable: isObject(update.capabilities) && update.capabilities.cancel === true, state: "running" as const };
        this.subagents.set(update.subagentSessionId, child);
        this.emit({ type: "ui.status", sessionId: this.id, key: `claude-subagent:${update.subagentSessionId}`, text: this.subagentStatusText(child), subagentSessionId: update.subagentSessionId, subagentCancellable: child.cancellable, subagentState: child.state });
        this.setAgentActivity(`子代理「${update.name}」已启动：${update.task}`);
        break;
      }
      case "subagent_state_update": {
        const child = this.subagents.get(update.subagentSessionId);
        if (!child) break;
        const stateText = update.state === "completed" ? "已完成" : update.state === "failed" ? "执行失败" : update.state === "cancelled" ? "已取消" : "连接中断";
        const next = { ...child, state: subagentState(update.state) };
        this.subagents.set(update.subagentSessionId, next);
        this.emit({ type: "ui.status", sessionId: this.id, key: `claude-subagent:${update.subagentSessionId}`, text: this.subagentStatusText(next), subagentSessionId: update.subagentSessionId, subagentCancellable: next.cancellable, subagentState: next.state });
        this.setAgentActivity(`子代理「${child.name}」${stateText}`);
        break;
      }
      case "session_message":
      case "session_message_chunk": {
        const text = Array.isArray(update.content)
          ? update.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")
          : "";
        if (text) this.setAgentActivity(`子代理通信：${text.slice(0, 240)}`);
        break;
      }
      case "config_option_update":
        this.configOptions = update.configOptions;
        this.settings = settingsFrom(this.configOptions, this.settings, this.modeState);
        this.emit({ type: "session.settings.updated", sessionId: this.id, settings: this.getSettingsSnapshot() });
        break;
      case "current_mode_update":
        this.modeState = this.modeState ? { ...this.modeState, currentModeId: update.currentModeId } : null;
        this.settings = settingsFrom(this.configOptions, this.settings, this.modeState);
        this.emit({ type: "session.settings.updated", sessionId: this.id, settings: this.getSettingsSnapshot() });
        break;
      case "available_commands_update": {
        this.commands = normalizeClaudeCommands(update.availableCommands);
        this.emit({ type: "session.commands.updated", sessionId: this.id, commands: this.commands });
        break;
      }
      case "plan":
        this.planEntries = update.entries.map(({ content, status }) => ({ content, status }));
        this.publishPlanStatus();
        break;
      case "plan_update":
        if (update.plan.type === "items") {
          this.planEntries = update.plan.entries.map(({ content, status }) => ({ content, status }));
          this.publishPlanStatus();
        } else {
          this.emit({ type: "ui.status", sessionId: this.id, key: "agent-activity", text: "Claude Code 正在更新执行计划" });
        }
        break;
      case "plan_removed":
        this.planEntries = null;
        this.setAgentActivity(null);
        break;
      case "session_info_update":
        if (update.title) this.emit({ type: "ui.title", sessionId: this.id, title: update.title });
        break;
      case "usage_update": {
        const usage: AgentUsage = {
          contextWindowUsedTokens: update.used,
          ...(update.size > 0 ? { contextWindowMaxTokens: update.size } : {}),
          ...(update.cost?.currency === "USD" ? { totalCostUsd: update.cost.amount } : {}),
        };
        this.emit({ type: "session.usage.updated", sessionId: this.id, usage });
        break;
      }
      case "notice":
        this.emit({ type: "notification", sessionId: this.id, level: update.severity === "error" ? "error" : update.severity === "warning" ? "warning" : "info", message: `${update.title}${update.description ? `\n${update.description}` : ""}` });
        break;
      case "compaction_update":
        if (update.status === "in_progress") {
          if (!this.finishedCompactionIds.has(update.compactionId) && this.activeCompactionId !== update.compactionId) {
            this.activeCompactionId = update.compactionId;
            this.emit({ type: "session.compaction", sessionId: this.id, state: "started", reason: update.status });
          }
        } else if (this.activeCompactionId === update.compactionId) {
          this.activeCompactionId = null;
          this.finishedCompactionIds.add(update.compactionId);
          this.emit({ type: "session.compaction", sessionId: this.id, state: "completed", reason: update.status });
        }
        break;
      default:
        break;
    }
  }

  private publishPlanStatus(): void {
    const entries = this.planEntries;
    if (!entries?.length) {
      this.setAgentActivity(null);
      return;
    }
    const completed = entries.filter((entry) => entry.status === "completed").length;
    const current = entries.find((entry) => entry.status === "in_progress");
    const detail = current?.content ? ` · ${current.content}` : "";
    this.setAgentActivity(`计划进度 ${completed}/${entries.length}${detail}`);
  }

  private setAgentActivity(text: string | null): void {
    if (this.agentActivityText === text) return;
    this.agentActivityText = text;
    this.emit({ type: "ui.status", sessionId: this.id, key: "agent-activity", text });
  }

  private subagentStatusText(child: { name: string; task: string; state: string }): string {
    const state = child.state === "running" ? "运行中" : child.state === "idle" ? "空闲" : child.state === "requires_action" ? "等待用户操作" : child.state === "unknown" ? "状态未知" : child.state === "completed" ? "已完成" : child.state === "failed" ? "执行失败" : child.state === "cancelled" ? "已取消" : "连接中断";
    return `${child.name} · ${state}${child.task ? `：${child.task}` : ""}`;
  }

  private markSubagentsDisconnected(): void {
    for (const [subagentSessionId, child] of this.subagents) {
      if (child.state === "completed" || child.state === "failed" || child.state === "cancelled" || child.state === "disconnected") continue;
      const disconnected = { ...child, state: "disconnected" as const, cancellable: false };
      this.subagents.set(subagentSessionId, disconnected);
      this.emit({ type: "ui.status", sessionId: this.id, key: `claude-subagent:${subagentSessionId}`, text: this.subagentStatusText(disconnected), subagentSessionId, subagentCancellable: false, subagentState: "disconnected" });
    }
  }

  async cancelSubagent(subagentSessionId: string): Promise<void> {
    await cancelClaudeSubagent(this.connection, this.subagents, subagentSessionId, this.disposed);
  }

  private appendText(text: string, messageId?: string | null): void {
    if (!text) return;
    if (!this.currentMessageId || (messageId && this.currentMessageId !== messageId)) {
      this.finishMessage();
      this.currentMessageId = messageId || randomUUID();
      this.emit({ type: "message.started", sessionId: this.id, messageId: this.currentMessageId, role: "assistant" });
    }
    this.emit({ type: "message.delta", sessionId: this.id, messageId: this.currentMessageId, text });
  }

  private finishMessage(): void {
    const trailing = this.cliNoticeFilter.flush().text;
    if (trailing) {
      if (this.currentMessageId) this.emit({ type: "message.delta", sessionId: this.id, messageId: this.currentMessageId, text: trailing });
      else this.appendText(trailing, this.activeRootMessageId);
    }
    this.activeRootMessageId = null;
    if (!this.currentMessageId) return;
    this.emit({ type: "message.completed", sessionId: this.id, messageId: this.currentMessageId });
    this.currentMessageId = null;
  }

  private finishTool(id: string, isError: boolean, output?: unknown): void {
    if (!this.toolStates.has(id)) return;
    this.toolStates.delete(id);
    const terminalOutput = this.terminalOutputs.get(id);
    this.terminalOutputs.delete(id);
    const terminalExitCode = this.terminalExitCodes.get(id);
    this.terminalExitCodes.delete(id);
    this.emit({ type: "tool.completed", sessionId: this.id, toolCallId: id, isError, ...(output !== undefined ? { output } : terminalOutput !== undefined ? { output: terminalOutput } : {}), ...(terminalExitCode !== undefined ? { terminalExitCode } : {}) });
  }

  async sendText(text: string, attachments: MessageAttachment[] = [], deliveryMode: "immediate" | "steer" | "follow-up" = "immediate", clientMessageId?: string, browserElements: BrowserElementReference[] = []): Promise<AgentSendResult> {
    if (this.disposed || !this.connection || !this.nativeSessionId) throw new Error("Claude ACP session is unavailable");
    if (!text.trim() && !attachments.length && !browserElements.length) throw new Error("Message must not be empty");
    const displayText = text.trim() || (attachments.length ? "请查看附件中的图片。" : "请分析我选中的网页元素。");
    const enrichedText = `${displayText}${browserContext(browserElements)}`;
    const messageId = randomUUID();
    const queued = this.activePrompt && deliveryMode !== "immediate";
    const promptItem: PendingPrompt = {
      prompt: enrichedText,
      attachments,
      ...(clientMessageId ? { clientMessageId } : {}),
      messageId,
      ...(queued ? { displayText, browserElements, queuedMode: deliveryMode } : {}),
    };

    if (queued && deliveryMode === "steer" && this.steeringSupported && this.connection && this.nativeSessionId) {
      const prompt = [{ type: "text" as const, text: enrichedText }, ...attachments.map(imageContent).filter((block): block is NonNullable<typeof block> => Boolean(block))];
      try {
        const response = await this.connection.agent.request<{ outcome?: string }, PromptRequest>("_session/steering", {
          sessionId: this.nativeSessionId,
          prompt,
          _meta: { steering: { idleBehavior: "promptRequired" } },
        });
        if (response.outcome === "injected") {
          this.emitUserMessage(messageId, displayText, attachments, browserElements, clientMessageId);
          return { disposition: "handled" };
        }
      } catch (error) {
        // A CLI can advertise the bridge but still run an older command build.
        // In that case keep the message safe and deliver it as a follow-up.
        if (!/method not found|unknown method|not supported/iu.test(error instanceof Error ? error.message : String(error))) throw error;
        this.steeringSupported = false;
        this.emit({ type: "notification", sessionId: this.id, level: "warning", message: "当前 Claude Code 不支持任务转向，这条消息已排到当前回复之后" });
      }
    } else if (queued && deliveryMode === "steer" && !this.steeringSupported) {
      this.emit({ type: "notification", sessionId: this.id, level: "warning", message: "当前 Claude Code 不支持任务转向，这条消息已排到当前回复之后" });
    }

    if (!queued) this.emitUserMessage(messageId, displayText, attachments, browserElements, clientMessageId);
    this.promptQueue.push(promptItem);
    this.publishQueue();
    void this.drainPrompts();
    return { disposition: queued ? "queued" : "submitted" };
  }

  private emitUserMessage(messageId: string, displayText: string, attachments: MessageAttachment[], browserElements: BrowserElementReference[], clientMessageId?: string): void {
    this.emit({ type: "message.started", sessionId: this.id, messageId, role: "user", attachments, browserElements, ...(clientMessageId ? { clientMessageId } : {}) });
    this.emit({ type: "message.delta", sessionId: this.id, messageId, text: displayText });
    this.emit({ type: "message.completed", sessionId: this.id, messageId });
  }

  private publishQueue(): SessionQueueState {
    const queue: SessionQueueState = {
      steering: this.promptQueue.filter((item) => item.queuedMode === "steer").map((item) => item.displayText ?? item.prompt),
      followUp: this.promptQueue.filter((item) => item.queuedMode === "follow-up").map((item) => item.displayText ?? item.prompt),
    };
    this.emit({ type: "session.queue.updated", sessionId: this.id, queue });
    return queue;
  }

  private async drainPrompts(): Promise<void> {
    if (this.activePrompt || this.disposed) return;
    this.activePrompt = true;
    while (this.promptQueue.length && !this.disposed && this.connection && this.nativeSessionId) {
      const item = this.promptQueue.shift()!;
      try {
        this.publishQueue();
        if (item.displayText !== undefined) this.emitUserMessage(item.messageId ?? randomUUID(), item.displayText, item.attachments, item.browserElements ?? [], item.clientMessageId);
        const prompt = [{ type: "text" as const, text: item.prompt }, ...item.attachments.map(imageContent).filter((block): block is NonNullable<typeof block> => Boolean(block))];
        this.suppressLoadedHistory = false;
        this.emit({ type: "session.state", sessionId: this.id, state: "running" });
        this.activePromptInFlight = true;
        const response = await this.connection.agent.request<PromptResponse, PromptRequest>(methods.agent.session.prompt, { sessionId: this.nativeSessionId, prompt });
        this.activePromptInFlight = false;
        this.finishMessage();
        this.setAgentActivity(null);
        this.cancelRequested = false;
        if (response.stopReason === "cancelled") this.emit({ type: "notification", sessionId: this.id, level: "info", message: "Claude Code 已停止当前任务" });
        this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
        if (response.stopReason === "cancelled") item.reject?.(new Error("Claude Code 已停止上下文压缩"));
        else item.resolve?.();
      } catch (error) {
        this.activePromptInFlight = false;
        this.finishMessage();
        this.setAgentActivity(null);
        const message = error instanceof Error ? error.message : String(error);
        const wasCancelled = this.cancelRequested;
        this.cancelRequested = false;
        if (wasCancelled) {
          // Some bridge failures can reject a prompt after the cancel
          // notification. Preserve the native session and treat that rejection
          // as a normal user cancellation.
          this.emit({ type: "notification", sessionId: this.id, level: "info", message: "Claude Code 已停止当前任务" });
        } else {
          this.emit({ type: "provider.error", sessionId: this.id, code: "claude_acp_prompt", message, recoverable: true });
        }
        this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
        item.reject?.(wasCancelled ? new Error("Claude Code 已停止当前任务") : error instanceof Error ? error : new Error(message));
      }
    }
    this.activePrompt = false;
    this.publishQueue();
  }

  async respond(response: InteractionResponse): Promise<void> {
    const elicitation = this.elicitations.get(response.interactionId);
    if (elicitation) {
      this.elicitations.delete(response.interactionId);
      let answer: CreateElicitationResponse = { action: "cancel" };
      if (CreateElicitationRequest.isUrl(elicitation.params)) {
        if (response.value === true) answer = { action: "accept" };
        else {
          answer = { action: "cancel" };
          for (const [id, interactionId] of this.urlElicitations) if (interactionId === response.interactionId) this.urlElicitations.delete(id);
        }
      } else if (CreateElicitationRequest.isForm(elicitation.params) && typeof response.value === "string") {
        try {
          const content: Record<string, string | number | boolean | string[]> = JSON.parse(response.value);
          if (content && typeof content === "object" && !Array.isArray(content) && validElicitationContent(content, elicitation.params)) answer = { action: "accept", content };
        } catch { /* Invalid form response is treated as cancellation. */ }
      }
      elicitation.resolve(answer);
      return;
    }
    const pending = this.permissions.get(response.interactionId);
    if (!pending) throw new Error("这个权限请求已结束");
    this.permissions.delete(response.interactionId);
    const selected = typeof response.value === "string"
      ? pending.options.find((option) => option.label === response.value)?.optionId ?? null
      : response.value === true
        ? pending.options.find((option) => option.kind === "allow_once" || option.kind === "allow_always")?.optionId ?? null
        : pending.options.find((option) => option.kind === "reject_once" || option.kind === "reject_always")?.optionId ?? null;
    pending.resolve(selected);
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.nativeSessionId || this.disposed) return;
    const cancelled = new Error("Claude Code 已停止上下文压缩");
    for (const item of this.promptQueue) item.reject?.(cancelled);
    this.promptQueue = [];
    this.publishQueue();
    // ACP defines session/cancel as a notification, not a request. Sending it
    // through request() makes the bridge answer "Method not found".
    this.cancelRequested = this.activePromptInFlight;
    if (this.activePromptInFlight) {
      await this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.nativeSessionId });
    }
    // A prompt cancellation can prevent the bridge from sending the final
    // tool_call_update. Close any tool activities that were still shown as
    // running so the transcript does not retain a permanently active card.
    for (const toolCallId of this.toolStates.keys()) {
      this.finishTool(toolCallId, false, "Claude Code 已停止当前任务");
    }
    // ACP requires the client to answer an outstanding permission request
    // with `cancelled` when cancelling its prompt. Resolve all pending client
    // interactions as well so the provider cannot remain blocked if an agent
    // does not dismiss them as part of the cancellation notification.
    for (const [interactionId, pending] of this.permissions) {
      this.permissions.delete(interactionId);
      pending.resolve(null);
      this.emit({ type: "interaction.responded", sessionId: this.id, interactionId, value: null, reason: "interrupted" });
    }
    for (const [interactionId, pending] of this.elicitations) {
      this.elicitations.delete(interactionId);
      pending.resolve({ action: "cancel" });
      this.emit({ type: "interaction.responded", sessionId: this.id, interactionId, value: null, reason: "interrupted" });
    }
  }

  async clearQueue(): Promise<SessionQueueState> {
    if (this.disposed) throw new Error("Claude ACP session is closed");
    const retained: PendingPrompt[] = [];
    for (const item of this.promptQueue) {
      if (item.queuedMode) item.reject?.(new Error("Claude Code 待处理消息已清空"));
      else retained.push(item);
    }
    this.promptQueue = retained;
    return this.publishQueue();
  }

  private getSettingsSnapshot(): AgentRuntimeSettings {
    return { ...this.settings, ...(this.settings.availableModes ? { availableModes: this.settings.availableModes.map((mode) => ({ ...mode })) } : {}) };
  }

  async getRuntimeSettings(): Promise<AgentRuntimeSettings> { return this.getSettingsSnapshot(); }

  async compact(instructions?: string): Promise<void> {
    if (this.disposed || !this.connection || !this.nativeSessionId) throw new Error("Claude ACP session is unavailable");
    if (this.activePrompt || this.promptQueue.length) throw new Error("请等待当前回复完成后再压缩上下文");
    const customInstructions = instructions?.trim();
    const prompt = customInstructions ? `/compact ${customInstructions}` : "/compact";
    await new Promise<void>((resolve, reject) => {
      this.promptQueue.push({ prompt, attachments: [], resolve, reject });
      void this.drainPrompts();
    });
  }

  async getCommands(): Promise<import("@vagus/protocol").AgentCommandInfo[]> { return [...this.commands]; }

  async forkAfterAssistantMessage(text: string, occurrence: number, messageId?: string): Promise<SessionStorageReference> {
    if (this.disposed || !this.connection || !this.nativeSessionId) throw new Error("Claude ACP session is unavailable");
    if (!messageId) throw new Error("Claude Code 分支缺少助手消息标识");
    if (!Number.isInteger(occurrence) || occurrence < 0) throw new Error("助手消息位置无效");
    const messageFingerprint = `sha256:${createHash("sha256").update(text).digest("hex")}`;
    const forked = await this.connection.agent.request<ForkSessionResponse, ForkSessionRequest>(methods.agent.session.fork, {
      sessionId: this.nativeSessionId,
      cwd: this.options.workingDirectory || homedir(),
      mcpServers: [],
      _meta: {
        jetbrains: {
          air: {
            fork: { version: 1, messageId, messageFingerprint, messageOccurrence: occurrence + 1 },
          },
        },
      },
    });
    if (!forked.sessionId || forked.sessionId === this.nativeSessionId) throw new Error("Claude Code 没有创建独立的分支会话");
    return { sessionId: forked.sessionId };
  }

  private async setConfig(category: "model" | "thought_level", value: string): Promise<AgentRuntimeSettings> {
    if (this.disposed || !this.connection || !this.nativeSessionId) throw new Error("Claude ACP session is unavailable");
    const option = this.configOptions.find((item) => item.category === category);
    if (!option || option.type !== "select" || !configSelectOptions(option).some((item) => item.value === value)) throw new Error(`Claude Code 不支持此${category === "model" ? "模型" : "思考程度"}`);
    const response = await this.connection.agent.request<SetSessionConfigOptionResponse, SetSessionConfigOptionRequest>(methods.agent.session.setConfigOption, { sessionId: this.nativeSessionId, configId: option.id, value });
    if (!isClaudeConfigOptionApplied(response.configOptions, option.id, value)) throw new Error(`Claude Code 未能应用所选${category === "model" ? "模型" : "思考程度"}，当前设置未改变`);
    this.configOptions = response.configOptions;
    this.settings = settingsFrom(this.configOptions, this.settings, this.modeState);
    return this.getSettingsSnapshot();
  }

  async setModel(modelId: string): Promise<AgentRuntimeSettings> { return this.setConfig("model", modelId); }
  async setThinkingLevel(level: string): Promise<AgentRuntimeSettings> { return this.setConfig("thought_level", level); }

  async setMode(modeId: string): Promise<AgentRuntimeSettings> {
    if (this.disposed || !this.connection || !this.nativeSessionId) throw new Error("Claude ACP session is unavailable");
    if (!this.modeState?.availableModes.some((mode) => mode.id === modeId)) throw new Error("Claude Code 不支持此会话模式");
    await this.connection.agent.request<SetSessionModeResponse, SetSessionModeRequest>(methods.agent.session.setMode, { sessionId: this.nativeSessionId, modeId });
    if (this.modeState) this.modeState = { ...this.modeState, currentModeId: modeId };
    this.settings = settingsFrom(this.configOptions, this.settings, this.modeState);
    return this.getSettingsSnapshot();
  }

  private async closeRuntime(preserveSession: boolean): Promise<void> {
    const connection = this.connection;
    const child = this.child;
    this.markSubagentsDisconnected();
    this.connection = null;
    this.child = null;
    if (connection && this.nativeSessionId) {
      await connection.agent.request<CloseSessionResponse, CloseSessionRequest>(methods.agent.session.close, { sessionId: this.nativeSessionId }).catch(() => undefined);
    }
    connection?.close();
    child?.kill();
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
    if (!preserveSession) this.emit({ type: "session.state", sessionId: this.id, state: "ended" });
  }

  async suspend(): Promise<void> { await this.closeRuntime(true); }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const stopped = new Error("Claude ACP session was closed");
    for (const item of this.promptQueue) item.reject?.(stopped);
    this.promptQueue = [];
    await this.closeRuntime(false);
  }
}
