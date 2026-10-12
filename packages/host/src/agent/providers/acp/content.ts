import { type SessionNotification } from "@agentclientprotocol/sdk";
import type { BrowserElementReference, MessageAttachment, SessionTimelineEntry } from "@vagus/protocol";
import { randomUUID } from "node:crypto";
import { type AcpRecord } from "./types.js";
import { isRecord, locationPath } from "./utils.js";

export function imageBlock(attachment: MessageAttachment): AcpRecord | null {
  const comma = attachment.dataUrl.indexOf(",");
  if (comma < 0) return null;
  return { type: "image", mimeType: attachment.mimeType, data: attachment.dataUrl.slice(comma + 1) };
}

export function embeddedResourceBlock(attachment: MessageAttachment): AcpRecord | null {
  const comma = attachment.dataUrl.indexOf(",");
  if (comma < 0) return null;
  const encoded = attachment.dataUrl.slice(comma + 1);
  const uri = `urn:vagus:attachment:${encodeURIComponent(attachment.id)}:${encodeURIComponent(attachment.name)}`;
  const textExtensions = new Set([".c", ".cc", ".cpp", ".css", ".csv", ".go", ".h", ".hpp", ".html", ".java", ".js", ".json", ".jsonl", ".jsx", ".md", ".mjs", ".py", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"]);
  const extension = attachment.name.match(/\.[^.]+$/u)?.[0]?.toLowerCase();
  const isText = attachment.mimeType.startsWith("text/") || ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript", "application/typescript"].includes(attachment.mimeType) || Boolean(extension && textExtensions.has(extension));
  return {
    type: "resource",
    resource: isText
      ? { uri, mimeType: attachment.mimeType, text: Buffer.from(encoded, "base64").toString("utf8") }
      : { uri, mimeType: attachment.mimeType, blob: encoded },
  };
}

export function imageAttachment(content: AcpRecord, ordinal = 1): MessageAttachment | null {
  if (content.type !== "image" || typeof content.data !== "string" || typeof content.mimeType !== "string") return null;
  const extensions: Record<string, string> = { "image/avif": "avif", "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png", "image/svg+xml": "svg", "image/webp": "webp" };
  const extension = extensions[content.mimeType] ?? "img";
  const bytes = Buffer.from(content.data, "base64");
  return { id: randomUUID(), name: `image-${ordinal}.${extension}`, mimeType: content.mimeType, size: bytes.byteLength, dataUrl: `data:${content.mimeType};base64,${content.data}` };
}

export function browserContext(elements: BrowserElementReference[]): string {
  if (!elements.length) return "";
  return ["\n\n[用户选中的网页元素]", ...elements.map((element, index) => [
    `元素 ${index + 1}: <${element.tag}>`, `URL: ${element.url}`, `Selector: ${element.selector}`,
    element.text ? `可见文本: ${element.text}` : "", element.note ? `用户说明: ${element.note}` : "",
    element.html ? `HTML 片段: ${element.html}` : "",
  ].filter(Boolean).join("\n"))].join("\n");
}

export function timelineFromSessionUpdates(updates: SessionNotification[], fallbackAt: string): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [];
  const messages = new Map<string, Extract<SessionTimelineEntry, { kind: "message" }>>();
  const tools = new Map<string, Extract<SessionTimelineEntry, { kind: "tool" }>>();
  let sequence = 0;
  let implicitMessageId: string | undefined;
  let implicitMessageRole: "user" | "assistant" | undefined;
  for (const notification of updates) {
    const update = notification.update as AcpRecord;
    const occurredAt = fallbackAt;
    if (update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk") {
      const content = isRecord(update.content) ? update.content : {};
      const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
      if (typeof update.messageId !== "string" && implicitMessageRole !== role) {
        implicitMessageRole = role;
        implicitMessageId = `acp-import-${role}-${randomUUID()}`;
      }
      const id = typeof update.messageId === "string" ? update.messageId : implicitMessageId!;
      let message = messages.get(id);
      if (!message) {
        message = { kind: "message", id, sequence: ++sequence, occurredAt, role, text: "", complete: true };
        messages.set(id, message);
        entries.push(message);
      }
      if (content.type === "text" && typeof content.text === "string") message.text += content.text;
      if (content.type === "image") {
        const attachment = imageAttachment(content, (message.attachments?.length ?? 0) + 1);
        if (!attachment) continue;
        message.attachments = [...(message.attachments ?? []), attachment];
      }
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      if (typeof update.toolCallId !== "string") continue;
      let tool = tools.get(update.toolCallId);
      if (!tool) {
        tool = { kind: "tool", id: update.toolCallId, sequence: ++sequence, occurredAt, name: typeof update.name === "string" ? update.name : typeof update.kind === "string" ? update.kind : "tool", state: "running" };
        tools.set(update.toolCallId, tool);
        entries.push(tool);
      }
      if (typeof update.title === "string") tool.title = update.title;
      if (typeof update.kind === "string") tool.toolKind = update.kind;
      if (update.rawInput !== undefined) tool.input = update.rawInput;
      if (update.rawOutput !== undefined) tool.output = update.rawOutput;
      if (Array.isArray(update.content)) tool.content = update.content;
      if (Array.isArray(update.locations)) tool.locations = locationPath(update.locations);
      if (update.status === "completed") tool.state = "done";
      if (update.status === "failed") tool.state = "error";
    } else if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
      entries.push({ kind: "plan", id: `acp-import-plan-${++sequence}`, sequence, occurredAt, steps: update.entries.flatMap((entry: AcpRecord) => typeof entry.content === "string" ? [{ step: entry.content, status: entry.status === "completed" ? "completed" as const : entry.status === "in_progress" ? "inProgress" as const : "pending" as const }] : []) });
    }
  }
  return entries;
}
