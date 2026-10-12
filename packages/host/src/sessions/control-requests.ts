import type { RpcRequest as Request, ScheduledTask } from "@vagus/protocol";
import type { WebSocket } from "ws";
import type { HostContext } from "../runtime/host-context.js";

export interface SessionControlRequestHandlerContract {
  handleSessionControlRequest(client: WebSocket, request: Request): Promise<boolean>;
}

type SessionControlRequestHandlerDependencies = Pick<HostContext, "compactingSessions" | "database" | "emit" | "ensureLiveAgent" | "findSession" | "liveAgents" | "parseBrowserElements" | "parseMessageAttachments" | "persistSoon" | "providerModelCatalogs" | "respond" | "scheduledTaskMutations" | "scheduledTasks" | "sessionEmitters" | "store">;

export function createSessionControlRequestHandler(ctx: SessionControlRequestHandlerDependencies): SessionControlRequestHandlerContract {
  async function handleSessionControlRequest(client: WebSocket, request: Request): Promise<boolean> {
    switch (request.type) {
      case "sessions.send": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        if (!session) throw new Error("会话不存在");
        if (ctx.compactingSessions.has(sessionId)) throw new Error("会话正在压缩上下文，请等待压缩完成后再发送消息");
        const text = String(request.payload.text ?? "");
        const attachments = ctx.parseMessageAttachments(request.payload.attachments);
        const browserElements = ctx.parseBrowserElements(request.payload.browserElements);
        if (!text.trim() && attachments.length === 0 && browserElements.length === 0) throw new Error("请输入消息或添加附件");
        const deliveryMode = request.payload.deliveryMode === "steer" || request.payload.deliveryMode === "follow-up" ? request.payload.deliveryMode : "immediate";
        const clientMessageId = typeof request.payload.clientMessageId === "string" && request.payload.clientMessageId.length <= 128 ? request.payload.clientMessageId : undefined;
        const agent = await ctx.ensureLiveAgent(session);
        const result = await agent.sendText(text, attachments, deliveryMode, clientMessageId, browserElements);
        if (agent.storageReference) session.providerStorageReference = agent.storageReference;
        if (agent.getRuntimeSettings) session.runtimeSettings = await agent.getRuntimeSettings();
        ctx.persistSoon();
        ctx.respond(client, request.id, { accepted: true, ...(result ? { disposition: result.disposition } : {}) }); return true;
      }
      case "sessions.clear-queue": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        if (!session) throw new Error("会话不存在");
        const agent = await ctx.ensureLiveAgent(session);
        if (!agent.clearQueue) throw new Error("当前 Agent 不支持清理待处理消息");
        const queue = await agent.clearQueue();
        session.queue = queue;
        ctx.emit({ type: "session.queue.updated", sessionId, queue });
        ctx.respond(client, request.id, { queue }); return true;
      }
      case "sessions.compact": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        if (!session) throw new Error("会话不存在");
        if (session.state === "running" || session.state === "starting") throw new Error("请等待当前回复完成后再压缩上下文");
        if (ctx.compactingSessions.has(sessionId)) throw new Error("会话正在压缩上下文，请等待压缩完成");
        const instructions = typeof request.payload.instructions === "string" ? request.payload.instructions.slice(0, 4000) : undefined;
        ctx.compactingSessions.add(sessionId);
        try {
          const agent = await ctx.ensureLiveAgent(session);
          if (!agent.compact) throw new Error("当前 Agent 不支持手动压缩上下文");
          await agent.compact(instructions);
          if (agent.getUsage) session.usage = (await agent.getUsage()) ?? session.usage;
          ctx.persistSoon(); ctx.respond(client, request.id, { compacted: true, usage: session.usage ?? null }); return true;
        }
        finally { ctx.compactingSessions.delete(sessionId); }
      }
      case "sessions.set-auto-compaction": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        if (!session) throw new Error("会话不存在");
        if (session.state === "running" || session.state === "starting") throw new Error("请等待当前回复完成后再调整自动压缩");
        if (ctx.compactingSessions.has(sessionId)) throw new Error("会话正在压缩上下文，请等待压缩完成后再调整设置");
        if (typeof request.payload.enabled !== "boolean") throw new Error("自动压缩设置无效");
        const agent = await ctx.ensureLiveAgent(session);
        if (!agent.setAutoCompaction) throw new Error("当前 Agent 不支持设置自动压缩");
        session.runtimeSettings = await agent.setAutoCompaction(request.payload.enabled);
        ctx.persistSoon(); ctx.respond(client, request.id, session.runtimeSettings); return true;
      }
      case "sessions.get-settings": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        if (!session) throw new Error("会话不存在");
        const agent = await ctx.ensureLiveAgent(session);
        if (!agent.getRuntimeSettings) throw new Error("当前 Agent 暂不支持会话模型设置");
        session.runtimeSettings = await agent.getRuntimeSettings();
        ctx.persistSoon(); ctx.respond(client, request.id, { settings: session.runtimeSettings, state: session.state }); return true;
      }
      case "sessions.get-commands": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        if (!session) throw new Error("会话不存在");
        const agent = await ctx.ensureLiveAgent(session);
        if (!agent.getCommands) throw new Error("当前 Agent 不支持命令发现");
        ctx.respond(client, request.id, await agent.getCommands()); return true;
      }
      case "sessions.execute-command": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        if (!session) throw new Error("会话不存在");
        const action = request.payload.action;
        const input = typeof request.payload.input === "string" ? request.payload.input : "";
        const pauseActiveCodexGoal = session.providerId === "codex" && session.state === "running" && action === "goal" && input.trim().toLowerCase() === "pause";
        if ((session.state === "running" && !pauseActiveCodexGoal) || session.state === "starting") throw new Error("请等待当前回复完成后再执行此命令");
        const agent = await ctx.ensureLiveAgent(session);
        if (!agent.getCommands || !agent.executeCommand) throw new Error("当前 Agent 不支持此命令");
        const commands = await agent.getCommands();
        if (!commands.some((command) => command.action === action)) throw new Error("当前会话未提供此命令");
        await agent.executeCommand(action, input);
        if (agent.getRuntimeSettings) session.runtimeSettings = await agent.getRuntimeSettings();
        if (agent.getUsage) session.usage = (await agent.getUsage()) ?? session.usage;
        ctx.persistSoon();
        ctx.respond(client, request.id, { executed: true }); return true;
      }
      case "sessions.get-usage": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        const agent = ctx.liveAgents.get(sessionId);
        if (!session) throw new Error("会话不存在");
        if (!agent?.getUsage) { ctx.respond(client, request.id, session.usage ?? null); return true; }
        const usage = await agent.getUsage();
        if (usage) session.usage = usage;
        if (usage) ctx.persistSoon();
        ctx.respond(client, request.id, session.usage ?? null); return true;
      }
      case "sessions.set-model": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        if (!session) throw new Error("会话不存在");
        const agent = await ctx.ensureLiveAgent(session);
        if (session.state === "running" || session.state === "starting") throw new Error("请等待当前回复完成后再切换模型");
        if (!agent.setModel) throw new Error("当前 Agent 暂不支持切换模型");
        const modelId = String(request.payload.modelId ?? "");
        const providerId = session.providerId ?? "pi";
        const catalog = ctx.providerModelCatalogs.get(providerId);
        if (!catalog?.models.some((item) => item.id === modelId)) throw new Error("这个模型不在 Agent 当前可用的模型目录中，请刷新后重试");
        const linkedTask = ctx.scheduledTasks.find((task) => task.sessionId === session.id);
        if (linkedTask && (linkedTask.lastRunStatus === "running" || ctx.scheduledTaskMutations.has(linkedTask.id))) throw new Error("定时任务正在运行或更新，请稍后再切换模型");
        if (linkedTask) ctx.scheduledTaskMutations.add(linkedTask.id);
        const previousSettings = session.runtimeSettings;
        try {
          const nextSettings = await agent.setModel(modelId);
          if (linkedTask) {
            const updatedTask: ScheduledTask = { ...linkedTask, modelId, thinkingLevel: nextSettings.thinkingLevel ?? null };
            try { await ctx.store.putScheduledTask(updatedTask); }
            catch (error) {
              if (previousSettings?.modelId) {
                try {
                  let restored = await agent.setModel(previousSettings.modelId);
                  if (previousSettings.thinkingLevel && agent.setThinkingLevel) restored = await agent.setThinkingLevel(previousSettings.thinkingLevel);
                  session.runtimeSettings = restored;
                } catch { /* Preserve the original persistence error; the next scheduled run will restore its saved model. */ }
              }
              throw error;
            }
            ctx.scheduledTasks = ctx.scheduledTasks.map((task) => task.id === updatedTask.id ? updatedTask : task);
            ctx.emit({ type: "workspace.changed" });
          }
          session.runtimeSettings = nextSettings;
          session.updatedAt = new Date().toISOString();
          ctx.persistSoon();
          ctx.respond(client, request.id, session.runtimeSettings); return true;
        } finally { if (linkedTask) ctx.scheduledTaskMutations.delete(linkedTask.id); }
      }
      case "sessions.set-thinking-level": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        if (!session) throw new Error("会话不存在");
        const agent = await ctx.ensureLiveAgent(session);
        if (session.state === "running" || session.state === "starting") throw new Error("请等待当前回复完成后再调整思考程度");
        if (!agent.setThinkingLevel) throw new Error("当前 Agent 暂不支持调整思考程度");
        const level = String(request.payload.level ?? "");
        const linkedTask = ctx.scheduledTasks.find((task) => task.sessionId === session.id);
        if (linkedTask && (linkedTask.lastRunStatus === "running" || ctx.scheduledTaskMutations.has(linkedTask.id))) throw new Error("定时任务正在运行或更新，请稍后再调整思考程度");
        if (linkedTask) ctx.scheduledTaskMutations.add(linkedTask.id);
        const previousSettings = session.runtimeSettings;
        try {
          const nextSettings = await agent.setThinkingLevel(level);
          if (linkedTask) {
            const updatedTask: ScheduledTask = { ...linkedTask, modelId: nextSettings.modelId ?? linkedTask.modelId, thinkingLevel: nextSettings.thinkingLevel ?? null };
            try { await ctx.store.putScheduledTask(updatedTask); }
            catch (error) {
              if (previousSettings?.thinkingLevel) {
                try { session.runtimeSettings = await agent.setThinkingLevel(previousSettings.thinkingLevel); }
                catch { /* Preserve the original persistence error; the next scheduled run will restore its saved settings. */ }
              }
              throw error;
            }
            ctx.scheduledTasks = ctx.scheduledTasks.map((task) => task.id === updatedTask.id ? updatedTask : task);
            ctx.emit({ type: "workspace.changed" });
          }
          session.runtimeSettings = nextSettings;
          session.updatedAt = new Date().toISOString();
          ctx.persistSoon();
          ctx.respond(client, request.id, session.runtimeSettings); return true;
        } finally { if (linkedTask) ctx.scheduledTaskMutations.delete(linkedTask.id); }
      }
      case "sessions.set-mode": {
        const sessionId = String(request.payload.sessionId ?? "");
        const session = ctx.findSession(sessionId);
        if (!session) throw new Error("会话不存在");
        if (session.state === "running" || session.state === "starting") throw new Error("请等待当前回复完成后再切换会话模式");
        const agent = await ctx.ensureLiveAgent(session);
        if (!agent.setMode) throw new Error("当前 Agent 不支持切换会话模式");
        const modeId = String(request.payload.modeId ?? "");
        const linkedTask = ctx.scheduledTasks.find((task) => task.sessionId === session.id);
        if (linkedTask && (linkedTask.lastRunStatus === "running" || ctx.scheduledTaskMutations.has(linkedTask.id))) throw new Error("定时任务正在运行或更新，请稍后再切换会话模式");
        if (linkedTask) ctx.scheduledTaskMutations.add(linkedTask.id);
        const previousSettings = session.runtimeSettings;
        try {
          const nextSettings = await agent.setMode(modeId);
          if (linkedTask) {
            const updatedTask: ScheduledTask = { ...linkedTask, modeId };
            try { await ctx.store.putScheduledTask(updatedTask); }
            catch (error) {
              if (previousSettings?.currentModeId) {
                try { session.runtimeSettings = await agent.setMode(previousSettings.currentModeId); }
                catch { /* Preserve the original persistence error; the next scheduled run will restore its saved mode. */ }
              }
              throw error;
            }
            ctx.scheduledTasks = ctx.scheduledTasks.map((task) => task.id === updatedTask.id ? updatedTask : task);
            ctx.emit({ type: "workspace.changed" });
          }
          session.runtimeSettings = nextSettings;
          session.updatedAt = new Date().toISOString();
          ctx.persistSoon();
          ctx.respond(client, request.id, nextSettings); return true;
        } finally { if (linkedTask) ctx.scheduledTaskMutations.delete(linkedTask.id); }
      }
      case "sessions.cancel": {
        const agent = ctx.liveAgents.get(String(request.payload.sessionId ?? ""));
        if (!agent) throw new Error("会话当前未运行");
        await agent.cancel(); ctx.respond(client, request.id, { cancelled: true }); return true;
      }
      case "sessions.cancel-subagent": {
        const agent = ctx.liveAgents.get(String(request.payload.sessionId ?? ""));
        if (!agent?.cancelSubagent) throw new Error("当前 Provider 不支持单独取消子代理");
        await agent.cancelSubagent(String(request.payload.subagentSessionId ?? ""));
        ctx.respond(client, request.id, { cancelled: true }); return true;
      }
      case "interactions.respond": {
        const sessionId = String(request.payload.sessionId ?? "");
        const agent = ctx.liveAgents.get(sessionId);
        if (!agent) throw new Error("会话当前未运行");
        const interactionId = String(request.payload.interactionId ?? "");
        const value = request.payload.value as string | boolean | null;
        await agent.respond({ interactionId, value });
        ctx.sessionEmitters.get(sessionId)?.({ type: "interaction.responded", sessionId, interactionId, value });
        ctx.respond(client, request.id, { accepted: true }); return true;
      }
      case "sessions.ui-input": {
        const sessionId = String(request.payload.sessionId ?? "");
        const agent = ctx.liveAgents.get(sessionId);
        if (!agent?.sendUiInput) throw new Error("当前会话没有可交互的扩展组件");
        const widgetKey = String(request.payload.widgetKey ?? "");
        const input = String(request.payload.input ?? "");
        if (!widgetKey || widgetKey.length > 160) throw new Error("扩展组件标识无效");
        if (!input || Buffer.byteLength(input, "utf8") > 2048) throw new Error("扩展组件输入无效");
        await agent.sendUiInput(widgetKey, input);
        ctx.respond(client, request.id, { accepted: true }); return true;
      }
      case "sessions.editor-text.dismiss": {
        const sessionId = String(request.payload.sessionId ?? "");
        if (!ctx.database.sessions.some((session) => session.id === sessionId)) throw new Error("会话不存在");
        const requestId = String(request.payload.requestId ?? "");
        ctx.emit({ type: "ui.editorText.dismissed", sessionId, requestId });
        ctx.respond(client, request.id, { accepted: true }); return true;
      }
      default: return false;
    }
  }
  return { handleSessionControlRequest };
}
