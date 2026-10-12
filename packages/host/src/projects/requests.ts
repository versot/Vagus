import type { RpcRequest as Request } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { HostContext } from "../runtime/host-context.js";
import { type Project } from "../storage/workspace-records.js";

export interface ProjectRequestHandlerContract {
  handleProjectRequest(client: WebSocket, request: Request): Promise<boolean>;
}

type ProjectRequestHandlerDependencies = Pick<HostContext, "database" | "emit" | "liveAgents" | "persistSoon" | "respond" | "sessionEmitters">;

export function createProjectRequestHandler(ctx: ProjectRequestHandlerDependencies): ProjectRequestHandlerContract {
  async function handleProjectRequest(client: WebSocket, request: Request): Promise<boolean> {
    switch (request.type) {
      case "projects.create": {
        const name = String(request.payload.name ?? "").trim();
        const roots = Array.isArray(request.payload.roots) ? [...new Set(request.payload.roots.filter((path): path is string => typeof path === "string").map((path) => path.trim()).filter(Boolean))] : [];
        const root = roots[0] ?? String(request.payload.root ?? "").trim();
        if (!name || !root) throw new Error("请提供项目名称和本机文件夹");
        const project: Project = { id: randomUUID(), name, root, roots: roots.length ? roots : [root], createdAt: new Date().toISOString() };
        ctx.database.projects.unshift(project); ctx.persistSoon(); ctx.respond(client, request.id, project); return true;
      }
      case "projects.update": {
        const project = ctx.database.projects.find((item) => item.id === String(request.payload.projectId ?? ""));
        const name = String(request.payload.name ?? "").trim();
        const roots = Array.isArray(request.payload.roots) ? [...new Set(request.payload.roots.filter((path): path is string => typeof path === "string").map((path) => path.trim()).filter(Boolean))] : [];
        if (!project) throw new Error("找不到这个项目");
        if (!name || roots.length === 0) throw new Error("请填写项目名称并至少保留一个本机文件夹");
        project.name = name;
        project.root = roots[0]!;
        project.roots = roots;
        ctx.persistSoon(); ctx.respond(client, request.id, project); return true;
      }
      case "projects.remove": {
        const projectId = String(request.payload.projectId ?? "");
        const project = ctx.database.projects.find((item) => item.id === projectId);
        if (!project) throw new Error("找不到这个项目");
        const sessions = ctx.database.sessions.filter((session) => session.projectId === projectId);
        for (const session of sessions) {
          const agent = ctx.liveAgents.get(session.id);
          if (agent) { await agent.dispose(); ctx.liveAgents.delete(session.id); }
          ctx.sessionEmitters.delete(session.id);
        }
        ctx.database.sessions = ctx.database.sessions.filter((session) => session.projectId !== projectId);
        ctx.database.projects = ctx.database.projects.filter((item) => item.id !== projectId);
        ctx.persistSoon(); ctx.emit({ type: "workspace.changed" }); ctx.respond(client, request.id, { removed: true }); return true;
      }
      default: return false;
    }
  }
  return { handleProjectRequest };
}
