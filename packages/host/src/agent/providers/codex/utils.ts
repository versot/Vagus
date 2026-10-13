import { type JsonRecord } from "./types.js";

export function isRecord(value: unknown): value is JsonRecord { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export function safeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT/u.test(message)) return new Error(`找不到本机 Codex CLI。请安装 Codex 并确认 ${process.platform === "win32" ? "codex.exe" : "codex"} 在 PATH 中，或设置 VAGUS_CODEX_EXECUTABLE。`);
  return new Error(message.slice(0, 1500));
}

export function codexDate(value: unknown, fallback: string): string {
  const date = typeof value === "number" ? new Date(value < 10_000_000_000 ? value * 1000 : value) : typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}
