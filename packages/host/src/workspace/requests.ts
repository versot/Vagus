import type { RpcRequest as Request } from "@vagus/protocol";
import type { WebSocket } from "ws";
import type { HostContext } from "../runtime/host-context.js";
import { readGitPatch, readGitReview } from "./git-review.js";

export interface WorkspaceRequestHandlerContract {
  handleWorkspaceRequest(client: WebSocket, request: Request): Promise<boolean>;
}

type WorkspaceRequestHandlerDependencies = Pick<HostContext, "database" | "respond">;

export function createWorkspaceRequestHandler(ctx: WorkspaceRequestHandlerDependencies): WorkspaceRequestHandlerContract {
  async function handleWorkspaceRequest(client: WebSocket, request: Request): Promise<boolean> {
    switch (request.type) {
      case "workspace.git-review":
      case "workspace.git-patch": {
        if (request.payload.scope !== "unstaged" && request.payload.scope !== "staged") throw new Error("Invalid Git review scope");
        const project = ctx.database.projects.find((item) => item.id === request.payload.projectId);
        if (request.type === "workspace.git-patch") {
          if (typeof request.payload.path !== "string") throw new Error("Invalid Git review path");
          ctx.respond(client, request.id, await readGitPatch(project?.root, request.payload.scope, request.payload.path));
        } else ctx.respond(client, request.id, await readGitReview(project?.root, request.payload.scope));
        return true;
      }
      default: return false;
    }
  }
  return { handleWorkspaceRequest };
}
