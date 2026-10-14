import type { AgentSendResult, AgentSession, SessionStorageReference, StartSessionOptions } from "@vagus/agent-core";
import type {
  AgentCommandInfo,
  AgentEvent,
  AgentRuntimeSettings,
  AgentUsage,
  InteractionResponse,
  MessageAttachment,
  SessionId,
  SessionQueueState,
  SessionTimelineEntry,
} from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorkspaceFileSnapshot,
  diffWorkspaceFileSnapshots,
  type WorkspaceFileSnapshot,
} from "../../../workspace/turn-diff.js";
import { CODEX_PERMISSION_MODES, codexCommands } from "./commands.js";
import {
  codexGeneratedImage,
  mapCodexFileChangeDiffs,
  mapCodexMcpToolProgressMessage,
  mapCodexMcpToolResult,
  mapCodexThreadTokenUsage,
  mapCodexTurnDiff,
  mapCodexTurnPlan,
} from "./events.js";
import { readCodexTimeline } from "./history.js";
import {
  codexInteractionCancellationResponse,
  mapCodexElicitationRequest,
  mapCodexElicitationResponse,
  mapCodexUserInputAnswers,
  mapCodexUserInputQuestions,
} from "./interactions.js";
import { CodexAppServer } from "./runtime.js";
import {
  type JsonRecord,
  type PendingCompaction,
  type PendingInteraction,
  type QueuedTurn,
  type RpcId,
} from "./types.js";
import { isRecord, safeError } from "./utils.js";

export class CodexSession implements AgentSession {
  private rpc: CodexAppServer | null = null;
  private nativeThreadId: string | undefined;
  private disposed = false;
  private activeTurn = false;
  private cancelRequested = false;
  private currentModelId: string | null = null;
  private thinkingLevel: string | null = null;
  private thinkingLevels: string[] = [];
  private permissionProfileId: string | null = null;
  private availableModels = new Map<string, string[]>();
  private availableServiceTiersByModel = new Map<string, Set<string>>();
  private queue: QueuedTurn[] = [];
  private interactions = new Map<string, PendingInteraction>();
  private toolItems = new Map<string, { name: string; input?: unknown }>();
  private messages = new Map<string, boolean>();
  private messageTurnIds = new Map<string, string>();
  private attachmentFiles = new Set<string>();
  private pendingCompaction: PendingCompaction | null = null;
  private latestUsage: AgentUsage | null = null;
  private currentServiceTier: string | null = null;
  private availableServiceTiers = new Set<string>();
  private currentGoal: AgentRuntimeSettings["goal"] = null;
  private turnWorkspaceSnapshot?: WorkspaceFileSnapshot;
  private turnHasNativeDiff = false;

  constructor(
    private readonly options: StartSessionOptions,
    private readonly emit: (event: AgentEvent) => void,
    private readonly executable: string,
  ) {
    this.nativeThreadId = options.resumeReference?.threadId;
  }

  get id(): SessionId {
    return this.options.sessionId ?? ("" as SessionId);
  }
  get available(): boolean {
    return !this.disposed && Boolean(this.rpc);
  }
  get storageReference(): SessionStorageReference | undefined {
    return this.nativeThreadId ? { threadId: this.nativeThreadId } : undefined;
  }

  async readHistory(knownEntryIds: readonly string[] = []): Promise<SessionTimelineEntry[]> {
    if (this.disposed || !this.rpc || !this.nativeThreadId) throw new Error("Codex 会话不可用");
    return readCodexTimeline(this.rpc, this.nativeThreadId, new Date().toISOString(), new Set(knownEntryIds));
  }

  async start(): Promise<void> {
    const cwd = this.options.workingDirectory || homedir();
    if (!existsSync(cwd)) throw new Error(`Codex 工作目录无法访问：${cwd}`);
    this.rpc = new CodexAppServer(this.executable, cwd, "automatic discovery", { automaticDiscovery: true });
    this.rpc.setHandlers({
      notification: (method, params) => this.handleNotification(method, params),
      serverRequest: (id, method, params) => this.handleServerRequest(id, method, params),
      exit: (error) => this.handleExit(error),
    });
    await this.rpc.start();
    if (this.nativeThreadId) {
      const previousThreadId = this.nativeThreadId;
      try {
        const response = await this.rpc.request<unknown>("thread/resume", {
          threadId: previousThreadId,
          cwd,
          excludeTurns: true,
        });
        this.readSettings(response);
      } catch (error) {
        if (!/no rollout found for thread id/iu.test(error instanceof Error ? error.message : String(error)))
          throw error;
        // `thread/start` creates an empty thread that may not have a rollout
        // until its first turn. If Vagus closes before that first turn, create
        // a fresh empty native thread so the draft can still be resumed.
        const response = await this.rpc.request<unknown>("thread/start", { cwd, permissions: ":workspace" });
        this.readSettings(response);
        if (isRecord(response) && isRecord(response.thread) && typeof response.thread.id === "string")
          this.nativeThreadId = response.thread.id;
        await this.rpc.request("thread/delete", { threadId: previousThreadId }).catch(() => undefined);
      }
    } else {
      const response = await this.rpc.request<unknown>("thread/start", { cwd, permissions: ":workspace" });
      this.readSettings(response);
      if (isRecord(response) && isRecord(response.thread) && typeof response.thread.id === "string")
        this.nativeThreadId = response.thread.id;
    }
    if (!this.nativeThreadId) throw new Error("Codex app-server 未返回会话 ID");
    await this.refreshModelOptions();
    await this.refreshGoal();
    this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
    this.emitSettings();
  }

  private async refreshGoal(): Promise<void> {
    if (!this.rpc || !this.nativeThreadId) return;
    try {
      const result: unknown = await this.rpc.request("thread/goal/get", { threadId: this.nativeThreadId });
      const goal = isRecord(result) && isRecord(result.goal) ? result.goal : null;
      this.currentGoal =
        goal && typeof goal.objective === "string"
          ? { objective: goal.objective, status: typeof goal.status === "string" ? goal.status : "active" }
          : null;
      this.emitSettings();
    } catch {
      /* Keep the last known goal state if this app-server version lacks goal lookup. */
    }
  }

