import type { AgentSendResult, AgentSession, SessionStorageReference } from "@vagus/agent-core";
import type { AgentCommandInfo, AgentEvent, AgentRuntimeSettings, AgentUsage, BrowserElementReference, InteractionResponse, MessageAttachment, SessionQueueState } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import { PiRpcProcess } from "./pi-rpc-process.js";
import { thinkingLevelsForModel } from "./settings.js";
import { TUI_CUSTOM_MARKER, TUI_INPUT_TITLE, TUI_WIDGET_MARKER } from "./tui-bridge.js";
import { type DialogKind, type RpcRecord } from "./types.js";
import { isRecord, numberField, stringField, stripTerminalCodes, stripTerminalCodesPreservingSgr } from "./utils.js";

export class PiSession implements AgentSession {
  get available() { return !this.disposed && this.rpc.available; }
  private readonly pendingDialogs = new Map<string, { nativeId: string; kind: DialogKind; options?: string[]; deadline?: number; timer?: ReturnType<typeof setTimeout>; responding?: boolean }>();
  private readonly activeTuiWidgets = new Set<string>();
  private readonly pendingTuiInputs = new Map<string, string>();
  private readonly queuedTuiInputs = new Map<string, string[]>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeExit: () => void;
  private currentAssistantMessageId: string | null = null;
  private currentAssistantText = "";
  private pendingUserPrompt: { messageId: string; text: string; attachments: MessageAttachment[]; browserElements: BrowserElementReference[]; clientMessageId?: string } | null = null;
  private readonly pendingQueuedPrompts: Array<{ mode: "steer" | "follow-up"; messageId: string; text: string; displayText: string; attachments: MessageAttachment[]; browserElements: BrowserElementReference[]; clientMessageId?: string }> = [];
  private isStreaming = false;
  private cancelRequested = false;
  private disposed = false;
  private currentStorageReference?: SessionStorageReference;

  constructor(
    readonly id: string,
    private readonly rpc: PiRpcProcess,
    private readonly emit: (event: AgentEvent) => void,
    initialState: unknown,
    storageReference?: SessionStorageReference,
    startupRecords: RpcRecord[] = [],
    private readonly cleanupBridge: () => Promise<void> = async () => { },
  ) {
    this.currentStorageReference = storageReference;
    this.runtimeSettings = this.settingsFromState(initialState);
    this.isStreaming = isRecord(initialState) && initialState.isStreaming === true;
    this.unsubscribe = rpc.onEvent((record) => this.onRecord(record));
    this.unsubscribeExit = rpc.onExit((error) => {
      if (this.disposed) return;
      this.isStreaming = false;
      this.clearDialogs("interrupted");
      this.emit({
        type: "provider.error",
        sessionId: this.id,
        code: "pi_process_exit",
        message: error.message,
        recoverable: true,
      });
      this.emit({ type: "session.state", sessionId: this.id, state: "ended" });
      void this.cleanupBridge();
    });
    for (const record of startupRecords) {
      // A resumed Pi process can replay the previous turn's startup marker before
      // get_state responds. That marker is historical during session recovery;
      // treating it as a live run makes the UI count from the old user message.
      if (stringField(record, "type") === "agent_start") continue;
      this.onRecord(record);
    }
  }

  private runtimeSettings: AgentRuntimeSettings;

  get storageReference(): SessionStorageReference | undefined {
    return this.currentStorageReference;
  }

