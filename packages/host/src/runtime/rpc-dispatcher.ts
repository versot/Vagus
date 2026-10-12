import type { RpcRequest as Request } from "@vagus/protocol";
import type { WebSocket } from "ws";
import type { HostContext } from "./host-context.js";

export interface RpcDispatcherContract { handle(client: WebSocket, request: Request): Promise<void>; }
type RpcDispatcherDependencies = Pick<HostContext, "handleProjectRequest" | "handleProviderRequest" | "handleScheduledTaskRequest" | "handleSessionControlRequest" | "handleSessionHistoryRequest" | "handleSessionLifecycleRequest" | "handleSystemRequest" | "handleWorkspaceRequest" | "recordPerformance" | "respond">;

export function createRpcDispatcher(ctx: RpcDispatcherDependencies): RpcDispatcherContract {
  async function handle(client: WebSocket, request: Request): Promise<void> {
    const started = performance.now();
    try {
      if (await ctx.handleSystemRequest(client, request)) return;
      if (await ctx.handleWorkspaceRequest(client, request)) return;
      if (await ctx.handleProviderRequest(client, request)) return;
      if (await ctx.handleProjectRequest(client, request)) return;
      if (await ctx.handleScheduledTaskRequest(client, request)) return;
      if (await ctx.handleSessionHistoryRequest(client, request)) return;
      if (await ctx.handleSessionLifecycleRequest(client, request)) return;
      if (await ctx.handleSessionControlRequest(client, request)) return;
      throw new Error(`未知命令: ${request.type}`);
    } catch (error) { ctx.respond(client, request.id, undefined, error instanceof Error ? error.message : String(error)); }
    finally { ctx.recordPerformance(`request.${request.type}`, performance.now() - started); }
  }
  return { handle };
}
