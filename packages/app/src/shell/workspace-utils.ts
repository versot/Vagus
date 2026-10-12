import type { WorkspaceSession } from "@vagus/client";
import i18n from "../locales/i18n.js";

export const manualSessionOrderKey = "vagus.sidebar.manual-session-order.v1";
export const manualProjectOrderKey = "vagus.sidebar.manual-project-order.v1";
export const pinnedSessionIdsKey = "vagus.sidebar.pinned-sessions.v1";
export const pinnedProjectIdsKey = "vagus.sidebar.pinned-projects.v1";
export const sessionViewedAtKey = "vagus.sidebar.session-viewed-at.v1";
export const lastConversationProjectIdKey = "vagus.last-conversation-project-id.v1";

export function readLastConversationProjectId(): string | null {
  try { return window.localStorage.getItem(lastConversationProjectIdKey); } catch { return null; }
}

export function saveLastConversationProjectId(projectId: string): void {
  try { window.localStorage.setItem(lastConversationProjectIdKey, projectId); } catch { /* Keep the last project in memory when storage is unavailable. */ }
}

export function clearLastConversationProjectId(): void {
  try { window.localStorage.removeItem(lastConversationProjectIdKey); } catch { /* The in-memory value still clears when storage is unavailable. */ }
}

export function readManualSessionOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(manualSessionOrderKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export function readManualProjectOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(manualProjectOrderKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export function readPinnedSessionIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(pinnedSessionIdsKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export function readPinnedProjectIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(pinnedProjectIdsKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export function readSessionViewedAt(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(sessionViewedAtKey) ?? "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
  } catch { return {}; }
}

export function formatSessionAge(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return i18n.t("时间未知");
  const elapsedMinutes = Math.max(1, Math.floor((Date.now() - date.getTime()) / 60_000));
  const formatter = new Intl.RelativeTimeFormat(i18n.resolvedLanguage || i18n.language, { numeric: "auto", style: "short" });
  if (elapsedMinutes >= 525_600) return formatter.format(-Math.floor(elapsedMinutes / 525_600), "year");
  if (elapsedMinutes >= 43_200) return formatter.format(-Math.floor(elapsedMinutes / 43_200), "month");
  if (elapsedMinutes >= 1_440) return formatter.format(-Math.floor(elapsedMinutes / 1_440), "day");
  if (elapsedMinutes >= 60) return formatter.format(-Math.floor(elapsedMinutes / 60), "hour");
  return formatter.format(-elapsedMinutes, "minute");
}

export function truncateSessionTitle(value: string, maxCharacters = 24): string {
  const characters = Array.from(value);
  return characters.length > maxCharacters ? `${characters.slice(0, maxCharacters).join("")}…` : value;
}

export function contextMenuPosition(clientX: number, clientY: number, width: number, height: number): { left: number; top: number } {
  let left = clientX + 6;
  if (left + width > window.innerWidth - 8) left = clientX - width - 6;
  left = Math.max(8, Math.min(window.innerWidth - width - 8, left));
  let top = clientY + 6;
  if (top + height > window.innerHeight - 8) top = clientY - height - 6;
  top = Math.max(8, Math.min(window.innerHeight - height - 8, top));
  return { left, top };
}

export function hasUnreadAssistantReply(session: WorkspaceSession, viewedAt: Record<string, string>): boolean {
  if (viewedAt[session.id] === "unread") return true;
  const lastAssistant = [...(session.messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant" && message.complete);
  const completedAt = session.lastAssistantAt ?? lastAssistant?.completedAt ?? lastAssistant?.occurredAt;
  return Boolean(completedAt && new Date(completedAt).getTime() > new Date(viewedAt[session.id] ?? 0).getTime());
}