  private async refreshModelOptions(): Promise<void> {
    if (!this.rpc) return;
    try {
      const response = await this.rpc.request<unknown>("model/list", { limit: 200, includeHidden: false });
      if (!isRecord(response) || !Array.isArray(response.data)) return;
      this.availableModels.clear();
      this.availableServiceTiersByModel.clear();
      for (const model of response.data) {
        if (!isRecord(model) || model.hidden === true || typeof model.id !== "string") continue;
        const efforts = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.flatMap((item) =>
              isRecord(item) && typeof item.reasoningEffort === "string" ? [item.reasoningEffort] : [],
            )
          : [];
        this.availableModels.set(model.id, efforts);
        const serviceTiers = new Set(
          Array.isArray(model.serviceTiers)
            ? model.serviceTiers.flatMap((tier) => (isRecord(tier) && typeof tier.id === "string" ? [tier.id] : []))
            : [],
        );
        this.availableServiceTiersByModel.set(model.id, serviceTiers);
        if (model.id === this.currentModelId) {
          this.availableServiceTiers = serviceTiers;
        }
      }
      const selected = response.data.find((item) => isRecord(item) && item.id === this.currentModelId);
      if (isRecord(selected) && Array.isArray(selected.supportedReasoningEfforts)) {
        this.thinkingLevels = selected.supportedReasoningEfforts.flatMap((item) =>
          isRecord(item) && typeof item.reasoningEffort === "string" ? [item.reasoningEffort] : [],
        );
      }
    } catch {
      /* Model selector catalog remains available through the provider-level query. */
    }
  }

  private readSettings(value: unknown): void {
    if (!isRecord(value)) return;
    if (typeof value.model === "string") this.currentModelId = value.model;
    this.currentServiceTier = typeof value.serviceTier === "string" ? value.serviceTier : null;
    if (typeof value.reasoningEffort === "string") this.thinkingLevel = value.reasoningEffort;
    else if (typeof value.effort === "string") this.thinkingLevel = value.effort;
    const profile = isRecord(value.activePermissionProfile) ? value.activePermissionProfile : null;
    if (profile && typeof profile.id === "string") this.permissionProfileId = profile.id;
    else if (isRecord(value.sandbox)) {
      this.permissionProfileId =
        value.sandbox.type === "readOnly"
          ? ":read-only"
          : value.sandbox.type === "workspaceWrite"
            ? ":workspace"
            : value.sandbox.type === "dangerFullAccess"
              ? ":danger-full-access"
              : this.permissionProfileId;
    }
    const thread = isRecord(value.thread) ? value.thread : null;
    if (thread && typeof thread.id === "string") this.nativeThreadId = thread.id;
  }

  private emitSettings(): AgentRuntimeSettings {
    const settings: AgentRuntimeSettings = {
      providerId: "codex",
      modelId: this.currentModelId,
      thinkingLevel: this.thinkingLevel,
      thinkingLevels: this.thinkingLevels,
      serviceTier: this.currentServiceTier,
      currentModeId: this.permissionProfileId,
      availableModes: CODEX_PERMISSION_MODES.map(({ id, name }) => ({ id, name })),
      goal: this.currentGoal,
    };
    this.emit({ type: "session.settings.updated", sessionId: this.id, settings });
    return settings;
  }

  async getRuntimeSettings(): Promise<AgentRuntimeSettings> {
    return this.emitSettings();
  }

  async getUsage(): Promise<AgentUsage | null> {
    return this.latestUsage;
  }

  async getCommands(): Promise<AgentCommandInfo[]> {
    if (this.disposed) throw new Error("Codex session is unavailable");
    // The app-server has no native slash-command discovery API. Expose only
    // operations Vagus maps faithfully to native app-server requests.
    return codexCommands();
  }

