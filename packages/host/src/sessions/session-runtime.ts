import type { AgentSession } from "@vagus/agent-core";
import { homedir } from "node:os";
import type { HostContext } from "../runtime/host-context.js";
import { type WorkspaceSession } from "../storage/workspace-records.js";

export interface SessionRuntimeServicesContract {
  sessionTitleFromFirstMessage(text: string): string;
  reclaimIdleAgents(now?: number): Promise<void>;
  publicSession(session: WorkspaceSession): import("@vagus/protocol").WorkspaceSession;
  publicSessionSummary(session: WorkspaceSession): import("@vagus/protocol").WorkspaceSession;
  permanentlyDeleteSessions(sessions: WorkspaceSession[]): Promise<number>;
  ensureLiveAgent(session: WorkspaceSession): Promise<AgentSession>;
}

type SessionRuntimeServicesDependencies = Pick<HostContext, "agentLastActivity" | "agentStarts" | "compactingSessions" | "createSessionEmitter" | "database" | "dirtyEntries" | "emit" | "findSession" | "idleAgentTtlMs" | "liveAgents" | "loadHistory" | "loadedHistories" | "maxIdleAgents" | "mergeCodexHistory" | "nativeHistoryIds" | "persistNow" | "persistSoon" | "providers" | "recordPerformance" | "sessionEmitterFlushers" | "sessionEmitters" | "sessionUi" | "trimHostHistory">;

