import { isAbsolute } from "node:path";
import { type AcpRecord } from "./types.js";

export function isRecord(value: unknown): value is AcpRecord { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export function acpErrorMessage(error: unknown): string {
  if (isRecord(error) && isRecord(error.data) && typeof error.data.details === "string" && error.data.details.trim()) return error.data.details;
  return error instanceof Error ? error.message : String(error);
}

export function timeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 20_000); })]).finally(() => { if (timer) clearTimeout(timer); });
}

export function locationPath(location: unknown): AcpRecord[] {
  return Array.isArray(location) ? location.filter(isRecord).map((item) => ({ path: item.path, ...(item.line !== undefined ? { line: item.line } : {}) })) : [];
}

export function parseDirectories(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && isAbsolute(item)) : [];
  } catch { return []; }
}
