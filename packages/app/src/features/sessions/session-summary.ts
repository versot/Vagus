import { type WorkspaceSession } from "@vagus/client";

export function summaryOnly(session: WorkspaceSession): WorkspaceSession {
  const { messages: _messages, timeline: _timeline, history: _history, queryMarkers: _markers, ...summary } = session;
  return summary;
}

export function uniqueSessions(sessions: WorkspaceSession[]): WorkspaceSession[] {
  return [...new Map(sessions.map((session) => [session.id, session])).values()];
}

export function lastUserMessageAt(session: WorkspaceSession): string {
  if (session.lastUserAt) return session.lastUserAt;
  const lastUserMessage = session.messages?.filter((message) => message.role === "user").at(-1);
  return lastUserMessage?.occurredAt ?? session.createdAt;
}
