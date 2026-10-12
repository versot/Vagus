import { type RpcRecord } from "./types.js";

export function isRecord(value: unknown): value is RpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(record: RpcRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function numberField(record: RpcRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stripTerminalCodes(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function stripTerminalCodesPreservingSgr(value: string): string {
  const sgr = new Map<string, string>();
  const protectedValue = value.replace(/\x1b\[[0-?]*[ -/]*m/g, (code) => {
    const token = `\uE000${sgr.size}\uE001`;
    sgr.set(token, code);
    return token;
  });
  return stripTerminalCodes(protectedValue)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\uE000\d+\uE001/g, (token) => sgr.get(token) ?? "");
}
