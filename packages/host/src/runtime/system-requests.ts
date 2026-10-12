import type { RpcRequest as Request } from "@vagus/protocol";
import type { WebSocket } from "ws";
import type { HostContext } from "./host-context.js";

export interface SystemRequestHandlerContract {
  handleSystemRequest(client: WebSocket, request: Request): Promise<boolean>;
}

type SystemRequestHandlerDependencies = Pick<HostContext, "database" | "eventLoop" | "loadedHistories" | "performanceStats" | "provisioningSessionIds" | "publicProviders" | "publicSessionSummary" | "respond" | "shutdown" | "store">;

export function createSystemRequestHandler(ctx: SystemRequestHandlerDependencies): SystemRequestHandlerContract {
  async function handleSystemRequest(client: WebSocket, request: Request): Promise<boolean> {
    switch (request.type) {
      case "host.capabilities":
        ctx.respond(client, request.id, { sessionModelSelection: true, sessionUsage: true, sessionQueue: true, sessionContext: true, sessionCommands: true }); return true;
      case "host.performance":
        if (request.payload.enabled === true) { ctx.eventLoop.enable(); ctx.eventLoop.reset(); }
        if (request.payload.enabled === false) ctx.eventLoop.disable();
        ctx.respond(client, request.id, { requests: Object.fromEntries(ctx.performanceStats), storage: await ctx.store.request("performance"), eventLoop: { meanMs: Number.isFinite(ctx.eventLoop.mean) ? ctx.eventLoop.mean / 1e6 : null, p95Ms: ctx.eventLoop.percentile(95) / 1e6, maxMs: ctx.eventLoop.max / 1e6 }, memory: process.memoryUsage(), loadedHistories: ctx.loadedHistories.size }); return true;
      case "host.shutdown":
        ctx.respond(client, request.id, { stopping: true });
        setTimeout(() => void ctx.shutdown().finally(() => process.exit(0)), 0); return true;
      case "workspace.snapshot":
        ctx.respond(client, request.id, { projects: ctx.database.projects, sessions: ctx.database.sessions.filter((session) => !ctx.provisioningSessionIds.has(session.id)).map(ctx.publicSessionSummary), providers: ctx.publicProviders() });
        return true;
      default: return false;
    }
  }
  return { handleSystemRequest };
}