  async forkAfterAssistantMessage(text: string, occurrence: number): Promise<SessionStorageReference> {
    if (this.disposed) throw new Error("Pi session is closed");
    if (!this.currentStorageReference?.sessionFile) throw new Error("当前 Pi 会话尚未保存，无法分支");
    if (!Number.isInteger(occurrence) || occurrence < 0) throw new Error("助手消息位置无效");
    const native = await this.rpc.request("get_entries");
    if (!isRecord(native) || !Array.isArray(native.entries)) throw new Error("Pi 没有返回会话记录");
    const entries = native.entries.filter(isRecord);
    const byId = new Map(entries.filter((entry) => typeof entry.id === "string").map((entry) => [entry.id as string, entry]));
    const activePath: RpcRecord[] = [];
    let cursor = typeof native.leafId === "string" ? native.leafId : undefined;
    while (cursor) {
      const entry = byId.get(cursor);
      if (!entry) break;
      activePath.push(entry);
      cursor = typeof entry.parentId === "string" ? entry.parentId : undefined;
    }
    activePath.reverse();
    const assistantMatches = activePath.filter((entry) => {
      if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return false;
      const content = entry.message.content.filter(isRecord).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("");
      return content === text;
    });
    const selected = assistantMatches[occurrence];
    if (!selected || typeof selected.id !== "string") throw new Error("找不到这条助手回复对应的 Pi 会话记录");
    const selectedIndex = activePath.indexOf(selected);
    const nextUser = activePath.slice(selectedIndex + 1).find((entry) => entry.type === "message" && isRecord(entry.message) && entry.message.role === "user");
    if (nextUser && typeof nextUser.id === "string") {
      await this.rpc.request("fork", { entryId: nextUser.id });
    } else {
      await this.rpc.request("clone");
    }
    const forkedState = await this.rpc.request("get_state");
    const sessionFile = isRecord(forkedState) ? stringField(forkedState, "sessionFile") : undefined;
    if (!sessionFile || sessionFile === this.currentStorageReference.sessionFile) throw new Error("Pi 没有创建独立的分支会话");
    this.currentStorageReference = { sessionFile };
    return this.currentStorageReference;
  }

  async getRuntimeSettings(): Promise<AgentRuntimeSettings> {
    if (this.disposed) throw new Error("Pi session is closed");
    this.runtimeSettings = this.settingsFromState(await this.rpc.request("get_state"));
    return this.runtimeSettings;
  }

  async setModel(modelId: string): Promise<AgentRuntimeSettings> {
    if (this.disposed) throw new Error("Pi session is closed");
    const separator = modelId.indexOf("/");
    if (separator <= 0 || separator === modelId.length - 1) throw new Error("模型标识无效");
    const provider = modelId.slice(0, separator);
    const nativeModelId = modelId.slice(separator + 1);
    await this.rpc.request("set_model", { provider, modelId: nativeModelId });
    return this.getRuntimeSettings();
  }

  async setThinkingLevel(level: string): Promise<AgentRuntimeSettings> {
    if (this.disposed) throw new Error("Pi session is closed");
    if (!this.runtimeSettings.thinkingLevels.includes(level)) throw new Error("当前模型不支持这个思考程度");
    await this.rpc.request("set_thinking_level", { level });
    this.runtimeSettings = { ...this.runtimeSettings, thinkingLevel: level };
    return this.runtimeSettings;
  }

  async clearQueue(): Promise<SessionQueueState> {
    if (this.disposed) throw new Error("Pi session is closed");
    const response = await this.rpc.request("clear_queue");
    // Pi's clear_queue response contains the messages that were removed, not the
    // messages that remain. Queued prompts are not conversation history until Pi
    // actually starts processing them, so discard their pending timeline records.
    const cleared: SessionQueueState = {
      steering: isRecord(response) && Array.isArray(response.steering) ? response.steering.filter((item): item is string => typeof item === "string") : [],
      followUp: isRecord(response) && Array.isArray(response.followUp) ? response.followUp.filter((item): item is string => typeof item === "string") : [],
    };
    for (const text of cleared.steering) this.removePendingQueuedPrompt("steer", text);
    for (const text of cleared.followUp) this.removePendingQueuedPrompt("follow-up", text);
    const queue: SessionQueueState = { steering: [], followUp: [] };
    this.emit({ type: "session.queue.updated", sessionId: this.id, queue });
    return queue;
  }

  async compact(instructions?: string): Promise<void> {
    if (this.disposed) throw new Error("Pi session is closed");
    // Compaction duration depends on the session size and may exceed the
    // normal command timeout. The RPC process still rejects if Pi exits.
    await this.rpc.request("compact", instructions ? { customInstructions: instructions } : {}, 0);
    this.runtimeSettings = this.settingsFromState(await this.rpc.request("get_state"));
  }

  async setAutoCompaction(enabled: boolean): Promise<AgentRuntimeSettings> {
    if (this.disposed) throw new Error("Pi session is closed");
    await this.rpc.request("set_auto_compaction", { enabled });
    this.runtimeSettings = this.settingsFromState(await this.rpc.request("get_state"));
    return this.runtimeSettings;
  }