  async executeCommand(
    action: "goal" | "review" | "mcp-status" | "fast-mode" | "feedback",
    input: string,
  ): Promise<void> {
    if (this.disposed || !this.rpc || !this.nativeThreadId) throw new Error("Codex 会话不可用");
    const isGoalPause = action === "goal" && input.trim().toLowerCase() === "pause";
    if (this.activeTurn && !isGoalPause) throw new Error("请等待当前回复完成后再执行此命令");
    const threadId = this.nativeThreadId;
    const notify = (message: string) => this.emit({ type: "notification", sessionId: this.id, level: "info", message });
    if (action === "goal") {
      const argument = input.trim();
      if (!argument) {
        const result: unknown = await this.rpc.request("thread/goal/get", { threadId });
        const goal = isRecord(result) && isRecord(result.goal) ? result.goal : null;
        await this.refreshGoal();
        notify(
          goal && typeof goal.objective === "string"
            ? `当前目标：${goal.objective}（${String(goal.status ?? "active")}）`
            : "当前会话还没有设置目标。可输入 /goal <目标内容> 设置目标。",
        );
        return;
      }
      if (argument.toLowerCase() === "clear") {
        await this.rpc.request("thread/goal/clear", { threadId, origin: "user" });
        await this.refreshGoal();
        notify("已清除当前会话目标。");
        return;
      }
      if (argument.toLowerCase() === "pause" || argument.toLowerCase() === "resume") {
        const existing: unknown = await this.rpc.request("thread/goal/get", { threadId });
        const goal = isRecord(existing) && isRecord(existing.goal) ? existing.goal : null;
        if (!goal || typeof goal.objective !== "string") throw new Error("当前会话没有可暂停或恢复的目标");
        const status = argument.toLowerCase() === "pause" ? "paused" : "active";
        await this.rpc.request("thread/goal/set", { threadId, origin: "user", status });
        await this.refreshGoal();
        if (status === "paused" && this.activeTurn) await this.cancel();
        notify(status === "paused" ? "已暂停当前会话目标。" : "已恢复当前会话目标。");
        return;
      }
      await this.rpc.request("thread/goal/set", { threadId, origin: "user", objective: argument, status: "active" });
      await this.refreshGoal();
      notify(`已设置会话目标：${argument}`);
      return;
    }
    if (action === "review") {
      const target = input.trim() ? { type: "custom", instructions: input.trim() } : { type: "uncommittedChanges" };
      this.activeTurn = true;
      this.activeTurnId = undefined;
      this.emit({ type: "session.state", sessionId: this.id, state: "running" });
      try {
        const result: unknown = await this.rpc.request(
          "review/start",
          { threadId, target, delivery: "inline" },
          30_000,
        );
        if (isRecord(result) && isRecord(result.turn) && typeof result.turn.id === "string")
          this.activeTurnId = result.turn.id;
      } catch (error) {
        this.activeTurn = false;
        this.activeTurnId = undefined;
        this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
        throw error;
      }
      return;
    }
    if (action === "mcp-status") {
      const result: unknown = await this.rpc.request("mcpServerStatus/list", {
        threadId,
        limit: 100,
        detail: "toolsAndAuthOnly",
      });
      const rows = isRecord(result) && Array.isArray(result.data) ? result.data.filter(isRecord) : [];
      if (!rows.length) {
        notify("当前会话没有可显示的 MCP 服务器。");
        return;
      }
      const summary = rows
        .slice(0, 20)
        .map((server) => {
          const name = typeof server.name === "string" ? server.name : "MCP";
          const runtime = typeof server.runtimeStatus === "string" ? server.runtimeStatus : "状态未知";
          const tools = isRecord(server.tools) ? Object.keys(server.tools).length : 0;
          return `${name}：${runtime}，${tools} 个工具`;
        })
        .join("；");
      notify(`MCP 服务器：${summary}${rows.length > 20 ? `；另有 ${rows.length - 20} 个未展开` : ""}`);
      return;
    }
    if (action === "fast-mode") {
      const fastTier = this.availableServiceTiers.has("fast")
        ? "fast"
        : this.availableServiceTiers.has("priority")
          ? "priority"
          : null;
      if (!fastTier) throw new Error("当前 Codex 模型目录没有公布快速服务档位，无法安全启用");
      const enabled = this.currentServiceTier !== "fast" && this.currentServiceTier !== "priority";
      await this.rpc.request("thread/settings/update", { threadId, serviceTier: enabled ? fastTier : null });
      this.currentServiceTier = enabled ? fastTier : null;
      this.emitSettings();
      notify(enabled ? "已为当前会话启用快速服务档位。" : "已关闭当前会话的快速服务档位。");
      return;
    }
    const reason = input.trim();
    if (!reason) throw new Error("请在 /feedback 后输入反馈内容");
    await this.rpc.request(
      "feedback/upload",
      { classification: "other", reason, threadId, includeLogs: false },
      30_000,
    );
    notify("反馈已提交给 Codex；未附带本地日志。");
  }

  async setModel(modelId: string): Promise<AgentRuntimeSettings> {
    if (!modelId.trim()) throw new Error("Codex 模型 ID 无效");
    const efforts = this.availableModels.get(modelId);
    if (!efforts) throw new Error("该模型不在本机 Codex 模型目录中；请刷新模型列表");
    if (this.disposed || !this.rpc || !this.nativeThreadId) throw new Error("Codex 会话不可用");
    // Codex app-server applies model changes through thread/settings/update.
    // `turn/start` does not accept model/effort overrides, so only updating
    // Vagus state would make the selector disagree with the actual next turn.
    await this.rpc.request("thread/settings/update", { threadId: this.nativeThreadId, model: modelId });
    this.currentModelId = modelId;
    this.availableServiceTiers = this.availableServiceTiersByModel.get(modelId) ?? new Set();
    if (this.currentServiceTier && !this.availableServiceTiers.has(this.currentServiceTier)) {
      await this.rpc.request("thread/settings/update", { threadId: this.nativeThreadId, serviceTier: null });
      this.currentServiceTier = null;
    }
    this.thinkingLevels = efforts;
    if (this.thinkingLevel && !this.thinkingLevels.includes(this.thinkingLevel)) this.thinkingLevel = null;
    return this.emitSettings();
  }

  async setThinkingLevel(level: string): Promise<AgentRuntimeSettings> {
    if (!this.thinkingLevels.includes(level)) throw new Error("本机 Codex 模型不支持此思考程度");
    if (this.disposed || !this.rpc || !this.nativeThreadId) throw new Error("Codex 会话不可用");
    await this.rpc.request("thread/settings/update", { threadId: this.nativeThreadId, effort: level });
    this.thinkingLevel = level;
    return this.emitSettings();
  }

  async setMode(modeId: string): Promise<AgentRuntimeSettings> {
    if (!CODEX_PERMISSION_MODES.some((mode) => mode.id === modeId)) throw new Error("本机 Codex 不支持此权限模式");
    if (this.disposed || !this.rpc || !this.nativeThreadId) throw new Error("Codex 会话不可用");
    await this.rpc.request("thread/settings/update", { threadId: this.nativeThreadId, permissions: modeId });
    this.permissionProfileId = modeId;
    return this.emitSettings();
  }

