import type { AgentUsage, MessageAttachment } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { type JsonRecord } from "./types.js";
import { isRecord } from "./utils.js";

export function mapCodexThreadTokenUsage(value: unknown): AgentUsage | null {
  if (!isRecord(value) || !isRecord(value.total) || !isRecord(value.last)) return null;
  const usage: AgentUsage = {};
  const assign = (target: keyof AgentUsage, source: unknown) => {
    if (typeof source === "number" && Number.isFinite(source) && source >= 0) usage[target] = source;
  };
  assign("inputTokens", value.total.inputTokens);
  assign("cachedInputTokens", value.total.cachedInputTokens);
  assign("outputTokens", value.total.outputTokens);
  // `last.totalTokens` is the app-server's count for the latest model request;
  // the cumulative total may exceed the model's context window over time.
  assign("contextWindowUsedTokens", value.last.totalTokens);
  assign("contextWindowMaxTokens", value.modelContextWindow);
  return Object.keys(usage).length ? usage : null;
}

export function mapCodexMcpToolProgressMessage(value: unknown): string | null {
  return isRecord(value) && typeof value.message === "string" && value.message.trim() ? value.message.trim() : null;
}

export function mapCodexMcpToolResult(value: unknown, errorValue?: unknown): { content?: JsonRecord[]; output?: string; isError?: boolean } {
  const content: JsonRecord[] = [];
  const addText = (text: string) => {
    if (!text.trim() || content.length >= 1000) return;
    const bounded = text.length > 200_000 ? `${text.slice(0, 200_000)}\n\n[结果过长，已截断]` : text;
    content.push({ type: "content", content: { type: "text", text: bounded } });
  };
  if (isRecord(value) && Array.isArray(value.content)) {
    for (const block of value.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        addText(block.text);
      } else if (block.type === "resource" && isRecord(block.resource)) {
        const resourceText = typeof block.resource.text === "string" ? block.resource.text : "";
        const uri = typeof block.resource.uri === "string" ? block.resource.uri : "";
        addText([uri ? `资源：${uri}` : "资源", resourceText].filter(Boolean).join("\n"));
      } else if (block.type === "image" || block.type === "audio" || block.type === "resource_link") {
        const mimeType = typeof block.mimeType === "string" ? `（${block.mimeType}）` : "";
        addText(`MCP 返回了${block.type === "image" ? "图片" : block.type === "audio" ? "音频" : "资源链接"}${mimeType}；当前工具结果卡片仅展示文本内容。`);
      } else {
        try { addText(JSON.stringify(block)); } catch { addText("MCP 返回了无法显示的内容块。"); }
      }
    }
  }
  if (isRecord(value) && value.structuredContent !== undefined && value.structuredContent !== null) {
    try { addText(JSON.stringify(value.structuredContent, null, 2)); } catch { addText("MCP 返回了无法序列化的结构化内容。"); }
  }
  const error = typeof errorValue === "string" ? errorValue : isRecord(errorValue) && typeof errorValue.message === "string" ? errorValue.message : "";
  return {
    ...(content.length ? { content } : {}),
    ...(error ? { output: error.slice(0, 200_000) } : {}),
    ...(isRecord(value) && value.isError === true ? { isError: true } : {}),
  };
}

export function mapCodexTurnPlan(value: unknown): { explanation?: string; steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }> } | null {
  if (!isRecord(value) || !Array.isArray(value.plan)) return null;
  const steps = value.plan.slice(0, 100).flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.step !== "string") return [];
    const step = raw.step.trim().slice(0, 1000);
    if (!step) return [];
    const status: "pending" | "inProgress" | "completed" = raw.status === "completed" || raw.status === "inProgress" ? raw.status : "pending";
    return [{ step, status }];
  });
  if (!steps.length) return null;
  const explanation = typeof value.explanation === "string" ? value.explanation.trim().slice(0, 2000) : "";
  return { ...(explanation ? { explanation } : {}), steps };
}

