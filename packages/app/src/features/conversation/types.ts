import type { MessageAttachment, UserInteraction } from "@vagus/protocol";

export type ChatMessage = { id: string; role: "user" | "assistant"; text: string; complete: boolean; order: number; turnId?: string; occurredAt?: string; completedAt?: string; attachments?: MessageAttachment[]; browserElements?: import("@vagus/protocol").BrowserElementReference[]; contentDeferred?: true; deliveryState?: "sending" | "failed" };
export type ChatInteraction = { id: string; order: number; turnId?: string; interaction: UserInteraction; state: "pending" | "responded" | "cancelled"; response?: string | boolean | null; reason?: "timeout" | "interrupted" };
export type ChatNotice = { id: string; order: number; turnId?: string; level: "info" | "warning" | "error"; message: string };
export type ChatPlan = { id: string; order: number; turnId?: string; explanation?: string; steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }> };
export type ChatTurnDiff = { id: string; order: number; turnId: string; diff: string; truncated?: boolean };
export type ChatStatus = { id: string; order: number; turnId?: string; key: string; text: string; subagentSessionId?: string; subagentCancellable?: boolean; subagentState?: "running" | "idle" | "requires_action" | "unknown" | "completed" | "failed" | "cancelled" | "disconnected" };
export type ToolActivity = { id: string; name: string; title?: string; toolKind?: string; state: "running" | "done" | "error"; order: number; turnId?: string; parentToolCallId?: string; input?: unknown; content?: unknown; locations?: unknown; output?: unknown; terminalExitCode?: number | null; contentDeferred?: true };