  async forkAfterAssistantMessage(
    _text: string,
    occurrence: number,
    messageId?: string,
  ): Promise<SessionStorageReference> {
    if (this.disposed || !this.rpc || !this.nativeThreadId) throw new Error("Codex 会话不可用");
    if (this.activeTurn) throw new Error("请等待 Codex 当前回复完成后再创建分支");
    if (!messageId) throw new Error("Codex 分支缺少助手消息标识");
    if (!Number.isInteger(occurrence) || occurrence < 0) throw new Error("助手消息位置无效");
    const nativeMessageId = messageId.startsWith("codex-") ? messageId.slice("codex-".length) : messageId;
    let turnId = this.messageTurnIds.get(nativeMessageId);
    if (!turnId) turnId = await this.findMessageTurn(nativeMessageId);
    if (!turnId) throw new Error("无法在 Codex 历史中定位这条助手消息对应的 Turn，请刷新会话后重试");
    const result: unknown = await this.rpc.request(
      "thread/fork",
      {
        threadId: this.nativeThreadId,
        lastTurnId: turnId,
        cwd: this.options.workingDirectory || homedir(),
        excludeTurns: true,
      },
      60_000,
    );
    if (
      !isRecord(result) ||
      !isRecord(result.thread) ||
      typeof result.thread.id !== "string" ||
      result.thread.id === this.nativeThreadId
    ) {
      throw new Error("Codex 没有创建独立的分支会话");
    }
    // A fork can be made from an older turn while the user has already chosen
    // a different model/effort for the next turn. Carry the visible selection
    // over explicitly; these are thread settings, not `thread/fork` params.
    try {
      await this.rpc.request("thread/settings/update", {
        threadId: result.thread.id,
        ...(this.currentModelId ? { model: this.currentModelId } : {}),
        ...(this.thinkingLevel ? { effort: this.thinkingLevel } : {}),
      });
    } catch (error) {
      try {
        await this.rpc.request("thread/delete", { threadId: result.thread.id }, 30_000);
      } catch {
        /* Best-effort cleanup of an unusable fork. */
      }
      throw error;
    }
    return { threadId: result.thread.id };
  }

  private async findMessageTurn(messageId: string): Promise<string | undefined> {
    if (!this.rpc || !this.nativeThreadId) return undefined;
    let cursor: string | null = null;
    for (let page = 0; page < 500; page++) {
      const result: unknown = await this.rpc.request("thread/items/list", {
        threadId: this.nativeThreadId,
        limit: 200,
        sortDirection: "asc",
        ...(cursor ? { cursor } : {}),
      });
      if (!isRecord(result) || !Array.isArray(result.data)) throw new Error("Codex 未返回有效的会话历史");
      for (const entry of result.data) {
        if (
          !isRecord(entry) ||
          !isRecord(entry.item) ||
          entry.item.id !== messageId ||
          entry.item.type !== "agentMessage"
        )
          continue;
        if (typeof entry.turnId === "string") return entry.turnId;
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      if (!cursor) return undefined;
    }
    throw new Error("Codex 会话历史过长，暂时无法定位分支点");
  }

  async sendText(
    text: string,
    attachments: MessageAttachment[] = [],
    deliveryMode: "immediate" | "steer" | "follow-up" = "immediate",
    clientMessageId?: string,
  ): Promise<AgentSendResult> {
    if (this.disposed || !this.rpc || !this.nativeThreadId) throw new Error("Codex session is unavailable");
    if (!text.trim() && !attachments.length) throw new Error("Message must not be empty");
    const visibleText = text.trim() || (attachments.length ? "请查看附件中的图片。" : "");
    const turn = { text: visibleText, attachments, ...(clientMessageId ? { clientMessageId } : {}), visibleText };
    const queued = this.activeTurn;
    if (queued) {
      if (deliveryMode === "steer" && this.activeTurnId && (await this.trySteer(turn)))
        return { disposition: "handled" };
      if (deliveryMode === "steer")
        this.emit({
          type: "notification",
          sessionId: this.id,
          level: "warning",
          message: "Codex 当前回复暂不可转向，这条消息已排到当前回复之后。",
        });
      this.queue.push(turn);
      this.publishQueue();
      return { disposition: "queued" };
    }
    await this.startTurn(turn);
    return { disposition: "submitted" };
  }

  private async startTurn(turn: QueuedTurn): Promise<void> {
    if (!this.rpc || !this.nativeThreadId || this.disposed) return;
    this.turnWorkspaceSnapshot = await captureWorkspaceFileSnapshot(this.options.workingDirectory || homedir()).catch(
      () => undefined,
    );
    this.turnHasNativeDiff = false;
    this.activeTurn = true;
    this.activeTurnId = undefined;
    const userMessageId = randomUUID();
    this.emitUserTurn(userMessageId, turn);
    this.emit({ type: "session.state", sessionId: this.id, state: "running" });
    const attachmentPaths: string[] = [];
    try {
      const input = await this.prepareTurnInput(turn, attachmentPaths);
      for (const path of attachmentPaths) this.attachmentFiles.add(path);
      await this.rpc.request(
        "turn/start",
        {
          threadId: this.nativeThreadId,
          input,
          ...(turn.clientMessageId ? { clientUserMessageId: turn.clientMessageId } : {}),
        },
        180_000,
      );
    } catch (error) {
      this.activeTurn = false;
      for (const path of attachmentPaths) this.attachmentFiles.delete(path);
      await this.removeTemporaryAttachments(attachmentPaths);
      this.emit({
        type: "provider.error",
        sessionId: this.id,
        code: "codex_turn_start",
        message: safeError(error).message,
        recoverable: true,
      });
      this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
      await this.drainQueue();
    }
  }

  private emitUserTurn(messageId: string, turn: QueuedTurn): void {
    this.emit({
      type: "message.started",
      sessionId: this.id,
      messageId,
      role: "user",
      attachments: turn.attachments,
      ...(turn.clientMessageId ? { clientMessageId: turn.clientMessageId } : {}),
    });
    this.emit({ type: "message.delta", sessionId: this.id, messageId, text: turn.visibleText });
    this.emit({ type: "message.completed", sessionId: this.id, messageId });
  }

  private async prepareTurnInput(turn: QueuedTurn, attachmentPaths: string[]): Promise<JsonRecord[]> {
    const input: JsonRecord[] = [{ type: "text", text: turn.text, text_elements: [] }];
    for (const attachment of turn.attachments) {
      const match = attachment.dataUrl.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/u);
      if (!match || attachment.size > 16 * 1024 * 1024) {
        this.emit({
          type: "notification",
          sessionId: this.id,
          level: "warning",
          message: `已跳过不支持的附件：${attachment.name}`,
        });
        continue;
      }
      const extension =
        match[1]!
          .split("/")[1]!
          .replace(/[^a-z0-9]/giu, "")
          .slice(0, 8) || "png";
      const path = join(tmpdir(), `vagus-codex-${randomUUID()}.${extension}`);
      await writeFile(path, Buffer.from(match[2]!, "base64"), { flag: "wx" });
      attachmentPaths.push(path);
      input.push({ type: "localImage", path });
    }
    return input;
  }

