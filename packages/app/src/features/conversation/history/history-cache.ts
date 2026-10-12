import type { ChatInteraction, ChatMessage, ChatNotice, ChatPlan, ChatStatus, ChatTurnDiff, ToolActivity } from "../types.js";

export type HistoryWindow = {
  sessionId: string;
  messages: ChatMessage[];
  activities: ToolActivity[];
  statuses: ChatStatus[];
  interactions: ChatInteraction[];
  notices: ChatNotice[];
  plans: ChatPlan[];
  turnDiffs: ChatTurnDiff[];
  queries: ChatMessage[];
  beforeSequence: number | null;
  hasMore: boolean;
};

// Only discard older pages when leaving a chat or explicitly returning to its
// bottom. Reading, editing and pending interactions retain their current page.
export function recentWindow(window: HistoryWindow, limit = 360): HistoryWindow {
  const entries = [...window.messages, ...window.activities, ...window.statuses, ...window.interactions, ...window.notices, ...window.plans, ...window.turnDiffs].sort((a, b) => a.order - b.order);
  if (entries.length <= limit || window.interactions.some((entry) => entry.state === "pending")) return window;
  let index = entries.length - limit;
  const turn = entries[index]!.turnId;
  if (turn) while (index > 0 && entries[index - 1]!.turnId === turn) index--;
  if (!index) return window;
  const cutoff = entries[index]!.order;
  return {
    ...window,
    messages: window.messages.filter((entry) => entry.order >= cutoff),
    activities: window.activities.filter((entry) => entry.order >= cutoff),
    statuses: window.statuses.filter((entry) => entry.order >= cutoff),
    interactions: window.interactions.filter((entry) => entry.order >= cutoff),
    notices: window.notices.filter((entry) => entry.order >= cutoff),
    plans: window.plans.filter((entry) => entry.order >= cutoff),
    turnDiffs: window.turnDiffs.filter((entry) => entry.order >= cutoff),
    beforeSequence: cutoff,
    hasMore: true,
  };
}

export class HistoryCache {
  clear() { this.windows.clear(); }
  private windows = new Map<string, { window: HistoryWindow; bytes: number }>();
  get(sessionId: string) {
    const saved = this.windows.get(sessionId);
    if (saved) { this.windows.delete(sessionId); this.windows.set(sessionId, saved); }
    return saved?.window;
  }
  set(window: HistoryWindow) {
    const recent = recentWindow(window);
    // Estimate retained serializable text, not total JS heap/AST overhead.
    const bytes = estimateSize(recent, 8 * 1024 * 1024);
    this.windows.delete(window.sessionId);
    if (bytes > 8 * 1024 * 1024) return;
    this.windows.set(window.sessionId, { window: recent, bytes });
    let total = [...this.windows.values()].reduce((sum, value) => sum + value.bytes, 0);
    for (const [id, saved] of this.windows) {
      if (this.windows.size <= 3 && total <= 8 * 1024 * 1024) break;
      this.windows.delete(id); total -= saved.bytes;
    }
  }
}

function estimateSize(value: unknown, budget: number): number {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let size = 0;
  while (pending.length && size <= budget) {
    const item = pending.pop();
    if (typeof item === "string") size += item.length * 2;
    else if (typeof item === "number") size += 8;
    else if (typeof item === "boolean") size += 4;
    else if (item && typeof item === "object" && !seen.has(item)) {
      seen.add(item);
      for (const [key, child] of Object.entries(item)) { size += key.length * 2; pending.push(child); }
    }
  }
  return size;
}
