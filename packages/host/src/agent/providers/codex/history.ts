import type { MessageAttachment, SessionTimelineEntry } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { codexGeneratedImage } from "./events.js";
import { CodexAppServer } from "./runtime.js";
import { type JsonRecord } from "./types.js";
import { codexDate, isRecord } from "./utils.js";

export function codexImportedTool(item: JsonRecord): { id: string; entry: Pick<Extract<SessionTimelineEntry, { kind: "tool" }>, "name" | "title" | "toolKind" | "state" | "input" | "output" | "terminalExitCode"> } | null {
  const type = item.type;
  if (type === "reasoning" || type === "plan" || type === "contextCompaction" || type === "functionCallOutput") return null;
  if (type === "userMessage" || type === "agentMessage") return null;
  const id = typeof item.id === "string" ? item.id : randomUUID();
  const name = type === "commandExecution" ? "Terminal"
    : type === "mcpToolCall" ? `${String(item.server ?? "MCP")}: ${String(item.tool ?? "Tool")}`
      : type === "dynamicToolCall" ? String(item.tool ?? "Tool")
        : type === "fileChange" ? "File changes"
          : type === "collabAgentToolCall" ? String(item.tool ?? "Subagent")
            : type === "subAgentActivity" ? "Subagent activity"
              : type === "imageView" ? "View image"
                : type === "webSearch" ? "Web search"
                  : type === "imageGeneration" ? "Image generation"
                    : type === "sleep" ? "Wait"
                      : String(type ?? "Codex activity");
  const rawStatus = item.status;
  const state: Extract<SessionTimelineEntry, { kind: "tool" }>['state'] = rawStatus === "failed" || rawStatus === "declined" || item.success === false ? "error" : rawStatus === "inProgress" ? "running" : "done";
  const input = type === "commandExecution" ? { command: item.command, cwd: item.cwd }
    : type === "fileChange" ? { changes: item.changes }
      : type === "imageGeneration" ? { prompt: item.prompt, revisedPrompt: item.revisedPrompt }
        : item.arguments;
  const output = type === "imageGeneration" ? "图片已生成" : item.aggregatedOutput ?? item.result ?? item.contentItems ?? item.changes ?? item.prompt;
  return { id, entry: { name, title: name, toolKind: type === "commandExecution" ? "terminal" : "other", state, ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}), ...(typeof item.exitCode === "number" ? { terminalExitCode: item.exitCode } : {}) } };
}

export async function readCodexTimeline(server: CodexAppServer, threadId: string, fallbackDate: string, knownEntryIds?: ReadonlySet<string>): Promise<SessionTimelineEntry[]> {
  let cursor: string | null = null;
  let sequence = 0;
  const timeline: SessionTimelineEntry[] = [];
  for (let page = 0; page < 500; page++) {
    const response: unknown = await server.request("thread/items/list", { threadId, limit: 200, sortDirection: "asc", ...(cursor ? { cursor } : {}) });
    if (!isRecord(response) || !Array.isArray(response.data)) throw new Error("Codex 未返回有效的会话历史");
    for (const entry of response.data) {
      if (!isRecord(entry) || !isRecord(entry.item)) continue;
      const item = entry.item;
      const occurredAt = codexDate(entry.startedAtMs, fallbackDate);
      const turnId = typeof entry.turnId === "string" ? entry.turnId : undefined;
      if (item.type === "userMessage") {
        const id = `codex-${String(item.id ?? randomUUID())}`;
        const content = Array.isArray(item.content) ? item.content.filter(isRecord) : [];
        const text = content.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("");
        const alreadyKnown = Boolean(knownEntryIds?.has(id) || (typeof item.id === "string" && knownEntryIds?.has(item.id)));
        const attachments = alreadyKnown ? [] : await codexImportImages(content);
        if (text || attachments.length || alreadyKnown) timeline.push({ kind: "message", id, sequence: ++sequence, ...(turnId ? { turnId } : {}), occurredAt, role: "user", text, complete: true, ...(attachments.length ? { attachments } : {}) });
      } else if (item.type === "agentMessage" && typeof item.text === "string") {
        timeline.push({ kind: "message", id: `codex-${String(item.id ?? randomUUID())}`, sequence: ++sequence, ...(turnId ? { turnId } : {}), occurredAt, role: "assistant", text: item.text, complete: true });
      } else {
        const mappedTool = codexImportedTool(item);
        if (mappedTool) timeline.push({ kind: "tool", id: `codex-${mappedTool.id}`, sequence: ++sequence, ...(turnId ? { turnId } : {}), occurredAt, ...mappedTool.entry });
        if (item.type === "imageGeneration") {
          const imageId = `codex-generated-image-${String(item.id ?? "unknown")}`;
          if (!knownEntryIds?.has(imageId)) {
            const attachments = await codexGeneratedImage(item);
            if (attachments.length) timeline.push({ kind: "message", id: imageId, sequence: ++sequence, ...(turnId ? { turnId } : {}), occurredAt, role: "assistant", text: "", complete: true, attachments });
          }
        }
      }
    }
    cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
    if (!cursor) return timeline;
  }
  throw new Error("Codex 会话历史过长，暂时无法完整读取");
}

export async function codexImportImages(content: JsonRecord[]): Promise<MessageAttachment[]> {
  const attachments: MessageAttachment[] = [];
  for (const [index, block] of content.entries()) {
    if (block.type !== "localImage" || typeof block.path !== "string" || !block.path) continue;
    try {
      const info = await stat(block.path);
      if (!info.isFile() || info.size <= 0 || info.size > 8 * 1024 * 1024) continue;
      const extension = block.path.split(/[./\\]/u).at(-1)?.toLocaleLowerCase() ?? "png";
      const mimeType = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "webp" ? "image/webp" : extension === "gif" ? "image/gif" : extension === "avif" ? "image/avif" : "image/png";
      const data = await readFile(block.path);
      attachments.push({ id: `codex-import-image-${randomUUID()}-${index}`, name: `image-${index + 1}.${extension}`, mimeType, size: data.byteLength, dataUrl: `data:${mimeType};base64,${data.toString("base64")}` });
    } catch { /* Imported histories can reference temporary images that have since been removed. */ }
  }
  return attachments;
}
