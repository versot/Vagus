import type { RpcRequest as Request } from "@vagus/protocol";
import type { WebSocket } from "ws";
import type { HostContext } from "../runtime/host-context.js";
import { readHistoryPage } from "../storage/session-history.js";

export interface SessionHistoryRequestHandlerContract {
  handleSessionHistoryRequest(client: WebSocket, request: Request): Promise<boolean>;
}

type SessionHistoryRequestHandlerDependencies = Pick<HostContext, "findSession" | "indexes" | "loadHistory" | "loadedHistories" | "persistNow" | "publicSession" | "publicSessionSummary" | "respond" | "sessionSubscriptions" | "store" | "writeQueue">;

export function createSessionHistoryRequestHandler(ctx: SessionHistoryRequestHandlerDependencies): SessionHistoryRequestHandlerContract {
  async function handleSessionHistoryRequest(client: WebSocket, request: Request): Promise<boolean> {
    switch (request.type) {
      case "sessions.open": {
        const session = ctx.findSession(String(request.payload.sessionId ?? ""));
        if (!session) throw new Error("会话不存在");
        if (typeof request.payload.historyLimit === "number") {
          const page = ctx.loadedHistories.has(session.id) ? readHistoryPage(session.timeline, session.eventSequence, { limit: request.payload.historyLimit }) : await ctx.store.history(session.id, { limit: request.payload.historyLimit });
          const queryMarkers = ctx.loadedHistories.has(session.id) ? session.messages.filter((message) => message.role === "user").map((message) => ({ id: message.id, sequence: message.sequence ?? 0, text: (message.text || message.attachments?.map((item) => item.name).join("、") || "图片消息").slice(0, 120), occurredAt: message.occurredAt })) : await ctx.store.markers(session.id);
          ctx.respond(client, request.id, { ...ctx.publicSessionSummary(session), timeline: page.entries, history: { beforeSequence: page.beforeSequence, hasMore: page.hasMore }, queryMarkers });
          return true;
        }
        await ctx.loadHistory(session);
        ctx.respond(client, request.id, ctx.publicSession(session)); return true;
      }
      case "sessions.history": {
        const session = ctx.findSession(String(request.payload.sessionId ?? ""));
        if (!session) throw new Error("会话不存在");
        const options = { ...(typeof request.payload.limit === "number" ? { limit: request.payload.limit } : {}), ...(typeof request.payload.beforeSequence === "number" ? { beforeSequence: request.payload.beforeSequence } : {}) };
        const page = ctx.loadedHistories.has(session.id) ? readHistoryPage(session.timeline, session.eventSequence, options) : await ctx.store.history(session.id, options);
        ctx.respond(client, request.id, { ...page, eventSequence: session.eventSequence }); return true;
      }
      case "sessions.entry": {
        const session = ctx.findSession(String(request.payload.sessionId ?? ""));
        if (!session) throw new Error("会话不存在");
        const entryId = String(request.payload.entryId ?? "");
        let entry = ctx.loadedHistories.has(session.id) ? ctx.indexes(session).entries.get(entryId) : undefined;
        if (!entry) {
          await ctx.writeQueue;
          entry = await ctx.store.entry(session.id, entryId);
        }
        ctx.respond(client, request.id, entry); return true;
      }
      case "sessions.subscribe": {
        const sessionId = request.payload.sessionId;
        if (sessionId !== null && !ctx.findSession(sessionId)) throw new Error("会话不存在");
        if (sessionId === null) ctx.sessionSubscriptions.delete(client);
        else ctx.sessionSubscriptions.set(client, sessionId);
        ctx.respond(client, request.id, { subscribed: true }); return true;
      }
      case "sessions.search": {
        await ctx.persistNow();
        ctx.respond(client, request.id, await ctx.store.search(String(request.payload.query ?? ""), request.payload.archived === true, {
          ...(typeof request.payload.limit === "number" ? { limit: request.payload.limit } : {}),
          ...(typeof request.payload.offset === "number" ? { offset: request.payload.offset } : {}),
        })); return true;
      }
      default: return false;
    }
  }
  return { handleSessionHistoryRequest };
}
