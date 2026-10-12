import type { AgentSession } from "@vagus/agent-core";
import type { ScheduledTask } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { HostContext } from "../runtime/host-context.js";
import { type WorkspaceSession } from "../storage/workspace-records.js";

export interface SchedulerServicesContract {
  zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; };
  zonedWallTimeToDate(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date;
  nextScheduledTaskAt(task: Pick<ScheduledTask, "frequency" | "weekday" | "time" | "timeZone">, after?: Date): string | null;
  runScheduledTask(taskId: string, manual?: boolean): Promise<void>;
  createScheduledSession(taskId: string, prompt: string, projectId: string | null, providerId: string, modelId: string, thinkingLevel?: string | null, modeId?: string | null): Promise<WorkspaceSession>;
  runDueScheduledTasks(now?: number): Promise<void>;
  recoverScheduledTasks(): Promise<void>;
}

type SchedulerServicesDependencies = Pick<HostContext, "agentLastActivity" | "createSessionEmitter" | "database" | "dirtyEntries" | "emit" | "ensureLiveAgent" | "findSession" | "liveAgents" | "loadedHistories" | "persistNow" | "persistSoon" | "providerEnabled" | "providerHealth" | "providerModelCatalogs" | "providers" | "refreshProviderModels" | "registerHistory" | "scheduledTaskMutations" | "scheduledTasks" | "sessionEmitterFlushers" | "sessionEmitters" | "sessionTitleFromFirstMessage" | "store">;

