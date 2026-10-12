import type { AgentSession, SessionStorageReference } from "@vagus/agent-core";
import type { RpcRequest as Request } from "@vagus/protocol";
import { type SessionTimelineEntry } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { WebSocket } from "ws";
import type { HostContext } from "../runtime/host-context.js";
import { type WorkspaceSession } from "../storage/workspace-records.js";

export interface SessionLifecycleRequestHandlerContract {
  handleSessionLifecycleRequest(client: WebSocket, request: Request): Promise<boolean>;
}

type SessionLifecycleRequestHandlerDependencies = Pick<HostContext, "agentLastActivity" | "createSessionEmitter" | "database" | "emit" | "findSession" | "liveAgents" | "loadHistory" | "permanentlyDeleteSessions" | "persistSoon" | "providerEnabled" | "providerHealth" | "providerModelCatalogs" | "providers" | "provisioningSessionIds" | "publicSessionSummary" | "registerHistory" | "respond" | "sessionEmitterFlushers" | "sessionEmitters">;

export function createSessionLifecycleRequestHandler(ctx: SessionLifecycleRequestHandlerDependencies): SessionLifecycleRequestHandlerContract {
  async function handleSessionLifecycleRequest(client: WebSocket, request: Request): Promise<boolean> {
    switch (request.type) {
      case "sessions.import": {
        const providerId = String(request.payload.providerId ?? "");
        const sourceId = String(request.payload.sourceId ?? "");
        const provider = ctx.providers.get(providerId);
        if (!provider) throw new Error("找不到这个 Agent 提供方");
        if (!provider.importSession) throw new Error("这个 Agent 暂不支持导入本机会话");
        const imported = await provider.importSession(sourceId);
        if (imported.candidate.providerId !== providerId || !imported.candidate.workingDirectory) throw new Error("Provider 返回的本机会话信息无效");
        const sourcePath = imported.storageReference.sessionFile;
        const sourceSessionId = imported.storageReference.sessionId;
        if (ctx.database.sessions.some((session) => session.providerId === providerId && (session.providerImportSourceId === sourceId || Boolean(sourcePath && session.providerStorageReference?.sessionFile?.toLocaleLowerCase() === sourcePath.toLocaleLowerCase()) || Boolean(sourceSessionId && session.providerStorageReference?.sessionId === sourceSessionId)))) {
          throw new Error("这个本机会话已经导入过了");
        }
        const normalizePath = (path: string) => path.replace(/[\\/]+$/, "").toLocaleLowerCase();
        const workingDirectory = imported.candidate.workingDirectory;
        const projectRoots = [...new Set([workingDirectory, ...(imported.candidate.additionalDirectories ?? [])].map((root) => root.trim()).filter(Boolean))];
        const normalizedRoots = projectRoots.map(normalizePath).sort();
        let project = ctx.database.projects.find((item) => {
          const roots = (item.roots?.length ? item.roots : [item.root]).map(normalizePath).sort();
          return roots.length === normalizedRoots.length && roots.every((root, index) => root === normalizedRoots[index]);
        });
        if (!project) {
          project = { id: randomUUID(), name: workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) || `${provider.descriptor.displayName} 项目`, root: workingDirectory, roots: projectRoots, createdAt: new Date().toISOString() };
          ctx.database.projects.unshift(project);
        }
        const createdAt = imported.candidate.createdAt;
        const messages = imported.timeline.filter((entry): entry is Extract<SessionTimelineEntry, { kind: "message" }> => entry.kind === "message").map((entry) => ({
          id: entry.id, role: entry.role, text: entry.text, complete: entry.complete, sequence: entry.sequence, ...(entry.turnId ? { turnId: entry.turnId } : {}), occurredAt: entry.occurredAt, ...(entry.completedAt ? { completedAt: entry.completedAt } : {}), ...(entry.attachments ? { attachments: entry.attachments } : {}), ...(entry.browserElements ? { browserElements: entry.browserElements } : {}),
        }));
        const lastUser = [...messages].reverse().find((message) => message.role === "user");
        const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
        const session: WorkspaceSession = {
          id: randomUUID(), projectId: project.id, title: imported.candidate.title || `${provider.descriptor.displayName} 会话`, titleManuallySet: true,
          createdAt, updatedAt: imported.candidate.updatedAt, state: "ended", messages, timeline: imported.timeline,
          eventSequence: imported.timeline.reduce((max, entry) => Math.max(max, entry.sequence), 0), providerId,
          providerStorageReference: imported.storageReference, providerImportSourceId: sourceId, lastUserAt: lastUser?.occurredAt,
          lastAssistantAt: lastAssistant?.occurredAt, hasAssistantReply: Boolean(lastAssistant),
        };
        ctx.database.sessions.unshift(session);
        ctx.registerHistory(session);
        ctx.persistSoon();
        ctx.emit({ type: "workspace.changed" });
        ctx.respond(client, request.id, ctx.publicSessionSummary(session));
        return true;
      }
      case "sessions.create": {
        const projectId = typeof request.payload.projectId === "string" ? request.payload.projectId : null;
        const project = projectId ? ctx.database.projects.find((item) => item.id === projectId) : undefined;
        if (projectId && !project) throw new Error("找不到这个项目");
        const providerId = String(request.payload.providerId ?? "pi");
        const provider = ctx.providers.get(providerId);
        if (!provider) throw new Error("这个 Agent 提供方尚未接入");
        if (ctx.providerEnabled.get(providerId) === false) throw new Error("这个 Agent 已禁用，请先在设置中启用");
        if (ctx.providerHealth(providerId) !== "healthy") throw new Error("这个 Agent 尚未通过健康检测，请稍后重试");
        const modelId = typeof request.payload.modelId === "string" && request.payload.modelId ? request.payload.modelId : null;
        const thinkingLevel = typeof request.payload.thinkingLevel === "string" && request.payload.thinkingLevel ? request.payload.thinkingLevel : null;
        const modeId = typeof request.payload.modeId === "string" && request.payload.modeId ? request.payload.modeId : null;
        if (modelId) {
          const catalog = ctx.providerModelCatalogs.get(providerId);
          if (!catalog?.models.some((model) => model.id === modelId)) throw new Error("新会话所选模型不在 Agent 当前可用目录中，请刷新后重试");
          if (thinkingLevel) {
            const model = catalog.models.find((item) => item.id === modelId);
            if (!model?.thinkingLevels?.includes(thinkingLevel)) throw new Error("所选模型不支持这个思考程度");
          }
        } else if (thinkingLevel) {
          throw new Error("请先选择模型，再选择思考程度");
        }
        const sessionId = randomUUID();
        const record: WorkspaceSession = { id: sessionId, projectId: project?.id ?? null, title: "新会话", titleManuallySet: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "starting", messages: [], timeline: [], eventSequence: 0 };
        ctx.database.sessions.unshift(record); ctx.provisioningSessionIds.add(sessionId); ctx.registerHistory(record); ctx.persistSoon();
        record.providerId = providerId;
        let agent: AgentSession | undefined;
        try {
          const sessionEmit = ctx.createSessionEmitter(sessionId);
          ctx.sessionEmitters.set(sessionId, sessionEmit);
          agent = await provider.startSession({ sessionId, workingDirectory: project?.root ?? homedir() }, sessionEmit);
          if (agent.available === false || ctx.sessionEmitters.get(sessionId) !== sessionEmit) throw new Error("Agent 在创建过程中退出，请重试");
          record.providerId = provider.descriptor.id;
          record.providerStorageReference = agent.storageReference;
          ctx.liveAgents.set(sessionId, agent);
          ctx.agentLastActivity.set(sessionId, Date.now());
          if (agent.getRuntimeSettings) {
            let runtimeSettings = await agent.getRuntimeSettings();
            if (modelId && runtimeSettings.modelId !== modelId) {
              if (!agent.setModel) throw new Error("当前 Agent 暂不支持为新会话选择模型");
              runtimeSettings = await agent.setModel(modelId);
            }
            // A model catalog can be cached while the live ACP session exposes
            // fewer config options. Apply thinking only when this session
            // explicitly advertises the requested value; otherwise keep the
            // agent's actual default instead of failing session creation.
            if (thinkingLevel && runtimeSettings.thinkingLevels?.includes(thinkingLevel) && runtimeSettings.thinkingLevel !== thinkingLevel) {
              if (!agent.setThinkingLevel) throw new Error("当前 Agent 暂不支持为新会话设置思考程度");
              runtimeSettings = await agent.setThinkingLevel(thinkingLevel);
            }
            if (modeId && runtimeSettings.availableModes?.some((mode) => mode.id === modeId) && runtimeSettings.currentModeId !== modeId) {
              if (!agent.setMode) throw new Error("当前 Agent 暂不支持切换会话模式");
              runtimeSettings = await agent.setMode(modeId);
            }
            record.runtimeSettings = runtimeSettings;
          }
          record.state = "idle"; ctx.provisioningSessionIds.delete(sessionId); ctx.persistSoon(); ctx.respond(client, request.id, ctx.publicSessionSummary(record));
        } catch (error) {
          if (agent) { ctx.liveAgents.delete(sessionId); await agent.dispose().catch(() => undefined); }
          ctx.sessionEmitters.delete(sessionId);
          ctx.sessionEmitterFlushers.delete(sessionId);
          ctx.provisioningSessionIds.delete(sessionId);
          ctx.database.sessions = ctx.database.sessions.filter((item) => item.id !== sessionId); ctx.persistSoon();
          ctx.emit({ type: "workspace.changed" });
          throw error;
        }
        return true;
      }
      case "sessions.branch": {
        const source = ctx.findSession(String(request.payload.sessionId ?? ""));
        const messageId = String(request.payload.messageId ?? "");
        if (!source) throw new Error("会话不存在");
        await ctx.loadHistory(source);
        if (source.state === "running" || source.state === "starting") throw new Error("请等待当前回复完成后再创建分支");
        const target = messageId
          ? source.messages.find((message) => message.id === messageId && message.role === "assistant" && message.complete)
          : [...source.messages].reverse().find((message) => message.role === "assistant" && message.complete);
        if (!target) throw new Error(messageId ? "找不到这条已完成的助手回复" : "这个聊天还没有可作为分叉点的已完成助手回复");
        const providerId = source.providerId ?? "pi";
        if (providerId === "opencode") {
          const latestCompletedAssistant = [...source.messages]
            .filter((message) => message.role === "assistant" && message.complete)
            .sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0))[0];
          const hasLaterUserMessage = source.messages.some((message) => message.role === "user" && (message.sequence ?? 0) > (target.sequence ?? 0));
          if (latestCompletedAssistant?.id !== target.id || hasLaterUserMessage) {
            throw new Error("OpenCode 的 ACP 分支目前只能从当前会话最新的已完成回复创建");
          }
        }
        const provider = ctx.providers.get(providerId);
        if (!provider || !source.providerStorageReference || Object.keys(source.providerStorageReference).length === 0) throw new Error("这个会话缺少可分支的 Agent 记录");
        const project = source.projectId ? ctx.database.projects.find((item) => item.id === source.projectId) : undefined;
        const matchingOccurrence = source.messages
          .filter((message) => message.role === "assistant" && message.text === target.text && (message.sequence ?? 0) <= (target.sequence ?? Number.MAX_SAFE_INTEGER))
          .length - 1;
        let branchReference: SessionStorageReference | undefined;
        let codexSourceRuntimeToRelease: AgentSession | undefined;
        // Fork through the live source session when one is already open. Codex
        // holds an exclusive writer for a resumed thread; opening a second
        // app-server solely to fork that same thread fails with
        // "already has an active writer". Offline sessions still use a short-
        // lived adapter instance so providers can recover their native state.
        const sourceAgent = ctx.liveAgents.get(source.id);
        if (sourceAgent && sourceAgent.available !== false) {
          if (!sourceAgent.forkAfterAssistantMessage) throw new Error("这个 Agent 暂不支持分支会话");
          branchReference = await sourceAgent.forkAfterAssistantMessage(target.text, matchingOccurrence, target.id);
          if (providerId === "codex") codexSourceRuntimeToRelease = sourceAgent;
        } else {
          const temporaryAgent = await provider.startSession({
            sessionId: randomUUID(),
            workingDirectory: project?.root ?? homedir(),
            resumeReference: source.providerStorageReference,
          }, () => undefined);
          try {
            if (!temporaryAgent.forkAfterAssistantMessage) throw new Error("这个 Agent 暂不支持分支会话");
            branchReference = await temporaryAgent.forkAfterAssistantMessage(target.text, matchingOccurrence, target.id);
          } finally {
            await temporaryAgent.dispose();
          }
        }
        if (!branchReference || Object.keys(branchReference).length === 0) throw new Error("Agent 没有返回新的分支会话记录");

        // Codex app-server keeps the forked thread loaded under the source
        // process, which owns its exclusive writer lock. The branch record
        // below is resumed in its own provider process, so release the source
        // runtime first. The source conversation remains persisted and will
        // resume lazily if the user returns to it.
        if (codexSourceRuntimeToRelease) {
          if (ctx.liveAgents.get(source.id) === codexSourceRuntimeToRelease) ctx.liveAgents.delete(source.id);
          ctx.agentLastActivity.delete(source.id);
          ctx.sessionEmitters.delete(source.id);
          ctx.sessionEmitterFlushers.delete(source.id);
          await codexSourceRuntimeToRelease.dispose();
        }

        const followingUser = source.messages
          .filter((message) => message.role === "user" && (message.sequence ?? 0) > (target.sequence ?? 0))
          .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))[0];
        const cutoff = followingUser?.sequence ?? Number.POSITIVE_INFINITY;
        const messages = source.messages.filter((message) => (message.sequence ?? 0) < cutoff).map((message) => ({ ...message }));
        const timeline = source.timeline.filter((entry) => entry.sequence < cutoff).map((entry) => ({ ...entry }));
        const sessionId = randomUUID();
        const createdAt = new Date().toISOString();
        const branchRootSessionId = source.branchRootSessionId ?? source.id;
        const branchBaseTitle = source.branchBaseTitle ?? source.title;
        const branchNumber = ctx.database.sessions.filter((item) => item.branchRootSessionId === branchRootSessionId).length + 2;
        const branch: WorkspaceSession = {
          id: sessionId,
          projectId: source.projectId,
          title: `${branchBaseTitle}（${branchNumber}）`,
          titleManuallySet: Boolean(source.titleManuallySet),
          branchRootSessionId,
          branchBaseTitle,
          createdAt,
          updatedAt: createdAt,
          state: "starting",
          messages,
          timeline,
          eventSequence: timeline.reduce((max, entry) => Math.max(max, entry.sequence), 0),
          providerId,
          providerStorageReference: branchReference,
        };
        ctx.database.sessions.unshift(branch); ctx.registerHistory(branch);
        ctx.persistSoon();
        let agent: AgentSession | undefined;
        try {
          const sessionEmit = ctx.createSessionEmitter(sessionId);
          ctx.sessionEmitters.set(sessionId, sessionEmit);
          agent = await provider.startSession({
            sessionId,
            workingDirectory: project?.root ?? homedir(),
            resumeReference: branchReference,
          }, sessionEmit);
          if (agent.available === false || ctx.sessionEmitters.get(sessionId) !== sessionEmit) throw new Error("Agent 在分支恢复过程中退出，请重试");
          ctx.liveAgents.set(sessionId, agent);
          branch.providerStorageReference = agent.storageReference ?? branchReference;
          if (agent.getRuntimeSettings) branch.runtimeSettings = await agent.getRuntimeSettings();
          // Codex may restore a fork with its default reasoning effort even
          // after the native fork accepted the source settings. Re-apply the
          // source session's visible configuration after resume so a branch
          // keeps the model, effort, and permission mode the user selected.
          if (providerId === "codex" && source.runtimeSettings) {
            const desired = source.runtimeSettings;
            let restored = branch.runtimeSettings;
            if (desired.modelId && restored?.modelId !== desired.modelId) {
              if (!agent.setModel) throw new Error("Codex 分支无法恢复原会话模型");
              restored = await agent.setModel(desired.modelId);
            }
            if (desired.thinkingLevel && restored?.thinkingLevel !== desired.thinkingLevel) {
              if (!agent.setThinkingLevel) throw new Error("Codex 分支无法恢复原会话思考程度");
              restored = await agent.setThinkingLevel(desired.thinkingLevel);
            }
            if (desired.currentModeId && restored?.currentModeId !== desired.currentModeId) {
              if (!agent.setMode) throw new Error("Codex 分支无法恢复原会话权限模式");
              restored = await agent.setMode(desired.currentModeId);
            }
            if (restored) branch.runtimeSettings = restored;
          }
          branch.state = "idle";
          branch.updatedAt = new Date().toISOString();
          ctx.persistSoon();
          ctx.emit({ type: "workspace.changed" });
          ctx.respond(client, request.id, ctx.publicSessionSummary(branch));
        } catch (error) {
          if (agent) { ctx.liveAgents.delete(sessionId); await agent.dispose().catch(() => undefined); }
          ctx.sessionEmitters.delete(sessionId);
          ctx.sessionEmitterFlushers.delete(sessionId);
          ctx.database.sessions = ctx.database.sessions.filter((item) => item.id !== sessionId);
          await provider.deleteSession?.(branchReference).catch(() => undefined);
          ctx.persistSoon();
          throw error;
        }
        return true;
      }
      case "sessions.archive": {
        const session = ctx.findSession(String(request.payload.sessionId ?? ""));
        if (!session) throw new Error("会话不存在");
        session.archivedAt ??= new Date().toISOString();
        ctx.persistSoon(); ctx.emit({ type: "workspace.changed" }); ctx.respond(client, request.id, ctx.publicSessionSummary(session)); return true;
      }
      case "sessions.rename": {
        const session = ctx.findSession(String(request.payload.sessionId ?? ""));
        if (!session) throw new Error("会话不存在");
        const title = String(request.payload.title ?? "").trim();
        if (!title) throw new Error("聊天名称不能为空");
        session.title = title;
        session.titleManuallySet = true;
        ctx.persistSoon(); ctx.emit({ type: "workspace.changed" }); ctx.respond(client, request.id, ctx.publicSessionSummary(session)); return true;
      }
      case "sessions.archive-in-project": {
        const projectId = String(request.payload.projectId ?? "");
        if (!ctx.database.projects.some((item) => item.id === projectId)) throw new Error("找不到这个项目");
        const archivedAt = new Date().toISOString();
        const sessionIds: string[] = [];
        for (const session of ctx.database.sessions) {
          if (session.projectId === projectId && !session.archivedAt && !session.scheduledTaskId) { session.archivedAt = archivedAt; sessionIds.push(session.id); }
        }
        if (sessionIds.length > 0) ctx.persistSoon();
        if (sessionIds.length > 0) ctx.emit({ type: "workspace.changed" });
        ctx.respond(client, request.id, { archived: sessionIds.length, sessionIds }); return true;
      }
      case "sessions.unarchive": {
        const session = ctx.findSession(String(request.payload.sessionId ?? ""));
        if (!session) throw new Error("会话不存在");
        delete session.archivedAt;
        ctx.persistSoon(); ctx.emit({ type: "workspace.changed" }); ctx.respond(client, request.id, ctx.publicSessionSummary(session)); return true;
      }
      case "sessions.delete-archived": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        if (!session) throw new Error("会话不存在");
        if (!session.archivedAt) throw new Error("只能永久删除已归档的聊天");
        const deleted = await ctx.permanentlyDeleteSessions([session]);
        ctx.respond(client, request.id, { deleted }); return true;
      }
      case "sessions.delete-permanent": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        if (!session) throw new Error("会话不存在");
        const deleted = await ctx.permanentlyDeleteSessions([session]);
        ctx.respond(client, request.id, { deleted }); return true;
      }
      case "sessions.delete-archived-in-project": {
        const projectId = String(request.payload.projectId ?? "");
        if (!ctx.database.projects.some((item) => item.id === projectId)) throw new Error("找不到这个项目");
        const archived = ctx.database.sessions.filter((session) => session.projectId === projectId && session.archivedAt);
        const deleted = await ctx.permanentlyDeleteSessions(archived);
        ctx.respond(client, request.id, { deleted }); return true;
      }
      case "sessions.delete-archived-all": {
        const archived = ctx.database.sessions.filter((session) => Boolean(session.archivedAt));
        const deleted = await ctx.permanentlyDeleteSessions(archived);
        ctx.respond(client, request.id, { deleted }); return true;
      }
      default: return false;
    }
  }
  return { handleSessionLifecycleRequest };
}
