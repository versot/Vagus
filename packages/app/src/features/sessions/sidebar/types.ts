

export type ActivePopup = ({ kind: "sidebar"; source: "projects" | "recent" | "project-row" | "other"; left: number; top: number } | { kind: "project"; projectId: string; left: number; top: number } | { kind: "session"; sessionId: string; left: number; top: number }) & { id: number; closing?: boolean };
export type SessionHoverCardPosition = { sessionId: string; left: number; top: number };
export type ProjectHoverCardPosition = { projectId: string; left: number; top: number };
export type SessionActionTooltip = { label: string; shortcut?: string; left: number; top: number; placement: "above" | "below" | "right" };