  async getUsage(): Promise<AgentUsage | null> {
    if (this.disposed) throw new Error("Pi session is closed");
    let stats: unknown;
    try {
      stats = await this.rpc.request("get_session_stats");
    } catch {
      stats = await this.rpc.request("get_state");
    }
    if (isRecord(stats) && stats.tokens == null && stats.cost == null && stats.contextUsage == null) {
      try { stats = await this.rpc.request("get_state"); }
      catch { /* The runtime may not expose usage stats. */ }
    }
    if (!isRecord(stats)) return null;
    const tokens = isRecord(stats.tokens) ? stats.tokens : {};
    const cost = isRecord(stats.cost) ? stats.cost.total : stats.cost;
    const context = isRecord(stats.contextUsage) ? stats.contextUsage : {};
    const usage: AgentUsage = {};
    const assign = (key: keyof AgentUsage, value: unknown) => {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = value;
    };
    assign("inputTokens", tokens.input);
    assign("cachedInputTokens", tokens.cacheRead);
    assign("outputTokens", tokens.output);
    assign("totalCostUsd", cost);
    assign("contextWindowMaxTokens", context.contextWindow);
    assign("contextWindowUsedTokens", context.tokens);
    return Object.keys(usage).length ? usage : null;
  }

  async getCommands(): Promise<AgentCommandInfo[]> {
    if (this.disposed) throw new Error("Pi session is closed");
    const response = await this.rpc.request("get_commands");
    const commands = isRecord(response) && Array.isArray(response.commands) ? response.commands.flatMap((item): AgentCommandInfo[] => {
      if (!isRecord(item) || typeof item.name !== "string") return [];
      const source = item.source === "extension" || item.source === "prompt" || item.source === "skill" ? item.source : "other";
      return [{ name: item.name, ...(typeof item.description === "string" ? { description: item.description } : {}), source }];
    }) : [];
    // Pi's TUI reserves /compact. RPC needs an explicit session operation.
    return [...commands.filter((command) => command.name !== "compact"), {
      name: "compact", source: "builtin", action: "compact",
      description: "压缩当前会话的上下文，可在命令后填写压缩要求",
    }];
  }

  private settingsFromState(state: unknown): AgentRuntimeSettings {
    const record = isRecord(state) ? state : {};
    const model = isRecord(record.model) ? record.model : null;
    const provider = model ? stringField(model, "provider") : undefined;
    const modelId = model ? stringField(model, "id") : undefined;
    const level = stringField(record, "thinkingLevel");
    const thinkingLevels = model ? thinkingLevelsForModel(model) : this.runtimeSettings?.thinkingLevels ?? [];
    return {
      providerId: "pi",
      modelId: provider && modelId ? `${provider}/${modelId}` : this.runtimeSettings?.modelId ?? null,
      thinkingLevel: thinkingLevels.length > 0 && level && thinkingLevels.includes(level)
        ? level
        : thinkingLevels.includes("medium") ? "medium" : thinkingLevels.at(-1) ?? null,
      thinkingLevels,
      ...(typeof record.autoCompactionEnabled === "boolean" ? { autoCompactionEnabled: record.autoCompactionEnabled } : {}),
    };
  }

