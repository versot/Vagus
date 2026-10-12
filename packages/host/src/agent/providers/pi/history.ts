import type { SessionTimelineEntry } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type PiRecord } from "./types.js";
import { isRecord } from "./utils.js";

export function piText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("");
}

export function piDate(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

export function piRecordMessage(record: PiRecord): PiRecord | null {
  return record.type === "message" && isRecord(record.message) ? record.message : null;
}

export function piConversation(records: PiRecord[], fallbackTitle: string): { title: string; preview: string; messageCount: number; timeline: SessionTimelineEntry[]; createdAt: string; updatedAt: string } {
  const session = records.find((record) => record.type === "session");
  const now = new Date().toISOString();
  const firstTimestamp = typeof session?.timestamp === "string" ? piDate(session.timestamp, now) : now;
  const ids = new Map(records.flatMap((record) => typeof record.id === "string" ? [[record.id, record] as const] : []));
  let leaf = [...records].reverse().find((record) => typeof record.id === "string");
  const activeBranch: PiRecord[] = [];
  const visited = new Set<string>();
  while (leaf && typeof leaf.id === "string" && !visited.has(leaf.id)) {
    visited.add(leaf.id);
    activeBranch.push(leaf);
    leaf = typeof leaf.parentId === "string" ? ids.get(leaf.parentId) : undefined;
  }
  activeBranch.reverse();

  const infoTitle = [...activeBranch].reverse().find((record) => record.type === "session_info" && typeof record.name === "string")?.name;
  const timeline: SessionTimelineEntry[] = [];
  const pendingTools = new Map<string, Extract<SessionTimelineEntry, { kind: "tool" }>>();
  let turnId: string | undefined;
  let sequence = 0;
  let firstUserText = "";
  let messageCount = 0;
  let updatedAt = firstTimestamp;

  for (const record of activeBranch) {
    if (typeof record.timestamp === "string") updatedAt = piDate(record.timestamp, updatedAt);
    const message = piRecordMessage(record);
    if (!message || typeof record.id !== "string") continue;
    const role = message.role;
    const occurredAt = piDate(record.timestamp ?? message.timestamp, updatedAt);
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = piText(parts);
    if (role === "user" || role === "assistant") {
      if (role === "user") {
        turnId = randomUUID();
        if (!firstUserText && text.trim()) firstUserText = text.replace(/\s+/g, " ").trim();
      }
      const attachments = role === "user" ? parts.flatMap((part, index) => {
        if (!isRecord(part) || part.type !== "image") return [];
        const data = typeof part.data === "string" ? part.data : undefined;
        const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/png";
        if (!data) return [];
        const dataUrl = data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
        return [{ id: `${record.id}-image-${index}`, name: `image-${index + 1}`, mimeType, size: Math.floor(data.length * 0.75), dataUrl }];
      }) : [];
      if (text || attachments.length) {
        messageCount++;
        sequence++;
        timeline.push({ kind: "message", id: `pi-${record.id}`, sequence, ...(turnId ? { turnId } : {}), occurredAt, role, text, complete: true, ...(attachments.length ? { attachments } : {}) });
      }
      if (role === "assistant") {
        const calls = parts.filter((part): part is PiRecord => isRecord(part) && part.type === "toolCall");
        for (const call of calls) {
          if (typeof call.id !== "string" || typeof call.name !== "string") continue;
          sequence++;
          const entry: Extract<SessionTimelineEntry, { kind: "tool" }> = { kind: "tool", id: `pi-${call.id}`, sequence, ...(turnId ? { turnId } : {}), occurredAt, name: call.name, state: "running", ...(call.arguments !== undefined ? { input: call.arguments } : {}) };
          timeline.push(entry);
          pendingTools.set(call.id, entry);
        }
      }
    } else if (role === "toolResult" && typeof message.toolCallId === "string") {
      const tool = pendingTools.get(message.toolCallId);
      if (tool) {
        tool.state = message.isError === true ? "error" : "done";
        tool.output = text;
      } else if (typeof message.toolName === "string") {
        sequence++;
        timeline.push({ kind: "tool", id: `pi-result-${record.id}`, sequence, ...(turnId ? { turnId } : {}), occurredAt, name: message.toolName, state: message.isError === true ? "error" : "done", output: text });
      }
    }
  }
  const normalizedTitle = typeof infoTitle === "string" ? infoTitle.trim() : "";
  const derivedTitle = firstUserText ? Array.from(firstUserText).slice(0, 80).join("") + (Array.from(firstUserText).length > 80 ? "…" : "") : "Pi 会话";
  return { title: normalizedTitle || derivedTitle || fallbackTitle, preview: firstUserText.slice(0, 220), messageCount, timeline, createdAt: firstTimestamp, updatedAt };
}

export async function discoverPiSessionFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [directory];
  while (pending.length && result.length < 5000) {
    const current = pending.pop()!;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) result.push(path);
      if (result.length >= 5000) break;
    }
  }
  return result;
}
