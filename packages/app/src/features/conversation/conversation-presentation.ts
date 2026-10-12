import type { ChatMessage, ToolActivity } from "./types.js";

export type ActivityIcon = "search" | "shell" | "read" | "edit" | "write" | "tool";

export function toolInputField(activity: ToolActivity, names: string[]): string | undefined {
  if (typeof activity.input !== "object" || activity.input === null || Array.isArray(activity.input)) return undefined;
  for (const name of names) {
    const value = (activity.input as Record<string, unknown>)[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function hasToolInput(activity: ToolActivity): boolean {
  const input = activity.input;
  if (input === undefined) return false;
  return typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).length > 0;
}

export type ToolDiffBlock = { path: string; oldText?: string; newText: string };

function structuredToolContent(activity: ToolActivity): unknown[] {
  const blocks = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value;
    if (typeof value === "object" && value !== null && Array.isArray((value as Record<string, unknown>).content)) {
      return (value as { content: unknown[] }).content;
    }
    return [];
  };
  const content = blocks(activity.content);
  const output = blocks(activity.output);
  if (!content.length) return output;
  if (!output.length) return content;

  // Some ACP agents send a placeholder/terminal content block on the tool
  // update and the structured diff only in rawOutput on completion. Preserve
  // both payloads while avoiding duplicate blocks when an agent repeats them.
  const merged = [...content];
  const known = new Set(content.map((block) => {
    try { return JSON.stringify(block); } catch { return undefined; }
  }).filter((key): key is string => key !== undefined));
  for (const block of output) {
    let key: string | undefined;
    try { key = JSON.stringify(block); } catch { /* Keep non-serializable blocks without deduplication. */ }
    if (key !== undefined && known.has(key)) continue;
    merged.push(block);
    if (key !== undefined) known.add(key);
  }
  return merged;
}

export function toolDiffBlocks(activity: ToolActivity): ToolDiffBlock[] {
  return structuredToolContent(activity).flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const value = block as Record<string, unknown>;
    if (value.type !== "diff" || typeof value.path !== "string" || typeof value.newText !== "string") return [];
    return [{ path: value.path, ...(typeof value.oldText === "string" ? { oldText: value.oldText } : {}), newText: value.newText }];
  });
}

export function toolContentText(activity: ToolActivity): string[] {
  return structuredToolContent(activity).flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const value = block as Record<string, unknown>;
    if (value.type === "content" && typeof value.content === "object" && value.content !== null) {
      const content = value.content as Record<string, unknown>;
      return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
    }
    return [];
  });
}

export function buildToolPresentation(activity: ToolActivity): { label: string; summary?: string; icon: ActivityIcon } {
  const name = activity.name.toLowerCase().split(/[.:/]/).at(-1) ?? activity.name.toLowerCase();
  const path = () => toolDiffBlocks(activity)[0]?.path ?? toolInputField(activity, ["path", "filePath", "file_path", "file", "cwd", "directory"]);
  if (/^(bash|shell|command|run_command|exec_command|terminal)$/.test(name)) {
    return { label: "Shell", icon: "shell", summary: toolInputField(activity, ["command", "cmd", "script"])?.replace(/\s+/g, " ").trim() };
  }
  if (/search|grep|glob/.test(name) || /^(find|ls|list|list_files|list_directory)$/.test(name)) {
    return { label: "Search", icon: "search", summary: toolInputField(activity, ["query", "pattern", "searchTerm", "search_term", "glob"]) ?? path() ?? (name === "ls" ? "ls" : undefined) };
  }
  if (/^(read|read_file|readfile)$/.test(name)) return { label: "Read", icon: "read", summary: path() };
  if (/^(edit|edit_file|apply_patch|patch)$/.test(name)) return { label: "Edit", icon: "edit", summary: path() };
  if (/^(write|write_file|create|create_file)$/.test(name)) return { label: "Write", icon: "write", summary: path() };
  const title = activity.title?.trim();
  if (activity.toolKind === "execute") return { label: title || "Shell", icon: "shell", summary: toolInputField(activity, ["command", "cmd", "script"])?.replace(/\s+/g, " ").trim() ?? path() };
  if (activity.toolKind === "read") return { label: title || "Read", icon: "read", summary: path() };
  if (activity.toolKind === "edit") return { label: title || "Edit", icon: "edit", summary: path() };
  if (activity.toolKind === "search") return { label: title || "Search", icon: "search", summary: path() };
  return { label: activity.name.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()), icon: "tool", summary: path() };
}

export function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "object" && !Array.isArray(value)) {
    const content = (value as Record<string, unknown>).content;
    if (Array.isArray(content) && content.length && content.every((block) => block && block.type === "text" && typeof block.text === "string")) {
      return content.map((block) => block.text).join("\n");
    }
  }
  try { return JSON.stringify(value, null, 2) ?? String(value); }
  catch { return String(value); }
}

export function hasToolContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// A provider can complete an assistant message that contained only tool calls.
// Keep its event in history, but do not give an empty text block space in the UI.
export function isVisibleChatMessage(message: ChatMessage): boolean {
  return Boolean(message.text.trim() || message.attachments?.length);
}

export function isConversationActivity(entry: { kind: string } | undefined): boolean {
  return entry?.kind === "tool" || entry?.kind === "status" || entry?.kind === "plan" || entry?.kind === "turnDiff";
}
