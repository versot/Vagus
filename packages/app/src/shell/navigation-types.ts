import type { Project, WorkspaceSession } from "@vagus/client";

export type NavigationLocation = { projectId: string | null; sessionId: string | null; nav: "home" | "scheduled" };
export type WorkspaceAppSnapshot = {
  projects: Project[];
  sessions: WorkspaceSession[];
};
