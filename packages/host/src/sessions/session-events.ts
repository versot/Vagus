import { applySessionUiEvent, type AgentEvent, type SessionTimelineEntry, type TurnId } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import type { HostContext } from "../runtime/host-context.js";
import { type Message } from "../storage/workspace-records.js";

export interface SessionEventServicesContract {
  emit(event: AgentEvent): void;
  createSessionEmitter(sessionId: string): (event: AgentEvent) => void;
}

type SessionEventServicesDependencies = Pick<HostContext, "agentLastActivity" | "appendMessage" | "appendTimeline" | "broadcast" | "compactingSessions" | "findSession" | "indexes" | "liveAgents" | "markEntry" | "persistSoon" | "recordPerformance" | "sessionEmitterFlushers" | "sessionEmitters" | "sessionTitleFromFirstMessage" | "sessionUi">;

export function createSessionEventServices(ctx: SessionEventServicesDependencies): SessionEventServicesContract {
  function emit(event: AgentEvent): void {
    const started = performance.now();
    if (event.type === "ui.status" || event.type === "ui.widget" || event.type === "ui.editorText" || event.type === "ui.editorText.dismissed" || event.type === "ui.reset") {
      if (event.type === "ui.reset") ctx.sessionUi.delete(event.sessionId);
      else ctx.sessionUi.set(event.sessionId, applySessionUiEvent(ctx.sessionUi.get(event.sessionId), event));
    }
    if (event.type === "ui.title") {
      const session = ctx.findSession(event.sessionId);
      if (session && !session.titleManuallySet && !session.messages.some((message) => message.role === "user") && event.title.trim()) {
        session.title = event.title.trim().slice(0, 180);
        ctx.persistSoon();
      }
    }
    if (event.type === "session.usage.updated") {
      const session = ctx.findSession(event.sessionId);
      if (session) { session.usage = event.usage; ctx.persistSoon(); }
    }
    if (event.type === "session.settings.updated") {
      const session = ctx.findSession(event.sessionId);
      if (session) { session.runtimeSettings = event.settings; ctx.persistSoon(); }
    }
    if (event.type === "session.queue.updated") {
      const session = ctx.findSession(event.sessionId);
      if (session) { session.queue = event.queue; ctx.persistSoon(); }
    }
    if (event.type === "session.compaction") {
      if (event.state === "started") ctx.compactingSessions.add(event.sessionId);
      else ctx.compactingSessions.delete(event.sessionId);
      const message = event.state === "started" ? "Agent 正在压缩上下文"
        : event.reason === "failed" ? "Agent 上下文压缩失败"
          : event.reason === "cancelled" ? "Agent 上下文压缩已取消" : "Agent 已完成上下文压缩";
      emit({ type: "notification", sessionId: event.sessionId, level: event.state === "completed" && (event.reason === "failed" || event.reason === "cancelled") ? "warning" : "info", message });
    }
    if (event.type === "session.plan.updated") {
      const session = ctx.findSession(event.sessionId);
      if (session) {
        const existing = ctx.indexes(session).entries.get(event.planId);
        const entry: SessionTimelineEntry = {
          kind: "plan",
          id: event.planId,
          sequence: existing?.kind === "plan" ? existing.sequence : event.sequence ?? ++session.eventSequence,
          ...(event.turnId ? { turnId: event.turnId } : existing?.kind === "plan" && existing.turnId ? { turnId: existing.turnId } : {}),
          occurredAt: existing?.kind === "plan" ? existing.occurredAt : event.occurredAt ?? new Date().toISOString(),
          ...(event.explanation ? { explanation: event.explanation } : {}),
          steps: event.steps,
        };
        session.eventSequence = Math.max(session.eventSequence, entry.sequence);
        if (existing?.kind === "plan") {
          if (!event.explanation) delete existing.explanation;
          Object.assign(existing, entry);
        }
        else ctx.appendTimeline(session, entry);
        ctx.markEntry(session.id, entry);
        session.updatedAt = new Date().toISOString();
        ctx.persistSoon();
      }
    }
    if (event.type === "session.turn.diff.updated") {
      const session = ctx.findSession(event.sessionId);
      if (session) {
        const id = `turn-diff-${encodeURIComponent(event.turnId)}`;
        const existing = ctx.indexes(session).entries.get(id);
        const entry: SessionTimelineEntry = {
          kind: "turnDiff",
          id,
          sequence: existing?.kind === "turnDiff" ? existing.sequence : event.sequence ?? ++session.eventSequence,
          turnId: event.turnId,
          occurredAt: existing?.kind === "turnDiff" ? existing.occurredAt : event.occurredAt ?? new Date().toISOString(),
          diff: event.diff,
          ...(event.truncated ? { truncated: true } : {}),
        };
        session.eventSequence = Math.max(session.eventSequence, entry.sequence);
        if (existing?.kind === "turnDiff") Object.assign(existing, entry);
        else ctx.appendTimeline(session, entry);
        ctx.markEntry(session.id, entry);
        session.updatedAt = new Date().toISOString();
        ctx.persistSoon();
      }
    }
    if (event.type === "session.state") {
      if (event.state === "starting" || event.state === "ended") emit({ type: "ui.reset", sessionId: event.sessionId });
      if (event.state === "starting" || event.state === "ended") ctx.compactingSessions.delete(event.sessionId);
      const session = ctx.findSession(event.sessionId);
      if (session) { session.state = event.state; ctx.persistSoon(); }
      if (event.state === "idle") ctx.agentLastActivity.set(event.sessionId, Date.now());
    }
    if (event.type === "message.started" && event.sessionId) {
      const session = ctx.findSession(event.sessionId);
      if (session) {
        const existingMessage = ctx.indexes(session).messages.get(event.messageId);
        const existingTimeline = ctx.indexes(session).entries.get(event.messageId);
        if (event.replay && existingMessage && existingTimeline?.kind === "message") {
          existingMessage.text = "";
          existingMessage.complete = false;
          delete existingMessage.completedAt;
          existingTimeline.text = "";
          existingTimeline.complete = false;
          delete existingTimeline.completedAt;
          ctx.markEntry(session.id, existingTimeline);
          ctx.persistSoon();
        } else if (!existingMessage) {
          const sequence = event.sequence ?? ++session.eventSequence;
          const occurredAt = event.occurredAt ?? new Date().toISOString();
          session.eventSequence = Math.max(session.eventSequence, sequence);
          const message: Message = {
            id: event.messageId,
            role: event.role,
            text: "",
            complete: false,
            sequence,
            ...(event.turnId ? { turnId: event.turnId } : {}),
            occurredAt,
            ...(event.attachments?.length ? { attachments: event.attachments } : {}),
            ...(event.browserElements?.length ? { browserElements: event.browserElements } : {}),
          };
          ctx.appendMessage(session, message);
          ctx.appendTimeline(session, {
            kind: "message",
            id: event.messageId,
            sequence,
            ...(event.turnId ? { turnId: event.turnId } : {}),
            occurredAt,
            role: event.role,
            text: "",
            complete: false,
            ...(event.attachments?.length ? { attachments: event.attachments } : {}),
            ...(event.browserElements?.length ? { browserElements: event.browserElements } : {}),
          });
          if (event.role === "user") session.lastUserAt = occurredAt;
          ctx.persistSoon();
        }
      }
    }
    if (event.type === "message.delta") {
      const session = ctx.findSession(event.sessionId);
      const message = session ? ctx.indexes(session).messages.get(event.messageId) : undefined;
      if (session && message) {
        message.text += event.text;
        const timelineMessage = ctx.indexes(session).entries.get(event.messageId);
        if (timelineMessage?.kind === "message") timelineMessage.text = message.text;
        ctx.persistSoon();
      }
    }
    if (event.type === "message.completed") {
      const session = ctx.findSession(event.sessionId);
      const message = session ? ctx.indexes(session).messages.get(event.messageId) : undefined;
      if (session && message) {
        message.complete = true;
        message.completedAt = event.occurredAt ?? new Date().toISOString();
        const timelineMessage = ctx.indexes(session).entries.get(event.messageId);
        if (timelineMessage?.kind === "message") { timelineMessage.complete = true; timelineMessage.completedAt = message.completedAt; }
        session.updatedAt = new Date().toISOString();
        if (message.role === "user" && !session.titleManuallySet && session.messages.filter((item) => item.role === "user").length === 1) {
          session.title = ctx.sessionTitleFromFirstMessage(message.text);
          emit({ type: "workspace.changed" });
        }
        if (message.role === "assistant") { session.lastAssistantAt = session.updatedAt; session.hasAssistantReply = true; }
        ctx.persistSoon();
      }
    }
    if (event.type === "tool.started") {
      const session = ctx.findSession(event.sessionId);
      if (session && !ctx.indexes(session).entries.has(event.toolCallId)) {
        const sequence = event.sequence ?? ++session.eventSequence;
        session.eventSequence = Math.max(session.eventSequence, sequence);
        ctx.appendTimeline(session, {
          kind: "tool",
          id: event.toolCallId,
          sequence,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          occurredAt: event.occurredAt ?? new Date().toISOString(),
          name: event.name,
          ...(event.title ? { title: event.title } : {}),
          ...(event.toolKind ? { toolKind: event.toolKind } : {}),
          state: "running",
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
          ...(event.input !== undefined ? { input: event.input } : {}),
          ...(event.content !== undefined ? { content: event.content } : {}),
          ...(event.locations !== undefined ? { locations: event.locations } : {}),
        });
        ctx.persistSoon();
      }
    }
    if (event.type === "tool.updated") {
      const session = ctx.findSession(event.sessionId);
      const tool = session ? ctx.indexes(session).entries.get(event.toolCallId) : undefined;
      if (tool?.kind === "tool") {
        let changed = false;
        if (event.parentToolCallId !== undefined && event.parentToolCallId !== tool.parentToolCallId) { tool.parentToolCallId = event.parentToolCallId; changed = true; }
        if (event.input !== undefined && JSON.stringify(event.input) !== JSON.stringify(tool.input)) {
          tool.input = event.input;
          changed = true;
        }
        if (event.name !== undefined && event.name !== tool.name) { tool.name = event.name; changed = true; }
        if (event.title !== undefined && event.title !== tool.title) { tool.title = event.title; changed = true; }
        if (event.toolKind !== undefined && event.toolKind !== tool.toolKind) { tool.toolKind = event.toolKind; changed = true; }
        if (event.content !== undefined && JSON.stringify(event.content) !== JSON.stringify(tool.content)) { tool.content = event.content; changed = true; }
        if (event.locations !== undefined && JSON.stringify(event.locations) !== JSON.stringify(tool.locations)) { tool.locations = event.locations; changed = true; }
        if (event.output !== undefined && event.output !== tool.output) {
          tool.output = event.output;
          changed = true;
        }
        if (event.outputDelta !== undefined && event.outputDelta) {
          tool.output = `${typeof tool.output === "string" ? tool.output : ""}${event.outputDelta}`;
          changed = true;
        }
        if (event.terminalExitCode !== undefined && event.terminalExitCode !== tool.terminalExitCode) {
          tool.terminalExitCode = event.terminalExitCode;
          changed = true;
        }
        if (changed && session) {
          ctx.markEntry(session.id, tool);
          session.updatedAt = new Date().toISOString();
          ctx.persistSoon();
        }
      }
    }
    if (event.type === "tool.completed") {
      const session = ctx.findSession(event.sessionId);
      const tool = session ? ctx.indexes(session).entries.get(event.toolCallId) : undefined;
      if (session && tool?.kind === "tool") {
        let changed = false;
        const state = event.isError ? "error" : "done";
        if (tool.state !== state) { tool.state = state; changed = true; }
        if (event.output !== undefined && event.output !== tool.output) { tool.output = event.output; changed = true; }
        if (event.terminalExitCode !== undefined && event.terminalExitCode !== tool.terminalExitCode) { tool.terminalExitCode = event.terminalExitCode; changed = true; }
        if (changed) {
          ctx.markEntry(session.id, tool);
          session.updatedAt = new Date().toISOString();
          ctx.persistSoon();
        }
      }
    }
    if (event.type === "ui.status" && event.text && (event.key === "agent-activity" || event.key.startsWith("claude-subagent:"))) {
      const session = ctx.findSession(event.sessionId);
      if (session) {
        const isSubagent = event.key.startsWith("claude-subagent:");
        const sequence = event.sequence ?? ++session.eventSequence;
        session.eventSequence = Math.max(session.eventSequence, sequence);
        const id = isSubagent ? `subagent-${encodeURIComponent(event.key)}` : `status-${sequence}`;
        const existing = ctx.indexes(session).entries.get(id);
        if (existing?.kind === "status") {
          existing.text = event.text;
          existing.key = event.key;
          existing.subagentSessionId = event.subagentSessionId;
          existing.subagentCancellable = event.subagentCancellable;
          existing.subagentState = event.subagentState;
          ctx.markEntry(session.id, existing);
        } else if (!existing) {
          ctx.appendTimeline(session, {
            kind: "status", id, sequence,
            ...(event.turnId ? { turnId: event.turnId } : {}),
            occurredAt: event.occurredAt ?? new Date().toISOString(), key: event.key, text: event.text,
            ...(event.subagentSessionId ? { subagentSessionId: event.subagentSessionId } : {}),
            ...(event.subagentCancellable !== undefined ? { subagentCancellable: event.subagentCancellable } : {}),
            ...(event.subagentState ? { subagentState: event.subagentState } : {}),
          });
        }
        ctx.persistSoon();
      }
    }
    if (event.type === "provider.error" || (event.type === "notification" && event.level !== "info")) {
      const session = event.sessionId ? ctx.findSession(event.sessionId) : undefined;
      if (session) {
        const sequence = event.sequence ?? ++session.eventSequence;
        session.eventSequence = Math.max(session.eventSequence, sequence);
        const id = `notice-${sequence}`;
        if (!ctx.indexes(session).entries.has(id)) {
          ctx.appendTimeline(session, {
            kind: "notice",
            id,
            sequence,
            ...(event.turnId ? { turnId: event.turnId } : {}),
            occurredAt: event.occurredAt ?? new Date().toISOString(),
            level: event.type === "notification" ? event.level : "error",
            message: event.message,
          });
          session.updatedAt = new Date().toISOString();
          ctx.persistSoon();
        }
      }
    }
    if (event.type === "interaction.requested") {
      const session = ctx.findSession(event.sessionId);
      if (session && !ctx.indexes(session).entries.has(event.interactionId)) {
        const sequence = event.sequence ?? ++session.eventSequence;
        session.eventSequence = Math.max(session.eventSequence, sequence);
        ctx.appendTimeline(session, {
          kind: "interaction",
          id: event.interactionId,
          sequence,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          occurredAt: event.occurredAt ?? new Date().toISOString(),
          // Authorization URLs may contain short-lived OAuth state values. Keep
          // the actionable URL in the live event only; conversation history needs
          // the service host and outcome, not a reusable link or query string.
          interaction: event.interaction.kind === "url-consent"
            ? { ...event.interaction, url: "" }
            : event.interaction,
          state: "pending",
        });
        ctx.persistSoon();
      }
    }
    if (event.type === "interaction.responded") {
      const session = ctx.findSession(event.sessionId);
      const interaction = session ? ctx.indexes(session).entries.get(event.interactionId) : undefined;
      if (interaction?.kind === "interaction" && interaction.state === "pending") {
        interaction.state = event.value === null ? "cancelled" : "responded";
        interaction.response = event.value;
        interaction.reason = event.reason;
        if (session) { session.updatedAt = new Date().toISOString(); ctx.persistSoon(); }
      }
    }
    if ("sessionId" in event && event.sessionId) {
      const session = ctx.findSession(event.sessionId);
      const id = "messageId" in event ? event.messageId : "toolCallId" in event ? event.toolCallId : "interactionId" in event ? event.interactionId : event.type === "session.plan.updated" ? event.planId : event.type === "session.turn.diff.updated" ? `turn-diff-${encodeURIComponent(event.turnId)}` : event.sequence !== undefined && (event.type === "provider.error" || event.type === "notification") ? `notice-${event.sequence}` : event.type === "ui.status" && event.key === "agent-activity" ? `status-${event.sequence}` : event.type === "ui.status" && event.key.startsWith("claude-subagent:") ? `subagent-${encodeURIComponent(event.key)}` : undefined;
      const entry = session && id ? ctx.indexes(session).entries.get(id) : undefined;
      if (entry) ctx.markEntry(session!.id, entry);
    }
    ctx.broadcast(event);
    ctx.recordPerformance(`event.${event.type}`, performance.now() - started);
  }

  function createSessionEmitter(sessionId: string): (event: AgentEvent) => void {
    let activeTurnId: TurnId | undefined;
    let pendingDelta: Extract<AgentEvent, { type: "message.delta" }> | undefined;
    let deltaTimer: ReturnType<typeof setTimeout> | undefined;
    let lastDeltaFlushAt = Number.NEGATIVE_INFINITY;
    const flushDelta = () => {
      if (deltaTimer) clearTimeout(deltaTimer);
      deltaTimer = undefined;
      const delta = pendingDelta;
      pendingDelta = undefined;
      if (!delta) return;
      dispatch(delta);
      lastDeltaFlushAt = Date.now();
    };
    const dispatch = (event: AgentEvent) => {
      // A retired process cannot publish into a replacement runtime's generation.
      if (ctx.sessionEmitters.get(sessionId) !== sessionEmit) return;
      if (!("sessionId" in event) || event.sessionId !== sessionId) {
        emit(event);
        return;
      }
      if (event.type === "message.started" && event.role === "user") activeTurnId = randomUUID();
      // Providers can emit a few delayed activity updates after their turn has
      // already completed. Without a turn ID these become orphan timeline rows
      // between the previous answer and the next user message.
      if (event.type === "ui.status" && event.key === "agent-activity" && event.text && !activeTurnId && !event.turnId) return;
      const session = ctx.findSession(sessionId);
      if (!session) { emit(event); return; }
      // History and reconnection can repeat a start. Its existing identity and
      // turn belong to the stored timeline, not the current runtime/turn.
      if (event.type === "tool.started" && ctx.indexes(session).entries.has(event.toolCallId)) return;
      if (event.type === "session.state" && event.state === "ended") {
        for (const entry of [...session.timeline]) {
          if (entry.kind === "tool" && entry.state === "running") dispatch({ type: "tool.completed", sessionId, toolCallId: entry.id, isError: true, output: "Agent 进程已退出，操作结果未确认" });
          if (entry.kind === "interaction" && entry.state === "pending") dispatch({ type: "interaction.responded", sessionId, interactionId: entry.id, value: null, reason: "interrupted" });
        }
        dispatch({ type: "session.queue.updated", sessionId, queue: { steering: [], followUp: [] } });
      }
      const enriched: AgentEvent = {
        ...event,
        sequence: ++session.eventSequence,
        occurredAt: new Date().toISOString(),
        ...(activeTurnId && event.type !== "session.state" ? { turnId: activeTurnId } : {}),
      };
      emit(enriched);
      ctx.persistSoon();
      if (event.type === "session.state" && (event.state === "idle" || event.state === "ended")) activeTurnId = undefined;
      if (event.type === "session.state" && event.state === "ended") {
        const agent = ctx.liveAgents.get(sessionId);
        ctx.liveAgents.delete(sessionId);
        ctx.sessionEmitters.delete(sessionId);
        ctx.sessionEmitterFlushers.delete(sessionId);
        if (agent) void agent.dispose().catch(() => undefined);
      }
    };
    ctx.sessionEmitterFlushers.set(sessionId, flushDelta);
    const sessionEmit = (event: AgentEvent) => {
      if (event.type !== "message.delta" || event.sessionId !== sessionId) {
        flushDelta();
        dispatch(event);
        return;
      }

      if (pendingDelta && pendingDelta.messageId === event.messageId) {
        pendingDelta.text += event.text;
      } else {
        flushDelta();
        pendingDelta = { ...event };
      }

      // Keep the first token immediate. Coalesce subsequent provider fragments
      // into at most one Host/UI update per 60 ms while preserving event order.
      if (Date.now() - lastDeltaFlushAt >= 60) {
        flushDelta();
      } else if (!deltaTimer) {
        deltaTimer = setTimeout(flushDelta, 60 - (Date.now() - lastDeltaFlushAt));
        deltaTimer.unref?.();
      }
    };
    return sessionEmit;
  }
  return { emit, createSessionEmitter };
}
