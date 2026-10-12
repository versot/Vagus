import type { RpcRequest as Request, ScheduledTask, ScheduledTaskFrequency } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { HostContext } from "../runtime/host-context.js";

export interface ScheduledTaskRequestHandlerContract {
  handleScheduledTaskRequest(client: WebSocket, request: Request): Promise<boolean>;
}

type ScheduledTaskRequestHandlerDependencies = Pick<HostContext, "createScheduledSession" | "database" | "emit" | "findSession" | "nextScheduledTaskAt" | "permanentlyDeleteSessions" | "persistSoon" | "providerEnabled" | "providerHealth" | "providerModelCatalogs" | "providers" | "respond" | "runScheduledTask" | "scheduledTaskMutations" | "scheduledTasks" | "sessionTitleFromFirstMessage" | "store">;

export function createScheduledTaskRequestHandler(ctx: ScheduledTaskRequestHandlerDependencies): ScheduledTaskRequestHandlerContract {
  async function handleScheduledTaskRequest(client: WebSocket, request: Request): Promise<boolean> {
    switch (request.type) {
      case "scheduled-tasks.list": {
        for (const current of [...ctx.scheduledTasks]) {
          if (current.sessionId && ctx.findSession(current.sessionId)?.scheduledTaskId === current.id) continue;
          const previousSessionId = current.sessionId ?? current.lastSessionId;
          const previousSession = previousSessionId ? ctx.findSession(previousSessionId) : undefined;
          if (previousSession) {
            previousSession.scheduledTaskId = current.id;
            const migrated: ScheduledTask = { ...current, sessionId: previousSession.id, lastSessionId: previousSession.id, title: current.title || previousSession.title };
            ctx.scheduledTasks = ctx.scheduledTasks.map((item) => item.id === current.id ? migrated : item);
            await ctx.store.putScheduledTask(migrated); ctx.persistSoon(); ctx.emit({ type: "workspace.changed" });
            continue;
          }
          const catalog = ctx.providerModelCatalogs.get(current.providerId);
          const legacyModelId = current.modelId ?? catalog?.currentModelId ?? catalog?.models[0]?.id;
          if (!legacyModelId || ctx.providerHealth(current.providerId) !== "healthy") continue;
          try {
            const session = await ctx.createScheduledSession(current.id, current.prompt, current.projectId, current.providerId, legacyModelId, current.thinkingLevel, current.modeId ?? null);
            const migrated: ScheduledTask = { ...current, title: current.title || session.title, sessionId: session.id, modelId: legacyModelId };
            ctx.scheduledTasks = ctx.scheduledTasks.map((item) => item.id === current.id ? migrated : item);
            await ctx.store.putScheduledTask(migrated);
          } catch { /* Keep the existing task visible when its Agent cannot yet start. */ }
        }
        ctx.respond(client, request.id, ctx.scheduledTasks); return true;
      }
      case "scheduled-tasks.create": {
        const projectId = request.payload.projectId;
        if (projectId && !ctx.database.projects.some((item) => item.id === projectId)) throw new Error("找不到这个项目");
        const providerId = request.payload.providerId;
        const provider = ctx.providers.get(providerId);
        if (!provider || ctx.providerEnabled.get(providerId) === false || ctx.providerHealth(providerId) !== "healthy") throw new Error("请选择当前已启用且健康的 Agent");
        const catalog = ctx.providerModelCatalogs.get(providerId);
        const modelId = request.payload.modelId;
        const model = catalog?.models.find((item) => item.id === modelId);
        if (!model) throw new Error("所选模型不在 Agent 当前目录中，请刷新后重试");
        const thinkingLevel = request.payload.thinkingLevel ?? null;
        if (thinkingLevel && !model.thinkingLevels?.includes(thinkingLevel)) throw new Error("所选模型不支持这个思考程度");
        const modeId = request.payload.modeId ?? null;
        if (modeId && !catalog?.availableModes?.some((mode) => mode.id === modeId)) throw new Error(`${provider.descriptor.displayName} 未公布此会话模式`);
        const timeZone = request.payload.timeZone;
        try { new Intl.DateTimeFormat("en-US", { timeZone }).format(); }
        catch { throw new Error("请选择有效的时区"); }
        if (request.payload.frequency === "weekly" && request.payload.weekday === null) throw new Error("请选择每周运行的日期");
        const prompt = request.payload.prompt.trim();
        if (!prompt) throw new Error("请填写任务内容");
        const id = randomUUID();
        const session = await ctx.createScheduledSession(id, prompt, projectId, providerId, modelId, thinkingLevel, modeId);
        const task: ScheduledTask = {
          id, title: ctx.sessionTitleFromFirstMessage(prompt), sessionId: session.id,
          projectId, prompt, providerId, modelId, thinkingLevel: session.runtimeSettings?.thinkingLevel ?? null, modeId: session.runtimeSettings?.currentModeId ?? modeId,
          frequency: request.payload.frequency as ScheduledTaskFrequency, weekday: request.payload.weekday,
          time: request.payload.time, timeZone,
          enabled: request.payload.enabled,
          createdAt: new Date().toISOString(), nextRunAt: request.payload.enabled ? ctx.nextScheduledTaskAt({ frequency: request.payload.frequency, weekday: request.payload.weekday, time: request.payload.time, timeZone }) : null,
          lastRunAt: null, lastRunStatus: null,
        };
        try { await ctx.store.putScheduledTask(task); }
        catch (error) {
          // Keep a successfully created Agent session visible if task persistence fails.
          const orphan = ctx.findSession(session.id);
          if (orphan) { orphan.scheduledTaskId = undefined; ctx.persistSoon(); ctx.emit({ type: "workspace.changed" }); }
          throw error;
        }
        ctx.scheduledTasks = [task, ...ctx.scheduledTasks];
        ctx.respond(client, request.id, task); return true;
      }
      case "scheduled-tasks.set-enabled": {
        const task = ctx.scheduledTasks.find((item) => item.id === request.payload.taskId);
        if (!task) throw new Error("找不到这个定时任务");
        if (ctx.scheduledTaskMutations.has(task.id)) throw new Error("任务正在更新，请稍后再试");
        if (task.lastRunStatus === "running") throw new Error("任务正在运行，请等待本次执行完成");
        const enabled = request.payload.enabled;
        const updated: ScheduledTask = { ...task, enabled, nextRunAt: enabled ? ctx.nextScheduledTaskAt(task) : null };
        await ctx.store.putScheduledTask(updated);
        ctx.scheduledTasks = ctx.scheduledTasks.map((item) => item.id === task.id ? updated : item);
        ctx.respond(client, request.id, updated); return true;
      }
      case "scheduled-tasks.run-now": {
        const task = ctx.scheduledTasks.find((item) => item.id === request.payload.taskId);
        if (!task) throw new Error("找不到这个定时任务");
        if (task.lastRunStatus === "running") throw new Error("这个任务已经在运行");
        if (ctx.scheduledTaskMutations.has(task.id)) throw new Error("任务正在更新，请稍后再试");
        await ctx.runScheduledTask(task.id, true);
        const updated = ctx.scheduledTasks.find((item) => item.id === task.id);
        if (!updated) throw new Error("任务在执行期间已被删除");
        ctx.respond(client, request.id, updated); return true;
      }
      case "scheduled-tasks.update": {
        const task = ctx.scheduledTasks.find((item) => item.id === request.payload.taskId);
        if (!task) throw new Error("找不到这个定时任务");
        if (ctx.scheduledTaskMutations.has(task.id)) throw new Error("任务正在更新，请稍后再试");
        if (task.lastRunStatus === "running") throw new Error("任务正在提交到 Agent，请稍后再编辑");
        const prompt = request.payload.prompt.trim();
        if (!prompt) throw new Error("请填写任务内容");
        if (request.payload.frequency === "weekly" && request.payload.weekday === null) throw new Error("请选择每周运行的日期");
        try { new Intl.DateTimeFormat("en-US", { timeZone: request.payload.timeZone }).format(); }
        catch { throw new Error("请选择有效的时区"); }
        ctx.scheduledTaskMutations.add(task.id);
        try {
          const session = task.sessionId ? ctx.findSession(task.sessionId) : undefined;
          if (session && (session.state === "running" || session.state === "starting")) throw new Error("任务会话正在运行，请等待回复完成后再编辑");
          const updated: ScheduledTask = {
            ...task,
            prompt,
            title: ctx.sessionTitleFromFirstMessage(prompt),
            frequency: request.payload.frequency,
            weekday: request.payload.weekday,
            time: request.payload.time,
            timeZone: request.payload.timeZone,
            nextRunAt: task.enabled ? ctx.nextScheduledTaskAt({ frequency: request.payload.frequency, weekday: request.payload.weekday, time: request.payload.time, timeZone: request.payload.timeZone }) : null,
          };
          await ctx.store.putScheduledTask(updated);
          ctx.scheduledTasks = ctx.scheduledTasks.map((item) => item.id === task.id ? updated : item);
          if (session && !session.titleManuallySet) { session.title = updated.title; ctx.persistSoon(); ctx.emit({ type: "workspace.changed" }); }
          ctx.respond(client, request.id, updated); return true;
        } finally { ctx.scheduledTaskMutations.delete(task.id); }
      }
      case "scheduled-tasks.delete": {
        const id = request.payload.taskId;
        const task = ctx.scheduledTasks.find((item) => item.id === id);
        if (task && ctx.scheduledTaskMutations.has(task.id)) throw new Error("任务正在更新，请稍后再试");
        if (task?.lastRunStatus === "running") throw new Error("任务正在提交到 Agent，暂时无法删除");
        const sessionId = task?.sessionId ?? task?.lastSessionId;
        const session = sessionId ? ctx.findSession(sessionId) : undefined;
        if (session && session.scheduledTaskId !== id) throw new Error("任务会话归属校验失败，为避免误删，任务和会话都未删除");
        if (session && (session.state === "running" || session.state === "starting")) throw new Error("任务会话正在运行，请等待回复完成后再删除");
        ctx.scheduledTaskMutations.add(id);
        try {
          // Remove the dedicated conversation and its Pi-native file before the task row.
          // If native deletion fails, the task remains available so the user can retry.
          if (session) await ctx.permanentlyDeleteSessions([session]);
          await ctx.store.deleteScheduledTask(id);
          ctx.scheduledTasks = ctx.scheduledTasks.filter((item) => item.id !== id);
          ctx.respond(client, request.id, { deleted: 1 }); return true;
        } finally { ctx.scheduledTaskMutations.delete(id); }
      }
      default: return false;
    }
  }
  return { handleScheduledTaskRequest };
}