export function createSessionRuntimeServices(ctx: SessionRuntimeServicesDependencies): SessionRuntimeServicesContract {
  function sessionTitleFromFirstMessage(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return "图片消息";
    const characters = Array.from(normalized);
    return characters.length > 80 ? `${characters.slice(0, 80).join("")}…` : normalized;
  }

  async function reclaimIdleAgents(now = Date.now()) {
    const idle = [...ctx.liveAgents.entries()].flatMap(([id, agent]) => {
      const session = ctx.findSession(id);
      if (!session || !agent.suspend || session.state !== "idle" || ctx.agentStarts.has(id) || ctx.compactingSessions.has(id)
        || (session.queue?.steering.length ?? 0) > 0 || (session.queue?.followUp.length ?? 0) > 0
        || session.timeline.some((entry) => entry.kind === "interaction" && entry.state === "pending")) return [];
      return [{ id, agent, session, last: ctx.agentLastActivity.get(id) ?? now }];
    }).sort((a, b) => a.last - b.last);
    for (const item of idle) {
      const overBudget = idle.filter((candidate) => ctx.liveAgents.has(candidate.id)).length > ctx.maxIdleAgents;
      if (now - item.last < ctx.idleAgentTtlMs && !overBudget) continue;
      try {
        await ctx.persistNow();
        await item.agent.suspend!();
        if (ctx.liveAgents.get(item.id) === item.agent) ctx.liveAgents.delete(item.id);
        ctx.sessionEmitters.delete(item.id);
        ctx.sessionEmitterFlushers.delete(item.id);
        ctx.agentLastActivity.delete(item.id);
        ctx.trimHostHistory();
        ctx.recordPerformance("agent.runtime.suspended", 0);
      } catch (error) {
        ctx.recordPerformance("agent.runtime.suspendError", 0);
        process.stderr.write(`Vagus could not suspend idle Agent ${item.id}: ${String(error)}\\n`);
      }
    }
  }

  function publicSession({ providerStorageReference: _storageReference, providerImportSourceId: _importSourceId, titleManuallySet: _manualTitle, branchRootSessionId: _branchRootSessionId, branchBaseTitle: _branchBaseTitle, ...session }: WorkspaceSession) {
    const hasRuntime = ctx.sessionEmitters.has(session.id);
    const state = (session.state === "running" || session.state === "starting") && !hasRuntime
      ? "ended"
      : session.state;
    const ui = ctx.sessionUi.get(session.id) ?? { statuses: [], widgets: [] };
    return { ...session, state, ui };
  }

  function publicSessionSummary(session: WorkspaceSession) {
    const { messages, timeline: _timeline, ...summary } = publicSession(session);
    let lastUserAt = session.lastUserAt;
    let hasAssistantReply = Boolean(session.hasAssistantReply || session.lastAssistantAt);
    for (let index = messages.length - 1; index >= 0 && (!lastUserAt || !hasAssistantReply); index--) {
      const message = messages[index]!;
      if (!lastUserAt && message.role === "user") lastUserAt = message.occurredAt ?? session.createdAt;
      if (message.role === "assistant" && message.complete) hasAssistantReply = true;
      if (lastUserAt && hasAssistantReply) break;
    }
    return { ...summary, lastUserAt: lastUserAt ?? session.createdAt, hasAssistantReply };
  }

  async function permanentlyDeleteSessions(sessions: WorkspaceSession[]): Promise<number> {
    for (const session of sessions) {
      const provider = ctx.providers.get(session.providerId ?? "pi");
      if (!session.providerStorageReference || !provider?.deleteSession) {
        throw new Error(`“${session.title}”缺少可验证的 Pi 原生会话文件位置。为避免误删，Vagus 和 Pi 中的记录都未删除。`);
      }
    }

    for (const session of sessions) {
      const agent = ctx.liveAgents.get(session.id);
      if (agent) {
        if (session.state === "running" || session.state === "starting") {
          let stopTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            agent.cancel().catch(() => undefined),
            new Promise<void>((resolve) => { stopTimer = setTimeout(resolve, 3_000); }),
          ]);
          if (stopTimer) clearTimeout(stopTimer);
        }
        await agent.dispose();
        ctx.liveAgents.delete(session.id);
      }
      ctx.sessionEmitters.delete(session.id);
      ctx.sessionEmitterFlushers.delete(session.id);
      ctx.agentLastActivity.delete(session.id);
      ctx.loadedHistories.delete(session.id);
      for (const [key, entry] of ctx.dirtyEntries) if (entry.sessionId === session.id) ctx.dirtyEntries.delete(key);
      const provider = ctx.providers.get(session.providerId ?? "pi")!;
      await provider.deleteSession!(session.providerStorageReference!);
    }

    const deletedIds = new Set(sessions.map((session) => session.id));
    const previousSessions = ctx.database.sessions;
    ctx.database.sessions = previousSessions.filter((session) => !deletedIds.has(session.id));
    try {
      await ctx.persistNow();
    } catch (error) {
      ctx.database.sessions = previousSessions;
      ctx.persistSoon();
      throw new Error(`Pi 原生会话文件已删除，但 Vagus 记录未能保存删除结果：${error instanceof Error ? error.message : String(error)}`);
    }
    if (sessions.length > 0) ctx.emit({ type: "workspace.changed" });
    return sessions.length;
  }

  async function ensureLiveAgent(session: WorkspaceSession): Promise<AgentSession> {
    await ctx.loadHistory(session);
    const current = ctx.liveAgents.get(session.id);
    if (current?.available !== false && current) { ctx.agentLastActivity.set(session.id, Date.now()); return current; }
    if (current) { ctx.liveAgents.delete(session.id); await current.dispose().catch(() => undefined); }
    const starting = ctx.agentStarts.get(session.id);
    if (starting) return starting;

    const providerId = session.providerId ?? "pi";
    const provider = ctx.providers.get(providerId);
    const resumeReference = session.providerStorageReference;
    if (!provider || !resumeReference || Object.keys(resumeReference).length === 0) throw new Error("这个会话缺少可恢复的 Agent 记录，请新建会话继续");
    const project = session.projectId ? ctx.database.projects.find((item) => item.id === session.projectId) : undefined;
    const start = (async () => {
      const sessionEmit = ctx.createSessionEmitter(session.id);
      ctx.sessionEmitters.set(session.id, sessionEmit);
      let agent: AgentSession | undefined;
      try {
        agent = await provider.startSession({
          sessionId: session.id,
          workingDirectory: project?.root ?? homedir(),
          additionalDirectories: (project?.roots ?? []).filter((root) => root.replace(/[\\/]+$/, "").toLocaleLowerCase() !== (project?.root ?? homedir()).replace(/[\\/]+$/, "").toLocaleLowerCase()),
          resumeReference,
        }, sessionEmit);
        if (agent.available === false || ctx.sessionEmitters.get(session.id) !== sessionEmit) { await agent.dispose().catch(() => undefined); throw new Error("Agent 在恢复过程中退出，请重试"); }
        if (providerId === "codex" && agent.readHistory) {
          try {
            const knownEntryIds = session.timeline.flatMap((entry) => ctx.nativeHistoryIds(entry.id));
            if (ctx.mergeCodexHistory(session, await agent.readHistory(knownEntryIds))) {
              ctx.persistSoon();
              ctx.emit({ type: "workspace.changed" });
              ctx.emit({ type: "session.history.updated", sessionId: session.id });
            }
          } catch (error) {
            process.stderr.write(`Vagus could not refresh Codex history for session ${session.id}: ${String(error)}\n`);
          }
        }
        ctx.liveAgents.set(session.id, agent);
        ctx.agentLastActivity.set(session.id, Date.now());
        session.providerStorageReference = agent.storageReference ?? session.providerStorageReference;
        if (agent.getRuntimeSettings) session.runtimeSettings = await agent.getRuntimeSettings();
        session.state = "idle";
        ctx.persistSoon();
        return agent;
      } catch (error) {
        if (ctx.sessionEmitters.get(session.id) === sessionEmit) {
          ctx.sessionEmitters.delete(session.id);
          ctx.sessionEmitterFlushers.delete(session.id);
          if (ctx.liveAgents.get(session.id) === agent) ctx.liveAgents.delete(session.id);
        }
        await agent?.dispose().catch(() => undefined);
        session.state = "ended";
        ctx.persistSoon();
        throw error;
      }
    })().finally(() => ctx.agentStarts.delete(session.id));
    ctx.agentStarts.set(session.id, start);
    return start;
  }
  return { sessionTitleFromFirstMessage, reclaimIdleAgents, publicSession, publicSessionSummary, permanentlyDeleteSessions, ensureLiveAgent };
}
