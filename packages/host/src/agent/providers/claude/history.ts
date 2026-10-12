import type { MessageAttachment, SessionTimelineEntry } from "@vagus/protocol";
import { lstat, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { type ClaudeRecord } from "./types.js";
import { isObject } from "./utils.js";

export function claudeDate(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

export function claudeContent(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return Array.isArray(value) ? value.filter(isObject) : [];
}

export function claudeText(content: Array<Record<string, unknown>>): string {
  return content.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("");
}

export function claudeAttachments(content: Array<Record<string, unknown>>, recordId: string): MessageAttachment[] {
  return content.flatMap((part, index) => {
    if (part.type !== "image" || !isObject(part.source) || part.source.type !== "base64" || typeof part.source.data !== "string") return [];
    const mimeType = typeof part.source.media_type === "string" && part.source.media_type.startsWith("image/") ? part.source.media_type : "image/png";
    const data = part.source.data;
    if (!data || data.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return [];
    return [{ id: `claude-${recordId}-image-${index}`, name: `image-${index + 1}`, mimeType, size: Math.floor(data.length * 0.75), dataUrl: `data:${mimeType};base64,${data}` }];
  });
}

export function claudeConversation(records: ClaudeRecord[], fallbackTitle: string, fallbackDate: string) {
  const timeline: SessionTimelineEntry[] = [];
  const tools = new Map<string, Extract<SessionTimelineEntry, { kind: "tool" }>>();
  let sequence = 0;
  let turnId: string | undefined;
  let title = "";
  let preview = "";
  let messageCount = 0;
  let createdAt = fallbackDate;
  let updatedAt = fallbackDate;

  for (const [index, record] of records.entries()) {
    if (record.isSidechain === true) continue;
    const occurredAt = claudeDate(record.timestamp, updatedAt);
    if (index === 0) createdAt = occurredAt;
    updatedAt = occurredAt;
    const message = isObject(record.message) ? record.message : null;
    const role = message?.role ?? record.type;
    if ((role === "user" || role === "assistant") && message) {
      const content = claudeContent(message.content);
      const text = claudeText(content);
      const attachments = role === "user" ? claudeAttachments(content, String(record.uuid ?? sequence + 1)) : [];
      if (role === "user") {
        turnId = typeof record.uuid === "string" ? record.uuid : `claude-turn-${sequence + 1}`;
        if (!preview && text.trim()) {
          preview = text.replace(/\s+/gu, " ").trim().slice(0, 220);
          title = Array.from(preview).slice(0, 80).join("");
          if (Array.from(preview).length > 80) title += "…";
        }
      }
      if (text.trim() || attachments.length) {
        sequence++;
        messageCount++;
        timeline.push({ kind: "message", id: `claude-${String(record.uuid ?? sequence)}`, sequence, ...(turnId ? { turnId } : {}), occurredAt, role, text, complete: true, ...(attachments.length ? { attachments } : {}) });
      }
      if (role === "assistant") {
        for (const part of content) {
          if (part.type !== "tool_use" || typeof part.id !== "string" || typeof part.name !== "string") continue;
          sequence++;
          const tool: Extract<SessionTimelineEntry, { kind: "tool" }> = { kind: "tool", id: `claude-${part.id}`, sequence, ...(turnId ? { turnId } : {}), occurredAt, name: part.name, state: "running", ...(part.input !== undefined ? { input: part.input } : {}) };
          timeline.push(tool);
          tools.set(part.id, tool);
        }
      } else {
        for (const part of content) {
          if (part.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
          const tool = tools.get(part.tool_use_id);
          if (tool) {
            tool.state = part.is_error === true ? "error" : "done";
            const result = claudeText(claudeContent(part.content));
            if (result) tool.output = result;
          }
        }
      }
    }
    if (record.type === "summary" && typeof record.summary === "string" && !title) title = record.summary.trim();
  }
  return { title: title || fallbackTitle, preview, messageCount, timeline, createdAt, updatedAt };
}

export async function discoverClaudeSessionFiles(directory: string): Promise<string[]> {
  let projects;
  try { projects = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const files: string[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const folder = join(directory, project.name);
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && /^[0-9a-f-]{36}\.jsonl$/iu.test(entry.name)) files.push(join(folder, entry.name));
      if (files.length >= 5000) return files;
    }
  }
  return files;
}

export async function deleteClaudeSessionTranscript(sessionId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId)) throw new Error("Claude Code 会话 ID 无效，未删除任何原生记录");
  const projectsDirectory = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const candidates = (await discoverClaudeSessionFiles(projectsDirectory)).filter(path => basename(path).toLowerCase() === `${sessionId.toLowerCase()}.jsonl`);
  const matches: string[] = [];
  for (const path of candidates) {
    try {
      const info = await stat(path);
      if (info.size <= 0 || info.size > 128 * 1024 * 1024) continue;
      const records = (await readFile(path, "utf8")).split(/\r?\n/u).flatMap(line => {
        if (!line.trim()) return [];
        try { const value: unknown = JSON.parse(line); return isObject(value) ? [value] : []; } catch { return []; }
      });
      if (records.some(record => record.sessionId === sessionId && typeof record.cwd === "string" && isAbsolute(record.cwd))) matches.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (matches.length === 0) return; // New ACP sessions may not have produced a native transcript yet.
  if (matches.length > 1) throw new Error("Claude Code 会话 ID 对应多个原生记录，未删除任何文件");

  const projectsRealPath = await realpath(projectsDirectory);
  const candidateRealPath = await realpath(matches[0]!);
  const candidateRelativePath = relative(projectsRealPath, candidateRealPath);
  if (!candidateRelativePath || candidateRelativePath === ".." || candidateRelativePath.startsWith(`..${sep}`) || isAbsolute(candidateRelativePath)) {
    throw new Error("Claude Code 原生会话文件解析到了 projects 目录之外，未删除任何文件");
  }
  const fileInfo = await lstat(matches[0]!);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("Claude Code 原生会话记录不是普通文件，未删除任何文件");
  await unlink(matches[0]!);
}