  private async removeTemporaryAttachments(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map((path) => unlink(path).catch(() => undefined)));
  }

  private finishCompaction(error?: Error): void {
    const pending = this.pendingCompaction;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCompaction = null;
    this.emit({
      type: "session.compaction",
      sessionId: this.id,
      state: "completed",
      ...(error ? { reason: "failed" } : {}),
    });
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private async trySteer(turn: QueuedTurn): Promise<boolean> {
    if (!this.rpc || !this.nativeThreadId || !this.activeTurnId || this.disposed) return false;
    const expectedTurnId = this.activeTurnId;
    const attachmentPaths: string[] = [];
    try {
      const input = await this.prepareTurnInput(turn, attachmentPaths);
      const response: unknown = await this.rpc.request(
        "turn/steer",
        {
          threadId: this.nativeThreadId,
          input,
          expectedTurnId,
          ...(turn.clientMessageId ? { clientUserMessageId: turn.clientMessageId } : {}),
        },
        30_000,
      );
      if (!isRecord(response) || typeof response.turnId !== "string")
        throw new Error("Codex turn/steer 未返回有效的 turnId");
      for (const path of attachmentPaths) this.attachmentFiles.add(path);
      this.activeTurnId = response.turnId;
      this.emitUserTurn(randomUUID(), turn);
      return true;
    } catch (error) {
      await this.removeTemporaryAttachments(attachmentPaths);
      const message = error instanceof Error ? error.message : String(error);
      if (
        /method not found|unknown method|not steerable|cannot be steered|turn.{0,40}(not active|no longer active|expected)/iu.test(
          message,
        )
      )
        return false;
      throw error;
    }
  }

  private publishQueue(): SessionQueueState {
    const queue = { steering: [], followUp: this.queue.map((item) => item.visibleText) };
    this.emit({ type: "session.queue.updated", sessionId: this.id, queue });
    return queue;
  }

  async clearQueue(): Promise<SessionQueueState> {
    this.queue = [];
    return this.publishQueue();
  }

  async compact(instructions?: string): Promise<void> {
    if (instructions?.trim()) throw new Error("Codex 原生压缩不支持自定义指令，请使用默认压缩");
    if (this.disposed || !this.rpc || !this.nativeThreadId) throw new Error("Codex 会话不可用");
    if (this.activeTurn) throw new Error("请等待 Codex 当前回复完成后再压缩上下文");
    if (this.pendingCompaction) throw new Error("Codex 会话正在压缩上下文，请等待完成");
    const rpc = this.rpc;
    const threadId = this.nativeThreadId;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const timer = setTimeout(() => reject(new Error("Codex 上下文压缩超时")), 180_000);
    this.pendingCompaction = { resolve, reject, timer };
    this.emit({ type: "session.compaction", sessionId: this.id, state: "started" });
    try {
      await rpc.request("thread/compact/start", { threadId }, 30_000);
      await completed;
    } catch (error) {
      clearTimeout(timer);
      if (this.pendingCompaction?.resolve === resolve) this.pendingCompaction = null;
      this.emit({ type: "session.compaction", sessionId: this.id, state: "completed", reason: "failed" });
      throw error;
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.activeTurn || this.disposed) return;
    const next = this.queue.shift();
    this.publishQueue();
    if (next) await this.startTurn(next);
  }

  async cancel(): Promise<void> {
    if (!this.rpc || !this.nativeThreadId || !this.activeTurn) return;
    let goalPaused = false;
    let goalPauseError: unknown;
    try {
      const result: unknown = await this.rpc.request("thread/goal/get", { threadId: this.nativeThreadId });
      const goal = isRecord(result) && isRecord(result.goal) ? result.goal : null;
      if (goal?.status === "active") {
        await this.rpc.request("thread/goal/set", { threadId: this.nativeThreadId, origin: "user", status: "paused" });
        goalPaused = true;
        this.currentGoal =
          goal && typeof goal.objective === "string"
            ? { objective: goal.objective, status: "paused" }
            : this.currentGoal;
        this.emitSettings();
      }
    } catch (error) {
      // Always try to stop the active turn even if goal metadata is unavailable.
      goalPauseError = error;
    }
    this.cancelRequested = true;
    const turnId = this.activeTurnId;
    let interruptError: unknown;
    if (turnId) {
      try {
        await this.rpc.request("turn/interrupt", { threadId: this.nativeThreadId, turnId });
      } catch (error) {
        interruptError = error;
      }
    }
    for (const [id, pending] of this.interactions) {
      this.rpc.reply(pending.rpcId, codexInteractionCancellationResponse(pending));
      this.interactions.delete(id);
      this.emit({
        type: "interaction.responded",
        sessionId: this.id,
        interactionId: id,
        value: null,
        reason: "interrupted",
      });
    }
    this.queue = [];
    this.publishQueue();
    if (interruptError && this.activeTurn) {
      this.cancelRequested = false;
      throw new Error(`Codex 当前任务未确认停止：${safeError(interruptError).message}`);
    }
    if (goalPaused)
      this.emit({
        type: "notification",
        sessionId: this.id,
        level: "info",
        message: "已暂停当前 Goal，并请求停止正在运行的任务。",
      });
    if (goalPauseError)
      this.emit({
        type: "notification",
        sessionId: this.id,
        level: "warning",
        message: `已请求停止当前任务，但未能确认 Goal 已暂停：${safeError(goalPauseError).message}`,
      });
  }

  private activeTurnId: string | undefined;

  async respond(response: InteractionResponse): Promise<void> {
    const pending = this.interactions.get(response.interactionId);
    if (!pending || !this.rpc) throw new Error("这个 Codex 权限请求已结束");
    this.interactions.delete(response.interactionId);
    const selected =
      typeof response.value === "string" ? response.value : response.value === true ? pending.labels[0] : null;
    const accepted = response.value === true || response.value === "accept" || selected === pending.labels[0];
    if (pending.method === "mcpServer/elicitation/request") {
      this.rpc.reply(
        pending.rpcId,
        mapCodexElicitationResponse(
          response.value,
          pending.elicitationMode ?? "",
          pending.labels,
          pending.elicitationApprovalPersistence,
        ),
      );
    } else if (pending.method === "item/tool/requestUserInput") {
      const result = pending.questionMappings
        ? mapCodexUserInputAnswers(response.value, pending.questionMappings)
        : { answers: pending.questionId ? { [pending.questionId]: { answers: selected ? [selected] : [] } } : {} };
      this.rpc.reply(pending.rpcId, result);
    } else if (pending.method === "item/permissions/requestApproval") {
      this.rpc.reply(pending.rpcId, { permissions: accepted ? (pending.permissions ?? {}) : {}, scope: "turn" });
    } else {
      this.rpc.reply(pending.rpcId, { decision: accepted ? "accept" : "decline" });
    }
    this.emit({
      type: "interaction.responded",
      sessionId: this.id,
      interactionId: response.interactionId,
      value: response.value,
    });
  }

  private handleServerRequest(id: RpcId, method: string, value: unknown): void {
    const params = isRecord(value) ? value : {};
    const interactionId = randomUUID();
    if (["item/commandExecution/requestApproval", "execCommandApproval"].includes(method)) {
      const command = typeof params.command === "string" ? params.command : "Codex 请求运行命令";
      const cwd = typeof params.cwd === "string" ? params.cwd : this.options.workingDirectory;
      const reason = typeof params.reason === "string" ? params.reason : "Codex 请求执行此命令";
      this.interactions.set(interactionId, { rpcId: id, method, labels: ["允许"] });
      this.emit({
        type: "interaction.requested",
        sessionId: this.id,
        interactionId,
        interaction: {
          kind: "choice",
          title: "Codex 命令审批",
          message: `${command}\n\n工作目录：${cwd}\n${reason}`,
          options: ["允许", "拒绝"],
          optionHints: ["仅按 Codex 当前审批规则处理此命令", "拒绝本次命令"],
        },
      });
      return;
    }
    if (["item/fileChange/requestApproval", "applyPatchApproval"].includes(method)) {
      this.interactions.set(interactionId, { rpcId: id, method, labels: ["允许"] });
      this.emit({
        type: "interaction.requested",
        sessionId: this.id,
        interactionId,
        interaction: {
          kind: "choice",
          title: "Codex 文件变更审批",
          message: typeof params.reason === "string" ? params.reason : "Codex 请求修改文件",
          options: ["允许", "拒绝"],
          optionHints: ["允许这次文件变更", "拒绝本次文件变更"],
        },
      });
      return;
    }
    if (method === "item/permissions/requestApproval") {
      const permissionDetails = isRecord(params.permissions) ? params.permissions : {};
      this.interactions.set(interactionId, { rpcId: id, method, labels: ["允许一次"], permissions: permissionDetails });
      this.emit({
        type: "interaction.requested",
        sessionId: this.id,
        interactionId,
        interaction: {
          kind: "choice",
          title: "Codex 权限请求",
          message: [
            typeof params.reason === "string" ? params.reason : "Codex 请求扩展本次任务的权限",
            `工作目录：${String(params.cwd ?? this.options.workingDirectory)}`,
            JSON.stringify(permissionDetails),
          ].join("\n\n"),
          options: ["允许一次", "拒绝"],
          optionHints: ["仅授予当前 Turn 所需权限", "拒绝本次权限请求"],
        },
      });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions) ? params.questions.filter(isRecord) : [];
      if (questions.length > 1 || (questions.length === 1 && questions[0]?.isOther === true)) {
        const mapped = mapCodexUserInputQuestions(questions);
        if (!mapped) {
          this.rpc?.reject(
            id,
            -32601,
            "Vagus cannot safely collect this Codex input form (secret or invalid fields are not supported)",
          );
          return;
        }
        this.interactions.set(interactionId, { rpcId: id, method, labels: [], questionMappings: mapped.mappings });
        this.emit({
          type: "interaction.requested",
          sessionId: this.id,
          interactionId,
          interaction: mapped.interaction,
        });
        return;
      }
      if (questions.length === 1) {
        const question = questions[0]!;
        if (question.isSecret === true) {
          this.rpc?.reject(
            id,
            -32601,
            "Vagus cannot safely collect secret Codex input because the current input UI does not mask secrets",
          );
          return;
        }
        const options = Array.isArray(question.options)
          ? question.options.flatMap((item) => (isRecord(item) && typeof item.label === "string" ? [item.label] : []))
          : [];
        if (options.length) {
          this.interactions.set(interactionId, {
            rpcId: id,
            method,
            labels: options,
            ...(typeof question.id === "string" ? { questionId: question.id } : {}),
          });
          this.emit({
            type: "interaction.requested",
            sessionId: this.id,
            interactionId,
            interaction: {
              kind: "choice",
              title: typeof question.header === "string" ? question.header : "Codex 需要确认",
              message: typeof question.question === "string" ? question.question : "",
              options,
            },
          });
          return;
        }
        this.interactions.set(interactionId, {
          rpcId: id,
          method,
          labels: [],
          ...(typeof question.id === "string" ? { questionId: question.id } : {}),
        });
        this.emit({
          type: "interaction.requested",
          sessionId: this.id,
          interactionId,
          interaction: {
            kind: "text-input",
            title: typeof question.header === "string" ? question.header : "Codex 需要输入",
            message: typeof question.question === "string" ? question.question : "",
          },
        });
        return;
      }
    }
    if (method === "mcpServer/elicitation/request") {
      const mapped = mapCodexElicitationRequest(params);
      if (!mapped) {
        this.rpc?.reject(id, -32602, "Vagus cannot display this Codex MCP elicitation schema or URL safely");
        return;
      }
      this.interactions.set(interactionId, {
        rpcId: id,
        method,
        labels: mapped.labels,
        elicitationMode: mapped.mode,
        ...(mapped.approvalPersistence ? { elicitationApprovalPersistence: mapped.approvalPersistence } : {}),
      });
      this.emit({ type: "interaction.requested", sessionId: this.id, interactionId, interaction: mapped.interaction });
      return;
    }
    this.rpc?.reject(id, -32601, "This Codex app-server request is not supported by Vagus");
  }

  private handleNotification(method: string, value: unknown): void {
    const params = isRecord(value) ? value : {};
    if (typeof params.threadId === "string" && params.threadId !== this.nativeThreadId) return;
    if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
      void this.refreshGoal();
      return;
    }
    if (method === "thread/name/updated" && typeof params.threadName === "string") {
      this.emit({ type: "ui.title", sessionId: this.id, title: params.threadName });
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = mapCodexThreadTokenUsage(params.tokenUsage);
      if (usage) {
        this.latestUsage = usage;
        this.emit({ type: "session.usage.updated", sessionId: this.id, usage });
      }
      return;
    }
    if (method === "turn/diff/updated") {
      if (typeof params.turnId !== "string") return;
      const diff = mapCodexTurnDiff(params.diff);
      if (diff) {
        if (diff.diff.trim()) this.turnHasNativeDiff = true;
        this.emit({ type: "session.turn.diff.updated", sessionId: this.id, turnId: params.turnId, ...diff });
      }
      return;
    }
    if (method === "turn/plan/updated") {
      const plan = mapCodexTurnPlan(params);
      const turnId = typeof params.turnId === "string" ? params.turnId : this.activeTurnId;
      if (plan && turnId)
        this.emit({ type: "session.plan.updated", sessionId: this.id, planId: `codex-plan-${turnId}`, ...plan });
      return;
    }
    if (method === "item/mcpToolCall/progress" && typeof params.itemId === "string") {
      const message = mapCodexMcpToolProgressMessage(params);
      if (message && this.toolItems.has(params.itemId))
        this.emit({ type: "tool.updated", sessionId: this.id, toolCallId: params.itemId, outputDelta: `${message}\n` });
      return;
    }
    if (
      method === "item/fileChange/patchUpdated" &&
      typeof params.itemId === "string" &&
      this.toolItems.has(params.itemId)
    ) {
      const mapped = mapCodexFileChangeDiffs(params.changes);
      if (mapped)
        this.emit({
          type: "tool.updated",
          sessionId: this.id,
          toolCallId: params.itemId,
          input: mapped.input,
          content: mapped.content,
        });
      return;
    }
    if (method === "turn/started" && isRecord(params.turn) && typeof params.turn.id === "string") {
      this.activeTurnId = params.turn.id;
      if (this.cancelRequested)
        void this.rpc
          ?.request("turn/interrupt", { threadId: this.nativeThreadId, turnId: params.turn.id })
          .catch(() => undefined);
      return;
    }
    if (method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      this.ensureMessage(params.itemId, typeof params.turnId === "string" ? params.turnId : undefined);
      this.emit({ type: "message.delta", sessionId: this.id, messageId: params.itemId, text: params.delta });
      return;
    }
    if (method === "item/started" && isRecord(params.item)) {
      this.startItem(params.item, typeof params.turnId === "string" ? params.turnId : undefined);
      return;
    }
    if (method === "item/completed" && isRecord(params.item)) {
      void this.completeItem(params.item, typeof params.turnId === "string" ? params.turnId : undefined);
      return;
    }
    if (
      method === "item/commandExecution/outputDelta" &&
      typeof params.itemId === "string" &&
      typeof params.delta === "string"
    ) {
      this.emit({ type: "tool.updated", sessionId: this.id, toolCallId: params.itemId, outputDelta: params.delta });
      return;
    }
    if (method === "turn/completed") {
      const turn = isRecord(params.turn) ? params.turn : {};
      void this.completeTurn(turn);
      return;
    }
    if (method === "thread/compacted") {
      if (this.pendingCompaction) this.finishCompaction();
      else this.emit({ type: "session.compaction", sessionId: this.id, state: "completed" });
    }
  }

  private async completeTurn(turn: JsonRecord): Promise<void> {
    const status = turn.status;
    if (!this.turnHasNativeDiff && this.turnWorkspaceSnapshot) {
      try {
        const after = await captureWorkspaceFileSnapshot(this.options.workingDirectory || homedir());
        const changes = diffWorkspaceFileSnapshots(this.turnWorkspaceSnapshot, after);
        if (changes)
          this.emit({
            type: "session.turn.diff.updated",
            sessionId: this.id,
            turnId: this.activeTurnId ?? randomUUID(),
            ...changes,
          });
      } catch {
        /* Filesystem fallback is best effort; Codex's native diff remains authoritative when available. */
      }
    }
    this.turnWorkspaceSnapshot = undefined;
    this.turnHasNativeDiff = false;
    const error =
      isRecord(turn.error) && typeof turn.error.message === "string" ? turn.error.message : "Codex 上下文压缩失败";
    if (status === "failed" && isRecord(turn.error) && typeof turn.error.message === "string")
      this.emit({
        type: "provider.error",
        sessionId: this.id,
        code: "codex_turn_failed",
        message: turn.error.message,
        recoverable: true,
      });
    this.finishCompaction(status === "failed" ? new Error(error) : undefined);
    this.finishOpenMessages();
    for (const id of this.toolItems.keys()) this.completeTool(id, status === "failed", "Codex turn completed");
    for (const path of this.attachmentFiles) void unlink(path).catch(() => undefined);
    this.attachmentFiles.clear();
    this.activeTurn = false;
    this.cancelRequested = false;
    this.activeTurnId = undefined;
    this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
    void this.refreshGoal();
    void this.drainQueue();
  }

  private ensureMessage(id: string, turnId?: string): void {
    if (turnId) this.messageTurnIds.set(id, turnId);
    if (this.messages.has(id)) return;
    this.messages.set(id, true);
    this.emit({ type: "message.started", sessionId: this.id, messageId: id, role: "assistant" });
  }

  private finishOpenMessages(): void {
    for (const id of this.messages.keys()) this.emit({ type: "message.completed", sessionId: this.id, messageId: id });
    this.messages.clear();
  }

  private startItem(item: JsonRecord, turnId?: string): void {
    const id = typeof item.id === "string" ? item.id : randomUUID();
    const type = item.type;
    if (type === "agentMessage") {
      this.ensureMessage(id, turnId);
      return;
    }
    if (type === "contextCompaction") {
      if (!this.pendingCompaction) this.emit({ type: "session.compaction", sessionId: this.id, state: "started" });
      return;
    }
    if (type === "reasoning" || type === "plan" || type === "userMessage") return;
    const names: Record<string, string> = {
      commandExecution: "命令",
      fileChange: "文件变更",
      mcpToolCall: "MCP 工具",
      dynamicToolCall: "扩展工具",
      collabAgentToolCall: "子代理",
      imageView: "查看图片",
      webSearch: "网络搜索",
      imageGeneration: "图像生成",
    };
    const name =
      type === "commandExecution"
        ? "Terminal"
        : type === "mcpToolCall"
          ? `${String(item.server ?? "MCP")}: ${String(item.tool ?? "工具")}`
          : type === "dynamicToolCall"
            ? String(item.tool ?? "扩展工具")
            : (names[String(type)] ?? String(type ?? "Codex 工具"));
    const fileChange = type === "fileChange" ? mapCodexFileChangeDiffs(item.changes) : null;
    const input =
      type === "commandExecution"
        ? { command: item.command, cwd: item.cwd }
        : (fileChange?.input ??
          (type === "fileChange"
            ? { changes: item.changes }
            : type === "imageGeneration"
              ? { prompt: item.prompt }
              : item.arguments));
    this.toolItems.set(id, { name, input });
    this.emit({
      type: "tool.started",
      sessionId: this.id,
      toolCallId: id,
      name,
      title: name,
      toolKind: type === "commandExecution" ? "terminal" : "other",
      ...(input !== undefined ? { input } : {}),
      ...(fileChange
        ? { content: fileChange.content }
        : item.aggregatedOutput !== undefined
          ? { content: item.aggregatedOutput }
          : {}),
    });
    if (type === "commandExecution" && typeof item.aggregatedOutput === "string")
      this.emit({ type: "tool.updated", sessionId: this.id, toolCallId: id, output: item.aggregatedOutput });
  }

  private async completeItem(item: JsonRecord, turnId?: string): Promise<void> {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) return;
    if (item.type === "contextCompaction") {
      if (!this.pendingCompaction) this.emit({ type: "session.compaction", sessionId: this.id, state: "completed" });
      return;
    }
    if (item.type === "agentMessage") {
      this.ensureMessage(id, turnId);
      this.emit({ type: "message.completed", sessionId: this.id, messageId: id });
      this.messages.delete(id);
      return;
    }
    if (this.toolItems.has(id)) {
      const state = item.status;
      const mcpResult = item.type === "mcpToolCall" ? mapCodexMcpToolResult(item.result, item.error) : undefined;
      const error =
        state === "failed" ||
        state === "declined" ||
        item.success === false ||
        mcpResult?.isError === true ||
        Boolean(mcpResult?.output);
      const fileChange = item.type === "fileChange" ? mapCodexFileChangeDiffs(item.changes) : null;
      const isImageGeneration = item.type === "imageGeneration";
      const output = fileChange
        ? undefined
        : mcpResult
          ? mcpResult.output
          : isImageGeneration
            ? "图片已生成"
            : (item.aggregatedOutput ?? item.result ?? item.contentItems ?? item.changes);
      if (fileChange)
        this.emit({
          type: "tool.updated",
          sessionId: this.id,
          toolCallId: id,
          input: fileChange.input,
          content: fileChange.content,
        });
      if (mcpResult?.content)
        this.emit({ type: "tool.updated", sessionId: this.id, toolCallId: id, content: mcpResult.content });
      if (output !== undefined) this.emit({ type: "tool.updated", sessionId: this.id, toolCallId: id, output });
      if (isImageGeneration && !error) {
        const attachments = await codexGeneratedImage(item);
        if (attachments.length) {
          const messageId = `codex-generated-image-${id}`;
          this.emit({ type: "message.started", sessionId: this.id, messageId, role: "assistant", attachments });
          this.emit({ type: "message.completed", sessionId: this.id, messageId });
        }
      }
      this.completeTool(id, error, output);
    }
  }

  private completeTool(id: string, isError: boolean, output?: unknown): void {
    if (!this.toolItems.has(id)) return;
    this.toolItems.delete(id);
    this.emit({
      type: "tool.completed",
      sessionId: this.id,
      toolCallId: id,
      isError,
      ...(output !== undefined ? { output } : {}),
    });
  }

  private handleExit(error: Error): void {
    if (this.disposed) return;
    this.finishOpenMessages();
    for (const id of this.toolItems.keys()) this.completeTool(id, true, error.message);
    for (const [interactionId, pending] of this.interactions) {
      this.emit({
        type: "interaction.responded",
        sessionId: this.id,
        interactionId,
        value: null,
        reason: "interrupted",
      });
      this.interactions.delete(interactionId);
      void pending;
    }
    this.activeTurn = false;
    this.emit({
      type: "provider.error",
      sessionId: this.id,
      code: "codex_app_server_exit",
      message: safeError(error).message,
      recoverable: true,
    });
    this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
    this.rpc = null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.queue = [];
    if (this.pendingCompaction) {
      clearTimeout(this.pendingCompaction.timer);
      this.pendingCompaction.reject(new Error("Codex 会话已关闭"));
      this.pendingCompaction = null;
      this.emit({ type: "session.compaction", sessionId: this.id, state: "completed", reason: "cancelled" });
    }
    for (const path of this.attachmentFiles) await unlink(path).catch(() => undefined);
    this.attachmentFiles.clear();
    await this.rpc?.close();
    this.rpc = null;
  }
}
