import { type SessionTimelineEntry } from "@vagus/protocol";
import type { HostContext } from "../runtime/host-context.js";
import { sessionMetadata, type Message, type WorkspaceSession } from "./workspace-records.js";

export interface HistoryServicesContract {
  findSession(id: string): WorkspaceSession | undefined;
  indexes(session: WorkspaceSession): { messages: Map<string, Message>; entries: Map<string, SessionTimelineEntry>; };
  appendMessage(session: WorkspaceSession, message: Message): void;
  appendTimeline(session: WorkspaceSession, entry: SessionTimelineEntry): void;
  markEntry(sessionId: string, entry: SessionTimelineEntry): void;
  registerHistory(session: WorkspaceSession): void;
  trimHostHistory(): void;
  loadHistory(session: WorkspaceSession): Promise<void>;
  nativeHistoryIds(id: string): string[];
  historyMessageKey(entry: Extract<SessionTimelineEntry, { kind: "message"; }>): string;
  mergeCodexHistory(session: WorkspaceSession, nativeEntries: SessionTimelineEntry[]): boolean;
  loadDatabase(): Promise<void>;
  persistNow(): Promise<void>;
  persistSoon(): void;
}

type HistoryServicesDependencies = Pick<HostContext, "agentStarts" | "database" | "dirtyEntries" | "entryIndexes" | "liveAgents" | "loadedHistories" | "loadingHistories" | "sessionArray" | "sessionIndex" | "store" | "writeQueue" | "writeTimer">;