export function createSchedulerServices(ctx: SchedulerServicesDependencies): SchedulerServicesContract {
  function zonedParts(date: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return { year: Number(value.year), month: Number(value.month), day: Number(value.day), hour: Number(value.hour), minute: Number(value.minute) };
  }

  function zonedWallTimeToDate(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
    const desiredWallTime = Date.UTC(year, month - 1, day, hour, minute);
    const wallTimestamp = (date: Date) => {
      const local = zonedParts(date, timeZone);
      return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    };
    // Sample offsets on both sides of the target day. This handles DST folds
    // (choose the first matching instant) and gaps (move forward to the first
    // representable local time) without oscillating between pre/post-DST offsets.
    const offsets = new Set<number>();
    for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
      const sample = new Date(desiredWallTime + hours * 60 * 60_000);
      offsets.add(wallTimestamp(sample) - sample.getTime());
    }
    const candidates = [...offsets].map((offset) => new Date(desiredWallTime - offset));
    const exact = candidates.filter((candidate) => wallTimestamp(candidate) === desiredWallTime);
    if (exact.length) return exact.sort((a, b) => a.getTime() - b.getTime())[0]!;
    const afterGap = candidates
      .map((candidate) => ({ candidate, wallTime: wallTimestamp(candidate) }))
      .filter((entry) => entry.wallTime > desiredWallTime)
      .sort((a, b) => a.wallTime - b.wallTime || a.candidate.getTime() - b.candidate.getTime())[0];
    if (afterGap) return afterGap.candidate;
    throw new Error(`无法在时区 ${timeZone} 中解析计划时间`);
  }

  function nextScheduledTaskAt(task: Pick<ScheduledTask, "frequency" | "weekday" | "time" | "timeZone">, after = new Date()): string | null {
    const { year, month, day } = zonedParts(after, task.timeZone);
    const [hour, minute] = task.time.split(":").map(Number);
    for (let offset = 0; offset <= (task.frequency === "weekly" ? 8 : 7); offset++) {
      const calendarDay = new Date(Date.UTC(year, month - 1, day + offset));
      const candidate = zonedWallTimeToDate(calendarDay.getUTCFullYear(), calendarDay.getUTCMonth() + 1, calendarDay.getUTCDate(), hour!, minute!, task.timeZone);
      if (candidate.getTime() <= after.getTime()) continue;
      if (task.frequency === "weekdays" && (calendarDay.getUTCDay() === 0 || calendarDay.getUTCDay() === 6)) continue;
      if (task.frequency === "weekly" && calendarDay.getUTCDay() !== task.weekday) continue;
      return candidate.toISOString();
    }
    return null;
  }

  async function runScheduledTask(taskId: string, manual = false): Promise<void> {
    const task = ctx.scheduledTasks.find((item) => item.id === taskId);
    if (!task || (!manual && !task.enabled) || task.lastRunStatus === "running" || ctx.scheduledTaskMutations.has(taskId)) return;
    const runAt = new Date().toISOString();
    const nextRunAt = manual ? task.nextRunAt : task.frequency === "once" ? null : nextScheduledTaskAt(task, new Date());
    const running: ScheduledTask = { ...task, nextRunAt, lastRunAt: runAt, lastRunStatus: "running", lastRunError: undefined };
    ctx.scheduledTasks = ctx.scheduledTasks.map((item) => item.id === taskId ? running : item);
    try {
      await ctx.store.putScheduledTask(running);
      const project = running.projectId ? ctx.database.projects.find((item) => item.id === running.projectId) : undefined;
      if (running.projectId && !project) throw new Error("任务关联的工作空间已不存在");
      const provider = ctx.providers.get(running.providerId);
      if (!provider || ctx.providerEnabled.get(running.providerId) === false) throw new Error("任务所选 Agent 当前不可用");
      if (ctx.providerHealth(running.providerId) !== "healthy") await ctx.refreshProviderModels(running.providerId);
      if (ctx.providerHealth(running.providerId) !== "healthy") throw new Error("任务所选 Agent 当前不可用");
      const catalog = ctx.providerModelCatalogs.get(running.providerId);
      if (!running.modelId) throw new Error("任务没有关联模型，请重新创建任务");
      const model = catalog?.models.find((item) => item.id === running.modelId);
      if (!model) throw new Error("任务所选模型已不可用，请重新创建任务");
      if (running.thinkingLevel && !model.thinkingLevels?.includes(running.thinkingLevel)) throw new Error("所选模型不支持这个思考程度");
      const sessionId = running.sessionId ?? running.lastSessionId;
      const session = sessionId ? ctx.findSession(sessionId) : undefined;
      if (!session || session.scheduledTaskId !== taskId) throw new Error("任务专属会话不存在，请重新创建任务");
      const agent = await ctx.ensureLiveAgent(session);
      if (session.state === "running" || session.state === "starting") throw new Error("任务会话正在运行，请等待当前回复完成");
      // Restore the task's chosen configuration before each scheduled submission.
      if (agent.getRuntimeSettings) session.runtimeSettings = await agent.getRuntimeSettings();
      if (session.runtimeSettings?.modelId !== running.modelId) {
        if (!agent.setModel) throw new Error("当前 Agent 不支持选择模型");
        session.runtimeSettings = await agent.setModel(running.modelId);
      }
      if (running.thinkingLevel && session.runtimeSettings?.thinkingLevel !== running.thinkingLevel) {
        if (!agent.setThinkingLevel) throw new Error("当前 Agent 暂不支持为新会话设置思考程度");
        session.runtimeSettings = await agent.setThinkingLevel(running.thinkingLevel);
      }
      if (running.modeId && session.runtimeSettings?.currentModeId !== running.modeId) {
        if (!agent.setMode) throw new Error("当前 Agent 不支持切换会话模式");
        session.runtimeSettings = await agent.setMode(running.modeId);
      }
      ctx.persistSoon();
      await agent.sendText(running.prompt);
      const liveTask = ctx.scheduledTasks.find((item) => item.id === taskId)!;
      const completed: ScheduledTask = { ...liveTask, enabled: !manual && liveTask.frequency === "once" ? false : liveTask.enabled, lastRunStatus: "success", lastSessionId: session.id };
      ctx.scheduledTasks = ctx.scheduledTasks.map((item) => item.id === taskId ? completed : item);
      await ctx.store.putScheduledTask(completed);
    } catch (error) {
      const current = ctx.scheduledTasks.find((item) => item.id === taskId);
      if (current) {
        const failed: ScheduledTask = { ...current, enabled: !manual && current.frequency === "once" ? false : current.enabled, lastRunStatus: "error", lastRunError: error instanceof Error ? error.message : String(error) };
        ctx.scheduledTasks = ctx.scheduledTasks.map((item) => item.id === taskId ? failed : item);
        try { await ctx.store.putScheduledTask(failed); }
        catch (persistError) { process.stderr.write(`VAGUS_SCHEDULED_TASK_STATE_SAVE_FAILED ${taskId}: ${String(persistError)}\n`); }
      }
    }
  }

  async function createScheduledSession(taskId: string, prompt: string, projectId: string | null, providerId: string, modelId: string, thinkingLevel: string | null = null, modeId: string | null = null): Promise<WorkspaceSession> {
    const provider = ctx.providers.get(providerId);
    if (!provider || ctx.providerEnabled.get(providerId) === false || ctx.providerHealth(providerId) !== "healthy") throw new Error("请选择当前已启用且健康的 Agent");
    const project = projectId ? ctx.database.projects.find((item) => item.id === projectId) : undefined;
    if (projectId && !project) throw new Error("找不到这个项目");
    const sessionId = randomUUID();
    const record: WorkspaceSession = { id: sessionId, projectId: project?.id ?? null, title: ctx.sessionTitleFromFirstMessage(prompt), titleManuallySet: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: "starting", messages: [], timeline: [], eventSequence: 0, providerId, scheduledTaskId: taskId };
    ctx.database.sessions.unshift(record); ctx.registerHistory(record); ctx.persistSoon();
    let agent: AgentSession | undefined;
    try {
      const sessionEmit = ctx.createSessionEmitter(sessionId);
      ctx.sessionEmitters.set(sessionId, sessionEmit);
      agent = await provider.startSession({ sessionId, workingDirectory: project?.root ?? homedir() }, sessionEmit);
      if (agent.available === false || ctx.sessionEmitters.get(sessionId) !== sessionEmit) throw new Error("Agent 在创建任务会话时退出，请稍后重试");
      record.providerId = provider.descriptor.id;
      record.providerStorageReference = agent.storageReference;
      ctx.liveAgents.set(sessionId, agent);
      ctx.agentLastActivity.set(sessionId, Date.now());
      if (agent.getRuntimeSettings) {
        const settings = await agent.getRuntimeSettings();
        record.runtimeSettings = settings.modelId === modelId ? settings : await (agent.setModel ? agent.setModel(modelId) : Promise.reject(new Error("当前 Agent 不支持此模型")));
      } else if (agent.setModel) record.runtimeSettings = await agent.setModel(modelId);
      else throw new Error("当前 Agent 不支持选择模型");
      // ACP catalogs can expose thinking options from a temporary catalog
      // session, while the real session may narrow them after its model is set.
      // Only apply the requested level if the live session still publishes it;
      // otherwise keep the model's own default instead of failing creation.
      if (thinkingLevel && record.runtimeSettings?.thinkingLevel !== thinkingLevel && record.runtimeSettings?.thinkingLevels?.includes(thinkingLevel)) {
        if (!agent.setThinkingLevel) throw new Error("当前 Agent 暂不支持为新会话设置思考程度");
        record.runtimeSettings = await agent.setThinkingLevel(thinkingLevel);
      }
      if (modeId && record.runtimeSettings?.currentModeId !== modeId) {
        if (!record.runtimeSettings?.availableModes?.some((mode) => mode.id === modeId)) throw new Error(`${provider.descriptor.displayName} 未公布此会话模式`);
        if (!agent.setMode) throw new Error("当前 Agent 不支持切换会话模式");
        record.runtimeSettings = await agent.setMode(modeId);
      }
      record.state = "idle";
      ctx.persistSoon(); ctx.emit({ type: "workspace.changed" });
      return record;
    } catch (error) {
      if (agent) { ctx.liveAgents.delete(sessionId); await agent.dispose().catch(() => undefined); }
      ctx.sessionEmitters.delete(sessionId); ctx.sessionEmitterFlushers.delete(sessionId);
      ctx.database.sessions = ctx.database.sessions.filter((item) => item.id !== sessionId);
      ctx.loadedHistories.delete(sessionId);
      for (const key of ctx.dirtyEntries.keys()) if (key.startsWith(`${sessionId}:`)) ctx.dirtyEntries.delete(key);
      ctx.persistSoon();
      throw error;
    }
  }

  async function runDueScheduledTasks(now = Date.now()): Promise<void> {
    for (const task of ctx.scheduledTasks) {
      if (!task.enabled || !task.nextRunAt || new Date(task.nextRunAt).getTime() > now || task.lastRunStatus === "running") continue;
      try { await runScheduledTask(task.id); }
      catch (error) { process.stderr.write(`VAGUS_SCHEDULED_TASK_RUN_FAILED ${task.id}: ${String(error)}\n`); }
    }
  }
  async function recoverScheduledTasks(): Promise<void> {
    ctx.scheduledTasks = await ctx.store.scheduledTasks();

    let repairedScheduledSessionOwnership = false;

    for (const task of ctx.scheduledTasks) {
      const sessionId = task.sessionId ?? task.lastSessionId;
      const session = sessionId ? ctx.findSession(sessionId) : undefined;
      if (session && !session.scheduledTaskId) {
        session.scheduledTaskId = task.id;
        repairedScheduledSessionOwnership = true;
      }
    }

    if (repairedScheduledSessionOwnership) await ctx.persistNow();

    for (const task of ctx.scheduledTasks) {
      if (task.lastRunStatus !== "running") continue;
      const recovered: ScheduledTask = { ...task, lastRunStatus: "interrupted", lastRunError: "Vagus 在任务运行完成前关闭。", enabled: task.frequency === "once" ? false : task.enabled };
      ctx.scheduledTasks = ctx.scheduledTasks.map((item) => item.id === task.id ? recovered : item);
      await ctx.store.putScheduledTask(recovered);
    }

  }
  return { recoverScheduledTasks, zonedParts, zonedWallTimeToDate, nextScheduledTaskAt, runScheduledTask, createScheduledSession, runDueScheduledTasks };
}
