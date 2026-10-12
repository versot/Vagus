import i18n from "../../../locales/i18n.js";

export function formatSessionUpdatedAt(value: string, nowTimestamp = Date.now()): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Math.max(0, nowTimestamp - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return i18n.t("刚刚");
  const formatter = new Intl.RelativeTimeFormat(i18n.resolvedLanguage || i18n.language, { numeric: "auto", style: "short" });
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return formatter.format(-days, "day");
  const months = Math.floor(days / 30);
  if (months < 12) return formatter.format(-months, "month");
  return formatter.format(-Math.floor(months / 12), "year");
}