export function createHistoryServices(ctx: HistoryServicesDependencies): HistoryServicesContract {
  function findSession(id: string) {
    if (ctx.sessionArray !== ctx.database.sessions || ctx.sessionIndex.size !== ctx.database.sessions.length) {
      ctx.sessionArray = ctx.database.sessions;
      ctx.sessionIndex = new Map(ctx.database.sessions.map((session) => [session.id, session]));
    }
    return ctx.sessionIndex.get(id);
  }

  function indexes(session: WorkspaceSession) {
    let index = ctx.entryIndexes.get(session);
    if (!index) { index = { messages: new Map(session.messages.map((message) => [message.id, message])), entries: new Map(session.timeline.map((entry) => [entry.id, entry])) }; ctx.entryIndexes.set(session, index); }
    return index;
  }

  function appendMessage(session: WorkspaceSession, message: Message) { indexes(session).messages.set(message.id, message); session.messages.push(message); }

  function appendTimeline(session: WorkspaceSession, entry: SessionTimelineEntry) { indexes(session).entries.set(entry.id, entry); session.timeline.push(entry); markEntry(session.id, entry); }

  function markEntry(sessionId: string, entry: SessionTimelineEntry) { ctx.dirtyEntries.set(sessionId + ":" + entry.id, { sessionId, entry }); }

  function registerHistory(session: WorkspaceSession) {
    ctx.loadedHistories.set(session.id, Date.now());
    for (const entry of session.timeline) markEntry(session.id, entry);
  }

  function trimHostHistory() {
    const dirtyIds = new Set([...ctx.dirtyEntries.values()].map((item) => item.sessionId));
    const idle = [...ctx.loadedHistories.keys()].filter((id) => !ctx.liveAgents.has(id) && !ctx.agentStarts.has(id) && !ctx.loadingHistories.has(id) && !dirtyIds.has(id));
    for (const id of idle.slice(0, Math.max(0, idle.length - 4))) {
      const session = findSession(id);
      if (session) { session.messages = []; session.timeline = []; ctx.entryIndexes.delete(session); }
      ctx.loadedHistories.delete(id);
    }
  }

  async function loadHistory(session: WorkspaceSession) {
    if (ctx.loadedHistories.has(session.id)) { ctx.loadedHistories.delete(session.id); ctx.loadedHistories.set(session.id, Date.now()); return; }
    const pending = ctx.loadingHistories.get(session.id);
    if (pending) return pending;
    const load = (async () => {
      await ctx.writeQueue;
      const timeline = await ctx.store.read(session.id);
      session.timeline = timeline;
      session.messages = timeline.flatMap((entry) => entry.kind === "message" ? [{ ...entry }] : []);
      ctx.entryIndexes.delete(session);
      ctx.loadedHistories.set(session.id, Date.now());
    })();
    ctx.loadingHistories.set(session.id, load);
    try { await load; } finally { ctx.loadingHistories.delete(session.id); trimHostHistory(); }
  }

  function nativeHistoryIds(id: string): string[] {
    return id.startsWith("codex-") ? [id, id.slice("codex-".length)] : [id, `codex-${id}`];
  }

  function historyMessageKey(entry: Extract<SessionTimelineEntry, { kind: "message" }>): string {
    const attachments = (entry.attachments ?? []).map((attachment) => `${attachment.mimeType}:${attachment.size}`).sort();
    return JSON.stringify([entry.role, entry.text.replace(/\s+/gu, " ").trim(), attachments]);
  }

  function mergeCodexHistory(session: WorkspaceSession, nativeEntries: SessionTimelineEntry[]): boolean {
    const sessionIndexes = indexes(session);
    const localMessages = new Map<string, Extract<SessionTimelineEntry, { kind: "message" }>[]>();
    for (const entry of session.timeline) {
      if (entry.kind !== "message" || entry.id.startsWith("codex-")) continue;
      const key = historyMessageKey(entry);
      const matches = localMessages.get(key) ?? [];
      matches.push(entry);
      localMessages.set(key, matches);
    }
    const takeLocalMessage = (entry: SessionTimelineEntry) => {
      if (entry.kind !== "message" || entry.id.startsWith("codex-")) return undefined;
      const key = historyMessageKey(entry);
      const matches = localMessages.get(key);
      const local = matches?.shift();
      if (matches && matches.length === 0) localMessages.delete(key);
      return local;
    };
    const migratedTurnIds = new Map<string, string>();
    let changed = false;
    const associateLocalMessage = (local: Extract<SessionTimelineEntry, { kind: "message" }>, native: Extract<SessionTimelineEntry, { kind: "message" }>) => {
      if (!native.turnId) return;
      if (local.turnId && local.turnId !== native.turnId) migratedTurnIds.set(local.turnId, native.turnId);
      local.turnId = native.turnId;
      const message = sessionIndexes.messages.get(local.id);
      if (message) message.turnId = native.turnId;
      markEntry(session.id, local);
      changed = true;
    };
    for (const nativeEntry of nativeEntries) {
      const existing = nativeHistoryIds(nativeEntry.id).map((id) => sessionIndexes.entries.get(id)).find((entry) => entry?.kind === nativeEntry.kind);
      if (existing) {
        const duplicateLocalMessage = takeLocalMessage(existing);
        if (duplicateLocalMessage && nativeEntry.kind === "message") associateLocalMessage(duplicateLocalMessage, nativeEntry);
        const before = JSON.stringify(existing);
        const previousTurnId = existing.turnId;
        const refreshed = { ...nativeEntry, id: existing.id, sequence: existing.sequence, occurredAt: existing.occurredAt } as SessionTimelineEntry;
        if (existing.kind === "message" && refreshed.kind === "message") {
          if (previousTurnId && refreshed.turnId && previousTurnId !== refreshed.turnId) migratedTurnIds.set(previousTurnId, refreshed.turnId);
          if (!refreshed.attachments?.length && existing.attachments?.length) refreshed.attachments = existing.attachments;
          if (!refreshed.completedAt && existing.completedAt) refreshed.completedAt = existing.completedAt;
          Object.assign(existing, refreshed);
          const message = sessionIndexes.messages.get(existing.id);
          if (message) {
            message.text = refreshed.text;
            message.complete = refreshed.complete;
            message.sequence = refreshed.sequence;
            message.occurredAt = refreshed.occurredAt;
            if (refreshed.turnId) message.turnId = refreshed.turnId; else delete message.turnId;
            if (refreshed.completedAt) message.completedAt = refreshed.completedAt; else delete message.completedAt;
            if (refreshed.attachments?.length) message.attachments = refreshed.attachments;
          }
        } else Object.assign(existing, refreshed);
        if (JSON.stringify(existing) !== before) { markEntry(session.id, existing); changed = true; }
        continue;
      }
      if (nativeEntry.kind === "message") {
        const local = takeLocalMessage(nativeEntry);
        if (local) {
          associateLocalMessage(local, nativeEntry);
          if (nativeEntry.turnId) changed = true;
          continue;
        }
      }
      const entry = { ...nativeEntry, sequence: ++session.eventSequence } as SessionTimelineEntry;
      appendTimeline(session, entry);
      if (entry.kind === "message") {
        appendMessage(session, {
          id: entry.id, role: entry.role, text: entry.text, complete: entry.complete, sequence: entry.sequence,
          ...(entry.turnId ? { turnId: entry.turnId } : {}), occurredAt: entry.occurredAt,
          ...(entry.completedAt ? { completedAt: entry.completedAt } : {}), ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
        });
        if (entry.role === "user") session.lastUserAt = entry.occurredAt;
        else if (entry.complete) { session.lastAssistantAt = entry.completedAt ?? entry.occurredAt; session.hasAssistantReply = true; }
      }
      changed = true;
    }
    if (migratedTurnIds.size) {
      for (const entry of session.timeline) {
        const nextTurnId = entry.turnId ? migratedTurnIds.get(entry.turnId) : undefined;
        if (!nextTurnId) continue;
        entry.turnId = nextTurnId;
        if (entry.kind === "message") {
          const message = sessionIndexes.messages.get(entry.id);
          if (message) message.turnId = nextTurnId;
        }
        markEntry(session.id, entry);
        changed = true;
      }
    }
    if (changed) {
      session.updatedAt = new Date().toISOString();
      session.eventSequence = Math.max(session.eventSequence, ...session.timeline.map((entry) => entry.sequence));
    }
    return changed;
  }

  async function loadDatabase(): Promise<void> {
    const stored = await ctx.store.load();
    ctx.database = { projects: stored.projects, sessions: stored.sessions.map((session) => ({ ...session, state: "ended", messages: [], timeline: [] })) };
    await persistNow();
  }

  function persistNow(): Promise<void> {
    if (ctx.writeTimer) { clearTimeout(ctx.writeTimer); ctx.writeTimer = undefined; }
    const entries = structuredClone([...ctx.dirtyEntries.values()]);
    ctx.dirtyEntries.clear();
    const projects = structuredClone(ctx.database.projects);
    const sessions = structuredClone(ctx.database.sessions.map(sessionMetadata));
    const save = ctx.writeQueue.catch(() => undefined).then(() => ctx.store.save(projects, sessions, entries));
    ctx.writeQueue = save;
    void save.then(trimHostHistory).catch(() => {
      for (const item of entries) if (!ctx.dirtyEntries.has(item.sessionId + ":" + item.entry.id)) {
        const current = findSession(item.sessionId);
        if (current) markEntry(item.sessionId, indexes(current).entries.get(item.entry.id) ?? item.entry);
      }
    });
    return save;
  }

  function persistSoon(): void {
    if (ctx.writeTimer) return;
    ctx.writeTimer = setTimeout(() => {
      ctx.writeTimer = undefined;
      void persistNow().catch((error: unknown) => process.stderr.write(`Vagus workspace save failed: ${String(error)}\n`));
    }, 350);
  }
  return { findSession, indexes, appendMessage, appendTimeline, markEntry, registerHistory, trimHostHistory, loadHistory, nativeHistoryIds, historyMessageKey, mergeCodexHistory, loadDatabase, persistNow, persistSoon };
}
