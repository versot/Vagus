import { SESSION_HISTORY_ENTRY_INLINE_BUDGET, SESSION_HISTORY_PAGE_BYTE_BUDGET, type SessionHistoryPage, type SessionTimelineEntry } from "@vagus/protocol";

export function boundedHistoryEntry(entry: SessionTimelineEntry): SessionTimelineEntry {
  const serialized = JSON.stringify(entry);
  if (new TextEncoder().encode(serialized).byteLength <= SESSION_HISTORY_ENTRY_INLINE_BUDGET) return entry;
  if (entry.kind === "message") return {
    ...entry,
    text: Array.from(entry.text).slice(0, 2_000).join(""),
    contentDeferred: true,
    attachments: entry.attachments?.map(({ dataUrl: _dataUrl, ...attachment }) => ({ ...attachment, dataUrl: "" })),
    browserElements: undefined,
  };
  if (entry.kind === "tool") {
    const bounded = { ...entry, contentDeferred: true as const };
    if (entry.name.toLowerCase().includes("image generation")) {
      return { ...entry, output: "图片已生成；图片数据已作为单独附件保存", content: undefined };
    }
    const shorten = (value: unknown): unknown => {
      if (value === undefined) return undefined;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (text.length <= 12_000) return value;
      return `${text.slice(0, 12_000)}\n[内容过大，已折叠；可加载完整结果]`;
    };
    bounded.input = shorten(entry.input);
    bounded.content = shorten(entry.content);
    bounded.locations = shorten(entry.locations);
    bounded.output = shorten(entry.output);
    while (new TextEncoder().encode(JSON.stringify(bounded)).byteLength > SESSION_HISTORY_ENTRY_INLINE_BUDGET) {
      if (bounded.output !== undefined) bounded.output = "[结果过大，已折叠]";
      else if (bounded.content !== undefined) bounded.content = "[内容过大，已折叠]";
      else if (bounded.input !== undefined) bounded.input = "[输入过大，已折叠]";
      else if (bounded.locations !== undefined) bounded.locations = undefined;
      else break;
    }
    return bounded;
  }
  return entry;
}

function lowerBound(entries: readonly SessionTimelineEntry[], sequence: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle]!.sequence < sequence) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Pages end at an exclusive sequence cursor and obey both entry-count and serialized-byte budgets. */
export function readHistoryPage(entries: readonly SessionTimelineEntry[], eventSequence: number, options: { limit?: number; beforeSequence?: number } = {}): SessionHistoryPage {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.floor(options.limit!))) : 120;
  const end = options.beforeSequence === undefined ? entries.length : lowerBound(entries, options.beforeSequence);
  let start = end;
  let byteLength = 2; // JSON array brackets.
  while (start > 0 && end - start < limit) {
    const serializedLength = new TextEncoder().encode(JSON.stringify(boundedHistoryEntry(entries[start - 1]!))).byteLength;
    const nextByteLength = byteLength + serializedLength + (start < end ? 1 : 0);
    if (nextByteLength > SESSION_HISTORY_PAGE_BYTE_BUDGET) break;
    byteLength = nextByteLength;
    start--;
  }
  const page = entries.slice(start, end).map(boundedHistoryEntry);
  byteLength = new TextEncoder().encode(JSON.stringify(page)).byteLength;
  return { entries: page, byteLength, beforeSequence: page[0]?.sequence ?? null, hasMore: start > 0 && page.length > 0, eventSequence };
}