export const CODEX_TURN_DIFF_MAX_CHARS = 500_000;

export function mapCodexTurnDiff(value: unknown): { diff: string; truncated: boolean } | null {
  if (typeof value !== "string") return null;
  return { diff: value.slice(0, CODEX_TURN_DIFF_MAX_CHARS), truncated: value.length > CODEX_TURN_DIFF_MAX_CHARS };
}

export function mapCodexFileChangeDiffs(value: unknown): { input: JsonRecord; content: JsonRecord[] } | null {
  if (!Array.isArray(value)) return null;
  const rows = value.filter((entry): entry is JsonRecord => isRecord(entry) && typeof entry.path === "string" && typeof entry.diff === "string");
  if (!rows.length) return null;
  const content: JsonRecord[] = rows.flatMap((change) => {
    const kind = isRecord(change.kind) && typeof change.kind.type === "string" ? change.kind.type : "update";
    const lines = String(change.diff).replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let inHunk = false;
    for (const line of lines) {
      if (line.startsWith("@@")) { inHunk = true; continue; }
      if (line.startsWith("\\ No newline at end of file") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
      if (!inHunk && kind === "add") { newLines.push(line); continue; }
      if (!inHunk && kind === "delete") { oldLines.push(line); continue; }
      if (line.startsWith("-")) oldLines.push(line.slice(1));
      else if (line.startsWith("+")) newLines.push(line.slice(1));
      else if (line.startsWith(" ")) { oldLines.push(line.slice(1)); newLines.push(line.slice(1)); }
    }
    if (kind === "update" && !oldLines.length && !newLines.length) return [];
    const diff: JsonRecord = { type: "diff", path: change.path, oldText: oldLines.join("\n"), newText: newLines.join("\n") };
    if (!oldLines.length && kind === "add") delete diff.oldText;
    return [diff];
  });
  if (!content.length) return null;
  const changes = rows.map((change) => ({ path: change.path, kind: isRecord(change.kind) && typeof change.kind.type === "string" ? change.kind.type : "update" }));
  return { input: { path: rows[0]!.path, changes }, content };
}

export async function codexGeneratedImage(item: JsonRecord): Promise<MessageAttachment[]> {
  let bytes: Buffer | null = null;
  let declaredMimeType: string | undefined;
  if (typeof item.result === "string" && item.result) {
    const result = item.result.trim();
    const dataUrl = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/iu.exec(result);
    const encoded = dataUrl?.[2] ?? result;
    if (/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length && decoded.byteLength <= 16 * 1024 * 1024 && decoded.toString("base64").replace(/=+$/u, "") === encoded.replace(/=+$/u, "")) {
        bytes = decoded;
        declaredMimeType = dataUrl?.[1]?.toLowerCase();
      }
    }
  }
  // Codex intentionally removes image bytes from app-server notifications and
  // history payloads. Its imageGeneration item retains savedPath, so load the
  // artifact from that path when result is empty.
  if (!bytes && typeof item.savedPath === "string" && item.savedPath && isAbsolute(item.savedPath)) {
    try {
      const info = await stat(item.savedPath);
      if (info.isFile() && info.size > 0 && info.size <= 16 * 1024 * 1024) bytes = await readFile(item.savedPath);
    } catch { /* The artifact can be unavailable if it was moved or cleaned up. */ }
  }
  if (!bytes || !bytes.length || bytes.byteLength > 16 * 1024 * 1024) return [];
  const mimeType = declaredMimeType
    ?? (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg"
        : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp"
          : bytes.subarray(0, 3).toString("ascii") === "GIF" ? "image/gif" : "");
  if (!mimeType) return [];
  const nativeId = typeof item.id === "string" ? item.id : randomUUID();
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
  return [{ id: `codex-generated-image-${nativeId}`, name: `generated-image.${extension}`, mimeType, size: bytes.byteLength, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` }];
}
