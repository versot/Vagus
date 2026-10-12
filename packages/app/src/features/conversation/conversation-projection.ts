import { recordPerformance } from "../../lib/performance.js";
import { isVisibleChatMessage } from "./conversation-presentation.js";
import type { ChatInteraction, ChatMessage, ChatNotice, ChatPlan, ChatStatus, ChatTurnDiff, ToolActivity } from "./types.js";

export type ConversationEntry =
  | { kind: "message"; order: number; value: ChatMessage }
  | { kind: "tool"; order: number; value: ToolActivity }
  | { kind: "status"; order: number; value: ChatStatus }
  | { kind: "interaction"; order: number; value: ChatInteraction }
  | { kind: "notice"; order: number; value: ChatNotice }
  | { kind: "plan"; order: number; value: ChatPlan }
  | { kind: "turnDiff"; order: number; value: ChatTurnDiff }
  | { kind: "duration"; order: number; turnId: string; userOrder: number; startedAt: string; completedAt?: string; finalAssistantMessageId?: string; active: boolean };

function sameDuration(a: ChatMessage, b: ChatMessage) {
  return a.role === b.role && a.turnId === b.turnId && a.order === b.order && a.occurredAt === b.occurredAt && a.complete === b.complete && a.completedAt === b.completedAt && isVisibleChatMessage(a) === isVisibleChatMessage(b);
}
function key(entry: ConversationEntry) { return entry.kind === "duration" ? `duration:${entry.turnId}` : `${entry.kind}:${entry.value.id}`; }

/** Reuse order and Turn metadata when only one message's text changes. */
export class ConversationProjection {
  private ordered: ConversationEntry[] = [];
  private positions = new Map<string, number>();
  private values = new Map<string, ConversationEntry>();
  private sortKeys = new Map<string, readonly [number, number, number]>();
  private messages = new Map<string, ChatMessage>();
  private durations: ConversationEntry[] = [];
  private busy = false;
  getDurations() { return this.durations as Extract<ConversationEntry, { kind: "duration" }>[]; }
  update(input: { messages: ChatMessage[]; displayMessages: ChatMessage[]; activities: ToolActivity[]; statuses: ChatStatus[]; interactions: ChatInteraction[]; notices: ChatNotice[]; plans?: ChatPlan[]; turnDiffs?: ChatTurnDiff[]; busy: boolean }) {
    const started = performance.now();
    let durationChanged = this.busy !== input.busy || this.messages.size !== input.messages.length;
    const nextMessages = new Map<string, ChatMessage>();
    for (const message of input.messages) {
      const previous = this.messages.get(message.id);
      if (!previous || (previous !== message && !sameDuration(previous, message))) durationChanged = true;
      nextMessages.set(message.id, message);
    }
    this.messages = nextMessages;
    this.busy = input.busy;
    if (durationChanged) {
      const users = input.displayMessages.filter((message) => message.role === "user" && message.turnId && message.occurredAt);
      // A send starts before the provider confirms the new user message. During
      // that short optimistic-preview window, do not mistake the last *old*
      // user message for the active turn: doing so hides its final answer and
      // turn diff while the new prompt is being accepted.
      const latestVisibleUser = input.displayMessages.reduce<ChatMessage | undefined>((latest, message) =>
        message.role === "user" && isVisibleChatMessage(message) && (!latest || message.order > latest.order) ? message : latest,
        undefined);
      const activeTurnId = input.busy ? latestVisibleUser?.turnId : undefined;
      const lastAssistant = new Map<string, ChatMessage>();
      // A completed assistant message is not necessarily the turn's final
      // answer: Codex and ACP agents can emit several assistant messages in a
      // single turn. Keep every message inside the active turn's fold until
      // the session reports that the whole turn has finished.
      for (const message of input.messages) if (message.role === "assistant" && message.turnId && message.turnId !== activeTurnId && isVisibleChatMessage(message) && message.complete && message.completedAt) {
        if (message.order > (lastAssistant.get(message.turnId)?.order ?? -Infinity)) lastAssistant.set(message.turnId, message);
      }
      this.durations = users.flatMap((user): ConversationEntry[] => {
        const assistant = lastAssistant.get(user.turnId!);
        const active = user.turnId === activeTurnId;
        return active || assistant?.completedAt ? [{ kind: "duration", order: user.order + .5, userOrder: user.order, turnId: user.turnId!, startedAt: user.occurredAt!, ...(!active && assistant?.completedAt ? { completedAt: assistant.completedAt } : {}), ...(assistant ? { finalAssistantMessageId: assistant.id } : {}), active }] : [];
      });
    }
    const candidates: ConversationEntry[] = [];
    const collect = <T extends ChatMessage | ToolActivity | ChatStatus | ChatInteraction | ChatNotice | ChatPlan | ChatTurnDiff>(kind: Exclude<ConversationEntry["kind"], "duration">, values: T[]) => {
      for (const value of values) {
        const id = `${kind}:${value.id}`;
        const previous = this.values.get(id);
        candidates.push(previous && previous.kind !== "duration" && previous.value === value ? previous : { kind, order: value.order, value } as ConversationEntry);
      }
    };
    collect("message", input.displayMessages.filter(isVisibleChatMessage)); collect("tool", input.activities); collect("status", input.statuses); collect("interaction", input.interactions); collect("notice", input.notices); collect("plan", input.plans ?? []); collect("turnDiff", input.turnDiffs ?? []);
    candidates.push(...this.durations);
    const turnStarts = new Map<string, number>();
    for (const user of input.displayMessages) {
      if (user.role === "user" && user.turnId) turnStarts.set(user.turnId, Math.min(turnStarts.get(user.turnId) ?? Infinity, user.order));
    }
    const nextSortKeys = new Map<string, readonly [number, number, number]>();
    let topologyChanged = candidates.length !== this.ordered.length;
    for (const entry of candidates) {
      const entryKey = key(entry);
      const turnId = entry.kind === "duration" ? entry.turnId : entry.value.turnId;
      const turnStart = turnId ? turnStarts.get(turnId) : undefined;
      // Events belonging to one turn stay with its user message, even if a
      // provider delivers them with an earlier sequence. Keep their native
      // order inside that turn.
      const sortKey: readonly [number, number, number] = turnStart === undefined
        ? [entry.order, 1, entry.order]
        : [turnStart, entry.kind === "message" && entry.value.role === "user" ? 0 : entry.kind === "duration" ? 1 : 2, entry.order];
      nextSortKeys.set(entryKey, sortKey);
      const previousSortKey = this.sortKeys.get(entryKey);
      if (!previousSortKey || previousSortKey.some((value, index) => value !== sortKey[index])) topologyChanged = true;
    }
    let ordered = this.ordered;
    for (const entry of candidates) {
      const index = this.positions.get(key(entry));
      if (index === undefined || this.ordered[index]?.order !== entry.order) { topologyChanged = true; break; }
      if (this.ordered[index] !== entry) { if (ordered === this.ordered) ordered = [...ordered]; ordered[index] = entry; }
    }
    if (topologyChanged) {
      ordered = candidates.sort((a, b) => {
        const aKey = nextSortKeys.get(key(a))!;
        const bKey = nextSortKeys.get(key(b))!;
        return aKey[0] - bKey[0] || aKey[1] - bKey[1] || aKey[2] - bKey[2];
      });
      this.positions = new Map(ordered.map((entry, index) => [key(entry), index]));
    }
    this.sortKeys = nextSortKeys;
    this.values = new Map(candidates.map((entry) => [key(entry), entry]));
    this.ordered = ordered;
    recordPerformance("timeline.project", performance.now() - started);
    return ordered;
  }
}