  async sendText(text: string, attachments: MessageAttachment[] = [], deliveryMode: "immediate" | "steer" | "follow-up" = "immediate", clientMessageId?: string, browserElements: BrowserElementReference[] = []): Promise<AgentSendResult> {
    if (this.disposed) throw new Error("Pi session is closed");
    if (!text.trim() && attachments.length === 0 && browserElements.length === 0) throw new Error("Message must not be empty");
    if (this.activeTuiWidgets.size > 0) throw new Error("请先关闭当前扩展操作面板");
    const messageId = randomUUID();
    const displayText = text.trim() || (attachments.length ? "请查看附件中的图片。" : "");
    const elementContext = browserElements.length ? ["\n\n[用户选中的网页元素]", ...browserElements.map((element, index) => [
      `元素 ${index + 1}: <${element.tag}>`, `URL: ${element.url}`, `Selector: ${element.selector}`,
      element.text ? `可见文本: ${element.text}` : "", element.note ? `用户说明: ${element.note}` : "",
      element.html ? `HTML 片段: ${element.html}` : "",
    ].filter(Boolean).join("\n"))].join("\n") : "";
    const messageText = `${displayText || (browserElements.length ? "请分析我选中的网页元素。" : "请查看附件中的图片。")}${elementContext}`;
    this.pendingUserPrompt = { messageId, text: displayText, attachments, browserElements, clientMessageId };
    const queuedPrompt = this.isStreaming && deliveryMode !== "immediate"
      ? { mode: deliveryMode, messageId, text: messageText, displayText, attachments, browserElements, clientMessageId }
      : null;
    if (queuedPrompt) this.pendingQueuedPrompts.push(queuedPrompt);
    const images = attachments.map((attachment) => ({ type: "image", data: attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1), mimeType: attachment.mimeType }));
    try {
      const response = await this.rpc.request("prompt", {
        message: messageText,
        ...(images.length ? { images } : {}),
        ...(this.isStreaming && deliveryMode !== "immediate" ? { streamingBehavior: deliveryMode === "steer" ? "steer" : "followUp" } : {}),
      }, 0);
      // The RPC process resolves each request with the record's `data` field,
      // so disposition is at the top level of this value.
      const disposition = isRecord(response) ? stringField(response, "disposition") : undefined;
      if (disposition === "handled") {
        this.pendingUserPrompt = null;
        if (queuedPrompt) this.removePendingQueuedPrompt(queuedPrompt.mode, queuedPrompt.text, queuedPrompt.messageId);
      } else if (disposition === "queued") {
        // Pi shows queued input in its queue panel. It becomes a timeline message
        // only when Pi emits message_start for that user input.
        if (this.pendingUserPrompt?.messageId === messageId) this.pendingUserPrompt = null;
      } else {
        if (queuedPrompt) this.removePendingQueuedPrompt(queuedPrompt.mode, queuedPrompt.text, queuedPrompt.messageId);
        this.emitPendingUserPrompt();
      }
      return { disposition: disposition === "handled" || disposition === "queued" ? disposition : "submitted" };
    } catch (error) {
      if (queuedPrompt) this.removePendingQueuedPrompt(queuedPrompt.mode, queuedPrompt.text, queuedPrompt.messageId);
      this.emitPendingUserPrompt();
      throw error;
    }
  }

  async respond(response: InteractionResponse): Promise<void> {
    const pending = this.pendingDialogs.get(response.interactionId);
    if (!pending || pending.responding) throw new Error("这个请求已结束或正在提交");
    if (pending.deadline !== undefined && Date.now() >= pending.deadline) throw new Error("这个请求已超时");
    const frame: RpcRecord = {
      type: "extension_ui_response",
      id: pending.nativeId,
    };
    if (response.value === null) frame.cancelled = true;
    else if (pending.kind === "confirm") {
      if (typeof response.value !== "boolean") throw new Error("Confirmation requires a boolean");
      frame.confirmed = response.value;
    } else {
      if (typeof response.value !== "string") throw new Error("Interaction requires text");
      if (pending.options && !pending.options.includes(response.value)) throw new Error("请选择请求中的选项");
      frame.value = response.value;
    }
    pending.responding = true;
    clearTimeout(pending.timer);
    try {
      await this.rpc.send(frame);
      this.pendingDialogs.delete(response.interactionId);
    } catch (error) {
      pending.responding = false;
      if (pending.deadline !== undefined) pending.timer = setTimeout(() => {
        if (!this.pendingDialogs.delete(response.interactionId)) return;
        this.emit({ type: "interaction.responded", sessionId: this.id, interactionId: response.interactionId, value: null, reason: "timeout" });
      }, Math.max(0, pending.deadline - Date.now()));
      throw error;
    }
  }

  async sendUiInput(widgetKey: string, input: string): Promise<void> {
    if (this.disposed) throw new Error("Pi session is closed");
    if (!widgetKey.startsWith("extension:vagus-custom-") || !this.activeTuiWidgets.has(widgetKey)) {
      // ResizeObserver and input events can race with a component closing. Ignore stale events.
      return;
    }
    if (!input || Buffer.byteLength(input, "utf8") > 2048) throw new Error("扩展组件输入无效");
    const nativeId = this.pendingTuiInputs.get(widgetKey);
    if (nativeId) {
      this.pendingTuiInputs.delete(widgetKey);
      await this.rpc.send({ type: "extension_ui_response", id: nativeId, value: input });
      return;
    }
    const queue = this.queuedTuiInputs.get(widgetKey) ?? [];
    if (queue.length >= 32) throw new Error("组件输入过快，请稍后重试");
    queue.push(input);
    this.queuedTuiInputs.set(widgetKey, queue);
  }

  async cancel(): Promise<void> {
    try { await this.clearQueue(); } catch { /* A failed queue clear must not prevent aborting the active turn. */ }
    try { await this.rpc.request("abort_retry"); } catch { /* Older Pi builds may not expose retry cancellation. */ }
    for (const [interactionId, pending] of this.pendingDialogs) {
      try { await this.rpc.send({ type: "extension_ui_response", id: pending.nativeId, cancelled: true }); } catch { /* Keep aborting even if an extension request has already expired. */ }
      clearTimeout(pending.timer);
      this.pendingDialogs.delete(interactionId);
      this.emit({ type: "interaction.responded", sessionId: this.id, interactionId, value: null });
    }
    this.cancelRequested = this.isStreaming;
    try {
      await this.rpc.request("abort");
    } catch (error) {
      this.cancelRequested = false;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingDialogs.values()) {
      clearTimeout(pending.timer);
      try {
        await this.rpc.send({ type: "extension_ui_response", id: pending.nativeId, cancelled: true });
      } catch {
        break;
      }
    }
    this.clearDialogs("interrupted");
    this.unsubscribe();
    this.unsubscribeExit();
    await this.rpc.close();
    await this.cleanupBridge();
    this.emit({ type: "session.state", sessionId: this.id, state: "ended" });
  }

  async suspend(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribeExit();
    await this.rpc.close();
    await this.cleanupBridge();
  }

  private onRecord(record: RpcRecord): void {
    const type = stringField(record, "type");
    switch (type) {
      case "agent_start":
        this.isStreaming = true;
        this.emitPendingUserPrompt();
        this.emit({ type: "session.state", sessionId: this.id, state: "running" });
        this.emit({ type: "ui.status", sessionId: this.id, key: "agent-activity", text: "正在思考" });
        break;
      case "agent_settled":
        this.isStreaming = false;
        this.finishAssistantMessage();
        this.cancelRequested = false;
        this.emit({ type: "ui.status", sessionId: this.id, key: "agent-activity", text: null });
        this.emit({ type: "session.state", sessionId: this.id, state: "idle" });
        void this.refreshUsage();
        break;
      case "queue_update":
        this.emit({
          type: "session.queue.updated",
          sessionId: this.id,
          queue: {
            steering: Array.isArray(record.steering) ? record.steering.filter((item): item is string => typeof item === "string") : [],
            followUp: Array.isArray(record.followUp) ? record.followUp.filter((item): item is string => typeof item === "string") : [],
          },
        });
        break;
      case "compaction_start":
        this.emit({ type: "session.compaction", sessionId: this.id, state: "started", reason: stringField(record, "reason") });
        break;
      case "compaction_end":
        this.emit({ type: "session.compaction", sessionId: this.id, state: "completed" });
        break;
      case "auto_retry_start":
        this.emit({ type: "notification", sessionId: this.id, level: "info", message: `请求暂时失败，Pi 将在 ${Math.max(1, Math.round((numberField(record, "delayMs") ?? 0) / 1000))} 秒后重试（${numberField(record, "attempt") ?? 1}/${numberField(record, "maxAttempts") ?? "?"}）` });
        break;
      case "auto_retry_end":
        if (record.success === false) {
          const finalError = stringField(record, "finalError");
          this.emit({ type: "notification", sessionId: this.id, level: "warning", message: finalError ? `自动重试已结束：${finalError}` : "自动重试已结束" });
        }
        break;
      case "message_start":
        if (isRecord(record.message)) {
          if (record.message.role === "assistant") this.startAssistantMessage();
          else if (record.message.role === "user") this.emitStartedQueuedPrompt(record.message);
        }
        break;
      case "message_update":
        if (isRecord(record.assistantMessageEvent)) {
          const delta = record.assistantMessageEvent;
          if (delta.type === "text_delta" && typeof delta.delta === "string") {
            this.appendAssistantText(delta.delta);
          }
        }
        break;
      case "message_end":
        if (isRecord(record.message) && record.message.role === "assistant") {
          if (!this.currentAssistantText) {
            const content = record.message.content;
            if (Array.isArray(content)) {
              const text = content
                .filter((part): part is RpcRecord => isRecord(part))
                .filter((part) => part.type === "text" && typeof part.text === "string")
                .map((part) => part.text as string)
                .join("");
              if (text) this.appendAssistantText(text);
            }
          }
          this.finishAssistantMessage();
          const errorMessage = stringField(record.message, "errorMessage");
          const isExpectedCancellation = this.cancelRequested && /^(?:request\s+)?aborted$/iu.test(errorMessage?.trim() ?? "");
          if (errorMessage && !isExpectedCancellation) {
            this.emit({
              type: "provider.error",
              sessionId: this.id,
              code: "pi_model_error",
              message: errorMessage,
              recoverable: true,
            });
          }
        }
        break;
      case "tool_execution_start":
        if (typeof record.toolCallId === "string" && typeof record.toolName === "string") {
          this.emit({ type: "ui.status", sessionId: this.id, key: "agent-activity", text: null });
          this.emit({
            type: "tool.started",
            sessionId: this.id,
            toolCallId: record.toolCallId,
            name: record.toolName,
            input: record.args,
          });
        }
        break;
      case "tool_execution_update":
        if (typeof record.toolCallId === "string") {
          this.emit({
            type: "tool.updated",
            sessionId: this.id,
            toolCallId: record.toolCallId,
            output: record.partialResult,
          });
        }
        break;
      case "tool_execution_end":
        if (typeof record.toolCallId === "string") {
          this.emit({
            type: "tool.completed",
            sessionId: this.id,
            toolCallId: record.toolCallId,
            isError: record.isError === true,
            output: record.result,
          });
          if (record.isError !== true) this.emit({ type: "ui.status", sessionId: this.id, key: "agent-activity", text: "正在思考" });
        }
        break;
      case "extension_ui_request":
        this.onExtensionUiRequest(record);
        break;
    }
  }

  private async refreshUsage(): Promise<void> {
    try {
      const usage = await this.getUsage();
      if (usage && !this.disposed) this.emit({ type: "session.usage.updated", sessionId: this.id, usage });
    } catch {
      // Usage is optional telemetry and must not affect the conversation.
    }
  }

  private startAssistantMessage(): void {
    this.finishAssistantMessage();
    this.currentAssistantMessageId = randomUUID();
    this.currentAssistantText = "";
    this.emit({
      type: "message.started",
      sessionId: this.id,
      messageId: this.currentAssistantMessageId,
      role: "assistant",
    });
  }

  private emitPendingUserPrompt(): void {
    const prompt = this.pendingUserPrompt;
    if (!prompt) return;
    this.pendingUserPrompt = null;
    this.emit({ type: "message.started", sessionId: this.id, messageId: prompt.messageId, role: "user", attachments: prompt.attachments, browserElements: prompt.browserElements, ...(prompt.clientMessageId ? { clientMessageId: prompt.clientMessageId } : {}) });
    this.emit({ type: "message.delta", sessionId: this.id, messageId: prompt.messageId, text: prompt.text });
    this.emit({ type: "message.completed", sessionId: this.id, messageId: prompt.messageId });
  }

  private emitStartedQueuedPrompt(message: RpcRecord): void {
    const parts = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    const text = parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("");
    const index = this.pendingQueuedPrompts.findIndex((prompt) => prompt.text === text);
    const [prompt] = this.pendingQueuedPrompts.splice(index >= 0 ? index : 0, 1);
    if (!prompt) return;
    if (this.pendingUserPrompt?.messageId === prompt.messageId) this.pendingUserPrompt = null;
    this.emit({ type: "message.started", sessionId: this.id, messageId: prompt.messageId, role: "user", attachments: prompt.attachments, browserElements: prompt.browserElements, ...(prompt.clientMessageId ? { clientMessageId: prompt.clientMessageId } : {}) });
    this.emit({ type: "message.delta", sessionId: this.id, messageId: prompt.messageId, text: prompt.displayText });
    this.emit({ type: "message.completed", sessionId: this.id, messageId: prompt.messageId });
  }

  private removePendingQueuedPrompt(mode: "steer" | "follow-up", text: string, messageId?: string): void {
    const index = this.pendingQueuedPrompts.findIndex((prompt) => prompt.mode === mode && (messageId ? prompt.messageId === messageId : prompt.text === text));
    // Pi may expand a skill/template before putting the prompt in its queue. In
    // that case the cleared text differs from what the user typed, but the Pi
    // response still confirms that one item of this queue mode was removed.
    const fallbackIndex = messageId ? -1 : this.pendingQueuedPrompts.findIndex((prompt) => prompt.mode === mode);
    const removeIndex = index >= 0 ? index : fallbackIndex;
    if (removeIndex >= 0) this.pendingQueuedPrompts.splice(removeIndex, 1);
  }

  private appendAssistantText(text: string): void {
    if (!this.currentAssistantMessageId) this.startAssistantMessage();
    this.emit({ type: "ui.status", sessionId: this.id, key: "agent-activity", text: null });
    this.currentAssistantText += text;
    this.emit({
      type: "message.delta",
      sessionId: this.id,
      messageId: this.currentAssistantMessageId!,
      text,
    });
  }

  private finishAssistantMessage(): void {
    if (!this.currentAssistantMessageId) return;
    this.emit({
      type: "message.completed",
      sessionId: this.id,
      messageId: this.currentAssistantMessageId,
    });
    this.currentAssistantMessageId = null;
    this.currentAssistantText = "";
  }

  private clearDialogs(reason: "timeout" | "interrupted"): void {
    for (const [interactionId, pending] of this.pendingDialogs) {
      clearTimeout(pending.timer);
      this.emit({ type: "interaction.responded", sessionId: this.id, interactionId, value: null, reason });
    }
    this.pendingDialogs.clear();
  }

  private onExtensionUiRequest(record: RpcRecord): void {
    const nativeId = stringField(record, "id");
    const method = stringField(record, "method");
    if (!nativeId || !method) return;
    const rawTitle = stringField(record, "title");
    if (method === "input" && rawTitle === TUI_INPUT_TITLE) {
      const customId = stringField(record, "placeholder");
      if (customId?.startsWith("vagus-custom-")) this.handleTuiInputRequest(nativeId, `extension:${customId}`);
      else void this.rpc.send({ type: "extension_ui_response", id: nativeId, cancelled: true });
      return;
    }
    const title = rawTitle === undefined ? undefined : stripTerminalCodes(rawTitle);
    const interactionId = randomUUID();
    const timeout = typeof record.timeout === "number" && Number.isFinite(record.timeout) ? Math.max(0, Math.min(record.timeout, 2_147_483_647)) : undefined;
    const receivedAt = typeof record.vagusReceivedAt === "number" ? record.vagusReceivedAt : Date.now();
    const deadline = timeout === undefined ? undefined : receivedAt + timeout;
    const expiresAt = deadline === undefined ? undefined : new Date(deadline).toISOString();
    const registerDialog = (kind: DialogKind, options?: string[]) => {
      const pending: { nativeId: string; kind: DialogKind; options?: string[]; deadline?: number; timer?: ReturnType<typeof setTimeout>; responding?: boolean } = { nativeId, kind, options };
      if (deadline !== undefined) {
        pending.deadline = deadline;
        pending.timer = setTimeout(() => {
          if (!this.pendingDialogs.delete(interactionId)) return;
          this.emit({ type: "interaction.responded", sessionId: this.id, interactionId, value: null, reason: "timeout" });
        }, Math.max(0, deadline - Date.now()));
      }
      this.pendingDialogs.set(interactionId, pending);
    };
    switch (method) {
      case "select": {
        const options = Array.isArray(record.options)
          ? record.options.filter((value): value is string => typeof value === "string")
          : [];
        registerDialog("choice", options);
        this.emit({
          type: "interaction.requested",
          sessionId: this.id,
          interactionId,
          interaction: { kind: "choice", title, options, expiresAt },
        });
        break;
      }
      case "confirm":
        registerDialog("confirm");
        this.emit({
          type: "interaction.requested",
          sessionId: this.id,
          interactionId,
          interaction: { kind: "confirm", title, message: stringField(record, "message") ?? "", expiresAt },
        });
        break;
      case "input":
        registerDialog("text-input");
        this.emit({
          type: "interaction.requested",
          sessionId: this.id,
          interactionId,
          interaction: { kind: "text-input", title, placeholder: stringField(record, "placeholder"), expiresAt },
        });
        break;
      case "editor":
        registerDialog("text-editor");
        this.emit({
          type: "interaction.requested",
          sessionId: this.id,
          interactionId,
          interaction: { kind: "text-editor", title, initialValue: stringField(record, "prefill"), expiresAt },
        });
        break;
      case "notify": {
        const kind = stringField(record, "notifyType");
        const level = kind === "warning" || kind === "error" ? kind : "info";
        this.emit({
          type: "notification",
          sessionId: this.id,
          level,
          message: stripTerminalCodes(stringField(record, "message") ?? ""),
        });
        break;
      }
      case "setStatus":
        if (typeof record.statusKey === "string" && record.statusKey) {
          this.emit({
            type: "ui.status",
            sessionId: this.id,
            key: `extension:${record.statusKey}`,
            text: typeof record.statusText === "string" ? stripTerminalCodes(record.statusText) : null,
          });
        }
        break;
      case "setWidget":
        if (typeof record.widgetKey === "string" && record.widgetKey) {
          const widgetLines = Array.isArray(record.widgetLines) ? record.widgetLines.filter((line): line is string => typeof line === "string") : null;
          const tuiWidget = widgetLines?.[0] === TUI_WIDGET_MARKER;
          const customMetaLine = tuiWidget ? widgetLines?.find((line) => line.startsWith(TUI_CUSTOM_MARKER)) : undefined;
          const widgetKey = `extension:${record.widgetKey}`;
          if (customMetaLine) this.activeTuiWidgets.add(widgetKey);
          else this.clearTuiWidget(widgetKey);
          this.emit({
            type: "ui.widget", sessionId: this.id, key: `extension:${record.widgetKey}`,
            content: widgetLines ? {
              type: tuiWidget ? "tui" : "text",
              ...(customMetaLine ? { title: "自定义界面", interactive: true } : {}),
              lines: (tuiWidget ? widgetLines.slice(1).filter((line) => line !== customMetaLine) : widgetLines).map(tuiWidget ? stripTerminalCodesPreservingSgr : stripTerminalCodes),
            } : null,
            placement: record.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor"
          });
        }
        break;
      case "setTitle":
        if (typeof record.title === "string") this.emit({ type: "ui.title", sessionId: this.id, title: stripTerminalCodes(record.title) });
        break;
      case "set_editor_text":
        if (typeof record.text === "string") this.emit({ type: "ui.editorText", sessionId: this.id, requestId: nativeId, text: stripTerminalCodes(record.text) });
        break;
      default:
        // Unknown extension UI methods are not presented as supported.
        break;
    }
  }

  private handleTuiInputRequest(nativeId: string, widgetKey: string): void {
    if (!this.activeTuiWidgets.has(widgetKey)) {
      void this.rpc.send({ type: "extension_ui_response", id: nativeId, cancelled: true });
      return;
    }
    const queue = this.queuedTuiInputs.get(widgetKey);
    const next = queue?.shift();
    if (queue && queue.length === 0) this.queuedTuiInputs.delete(widgetKey);
    if (next !== undefined) {
      void this.rpc.send({ type: "extension_ui_response", id: nativeId, value: next });
      return;
    }
    this.pendingTuiInputs.set(widgetKey, nativeId);
  }

  private clearTuiWidget(widgetKey: string): void {
    this.activeTuiWidgets.delete(widgetKey);
    this.pendingTuiInputs.delete(widgetKey);
    this.queuedTuiInputs.delete(widgetKey);
  }
}
