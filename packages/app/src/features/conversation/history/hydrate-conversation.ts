import { type WorkspaceSession } from "@vagus/client";
import type { ChatInteraction, ChatMessage, ChatNotice, ChatPlan, ChatStatus, ChatTurnDiff, ToolActivity } from "../types.js";

export function hydrateConversation(session: WorkspaceSession): { messages: ChatMessage[]; activities: ToolActivity[]; statuses: ChatStatus[]; interactions: ChatInteraction[]; notices: ChatNotice[]; plans: ChatPlan[]; turnDiffs: ChatTurnDiff[]; nextOrder: number } {
  if (session.timeline?.length) {
    const messages: ChatMessage[] = [];
    const activities: ToolActivity[] = [];
    const statuses: ChatStatus[] = [];
    const interactions: ChatInteraction[] = [];
    const notices: ChatNotice[] = [];
    const plans: ChatPlan[] = [];
    const turnDiffs: ChatTurnDiff[] = [];
    for (const entry of session.timeline) {
      if (entry.kind === "message") {
        messages.push({ id: entry.id, role: entry.role, text: entry.text, complete: entry.complete, order: entry.sequence, occurredAt: entry.occurredAt, completedAt: entry.completedAt, ...(entry.contentDeferred ? { contentDeferred: true as const } : {}), ...(entry.turnId ? { turnId: entry.turnId } : {}), ...(entry.attachments?.length ? { attachments: entry.attachments } : {}), ...(entry.browserElements?.length ? { browserElements: entry.browserElements } : {}) });
      } else if (entry.kind === "tool") {
        activities.push({ id: entry.id, name: entry.name, ...(entry.title ? { title: entry.title } : {}), ...(entry.toolKind ? { toolKind: entry.toolKind } : {}), state: entry.state, order: entry.sequence, ...(entry.turnId ? { turnId: entry.turnId } : {}), ...(entry.parentToolCallId ? { parentToolCallId: entry.parentToolCallId } : {}), ...(entry.input !== undefined ? { input: entry.input } : {}), ...(entry.content !== undefined ? { content: entry.content } : {}), ...(entry.locations !== undefined ? { locations: entry.locations } : {}), ...(entry.output !== undefined ? { output: entry.output } : {}), ...(entry.terminalExitCode !== undefined ? { terminalExitCode: entry.terminalExitCode } : {}), ...(entry.contentDeferred ? { contentDeferred: true as const } : {}) });
      } else if (entry.kind === "status") {
        if ((entry.key === "agent-activity" && entry.turnId) || entry.key.startsWith("claude-subagent:") || entry.key.startsWith("subagent:")) statuses.push({ id: entry.id, order: entry.sequence, ...(entry.turnId ? { turnId: entry.turnId } : {}), key: entry.key, text: entry.text, ...(entry.subagentSessionId ? { subagentSessionId: entry.subagentSessionId } : {}), ...(entry.subagentCancellable !== undefined ? { subagentCancellable: entry.subagentCancellable } : {}), ...(entry.subagentState ? { subagentState: entry.subagentState } : {}) });
      } else if (entry.kind === "interaction") {
        interactions.push({ id: entry.id, order: entry.sequence, ...(entry.turnId ? { turnId: entry.turnId } : {}), interaction: entry.interaction, state: entry.state, reason: entry.reason, ...(entry.response !== undefined ? { response: entry.response } : {}) });
      } else if (entry.kind === "plan") {
        plans.push({ id: entry.id, order: entry.sequence, ...(entry.turnId ? { turnId: entry.turnId } : {}), ...(entry.explanation ? { explanation: entry.explanation } : {}), steps: entry.steps });
      } else if (entry.kind === "turnDiff") {
        turnDiffs.push({ id: entry.id, order: entry.sequence, turnId: entry.turnId, diff: entry.diff, ...(entry.truncated ? { truncated: true } : {}) });
      } else {
        notices.push({ id: entry.id, order: entry.sequence, ...(entry.turnId ? { turnId: entry.turnId } : {}), level: entry.level, message: entry.message });
      }
    }
    const highestSequence = session.timeline.reduce((highest, entry) => Math.max(highest, entry.sequence), 0);
    return { messages, activities, statuses, interactions, notices, plans, turnDiffs, nextOrder: Math.max(session.eventSequence ?? 0, highestSequence + 1) };
  }
  const messages = (session.messages ?? []).map((message, index) => ({
    ...message,
    order: message.sequence ?? index,
    occurredAt: message.occurredAt,
    ...(message.turnId ? { turnId: message.turnId } : {}),
  }));
  return { messages, activities: [], statuses: [], interactions: [], notices: [], plans: [], turnDiffs: [], nextOrder: Math.max(session.eventSequence ?? 0, messages.length) };
}

export function mergeHistoryItems<T extends { id: string; order: number }>(older: T[], current: T[]): T[] {
  return [...new Map([...older, ...current].map((item) => [item.id, item])).values()].sort((a, b) => a.order - b.order);
}
