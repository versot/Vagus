import type { SessionStorageReference } from "@vagus/agent-core";
import type { Message, Project, WorkspaceSession as PublicWorkspaceSession, SessionTimelineEntry } from "@vagus/protocol";
import { randomUUID } from "node:crypto";

export type { Message, Project };
export interface WorkspaceSession extends Omit<PublicWorkspaceSession, "messages" | "timeline" | "eventSequence"> {
  titleManuallySet?: boolean;
  branchRootSessionId?: string;
  branchBaseTitle?: string;
  /** Provider-neutral duplicate key returned by native session discovery; never sent to clients. */
  providerImportSourceId?: string;
  messages: Message[];
  timeline: SessionTimelineEntry[];
  eventSequence: number;
  providerStorageReference?: SessionStorageReference;
}
export interface Database { projects: Project[]; sessions: WorkspaceSession[]; }
export type SessionMetadata = Omit<WorkspaceSession, "messages" | "timeline">;

export function sessionMetadata(session: WorkspaceSession): SessionMetadata {
  const { messages: _messages, timeline: _timeline, ...metadata } = session;
  return metadata;
}

export function normalizeLegacySession(session: WorkspaceSession): WorkspaceSession {
  session.titleManuallySet ??= Boolean(session.title && session.title !== "新会话");
  session.messages ??= [];
  session.state = "ended";
  if (!Array.isArray(session.timeline)) {
    let turnId: string | undefined;
    let sequence = 0;
    session.timeline = session.messages.map((message) => {
      if (message.role === "user") turnId = randomUUID();
      sequence = Math.max(sequence + 1, message.sequence ?? 0);
      message.sequence = sequence;
      message.turnId ??= turnId;
      message.occurredAt ??= session.updatedAt || session.createdAt;
      return { kind: "message", ...message, sequence, occurredAt: message.occurredAt };
    });
  }
  session.eventSequence = Math.max(session.eventSequence ?? 0, session.timeline.reduce((max, entry) => Math.max(max, entry.sequence), 0));
  const messageEntries = new Map(session.timeline.filter((entry) => entry.kind === "message").map((entry) => [entry.id, entry]));
  for (const message of session.messages) {
    const entry = messageEntries.get(message.id);
    if (entry) { message.sequence ??= entry.sequence; message.turnId ??= entry.turnId; message.occurredAt ??= entry.occurredAt; }
    if (message.role === "user") session.lastUserAt = message.occurredAt ?? session.createdAt;
    if (message.role === "assistant" && message.complete) session.hasAssistantReply = true;
  }
  const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant" && message.complete);
  if (lastAssistant && session.lastAssistantAt) {
    lastAssistant.completedAt ??= session.lastAssistantAt;
    const entry = messageEntries.get(lastAssistant.id);
    if (entry) entry.completedAt ??= lastAssistant.completedAt;
  }
  session.hasAssistantReply ??= session.timeline.some((entry) => entry.kind === "message" && entry.role === "assistant" && entry.complete);
  session.lastUserAt ??= [...session.timeline].reverse().find((entry) => entry.kind === "message" && entry.role === "user")?.occurredAt;
  for (const entry of session.timeline) {
    if (entry.kind === "tool" && entry.state === "running") { entry.state = "error"; entry.output = "Vagus 在此操作完成前关闭。"; }
    if (entry.kind === "interaction" && entry.state === "pending") { entry.state = "cancelled"; entry.response = null; entry.reason = "interrupted"; }
  }
  return session;
}
