import i18n from "../../locales/i18n.js";

export function formatMessageTime(value: string | undefined, nowTimestamp = Date.now()): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date(nowTimestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const locale = i18n.resolvedLanguage || i18n.language;
  if (messageDay.getTime() === today.getTime()) return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  if (messageDay >= weekStart) return `${new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date)} ${new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)}`;
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function formatTurnDuration(startedAt: string, completedAt: string | undefined, now: number, active: boolean): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const totalSeconds = Math.floor((end - start) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const duration = minutes > 0 ? i18n.t("{{count}} 分钟 {{seconds}} 秒", { count: minutes, seconds }) : i18n.t("{{seconds}} 秒", { seconds });
  return `${i18n.t(active ? "已处理" : "用时")} ${duration}`;
}
