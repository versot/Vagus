import { type BrowserElementReference, type MessageAttachment } from "@vagus/protocol";

export interface PromptContentServicesContract {
  parseMessageAttachments(value: unknown): MessageAttachment[];
  parseBrowserElements(value: unknown): BrowserElementReference[];
}

export function createPromptContentServices(): PromptContentServicesContract {
  function parseMessageAttachments(value: unknown): MessageAttachment[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 4) throw new Error("一次最多添加 4 个附件");
    let totalBytes = 0;
    return value.map((item): MessageAttachment => {
      if (typeof item !== "object" || item === null) throw new Error("附件格式无效");
      const attachment = item as Record<string, unknown>;
      const id = typeof attachment.id === "string" ? attachment.id : "";
      const name = typeof attachment.name === "string" ? attachment.name.trim().slice(0, 180) : "";
      const dataUrl = typeof attachment.dataUrl === "string" ? attachment.dataUrl : "";
      const match = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(dataUrl);
      if (!id || !name || !match) throw new Error("附件编码无效");
      const mimeType = match[1]!.toLowerCase();
      if (typeof attachment.mimeType === "string" && attachment.mimeType.toLowerCase() !== mimeType) throw new Error("附件类型与内容不一致");
      const bytes = Buffer.from(match[2]!, "base64");
      if (bytes.toString("base64") !== match[2]) throw new Error("附件编码无效");
      totalBytes += bytes.byteLength;
      if (bytes.byteLength > 4 * 1024 * 1024 || totalBytes > 5 * 1024 * 1024) throw new Error("附件总大小不能超过 5 MB");
      return { id, name, mimeType, size: bytes.byteLength, dataUrl };
    });
  }

  function parseBrowserElements(value: unknown): BrowserElementReference[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20) throw new Error("一次最多附加 20 个网页元素");
    return value.map((item): BrowserElementReference => {
      if (typeof item !== "object" || item === null) throw new Error("网页元素格式无效");
      const element = item as Record<string, unknown>;
      const id = typeof element.id === "string" ? element.id.slice(0, 128) : "";
      const url = typeof element.url === "string" ? element.url.slice(0, 2048) : "";
      const selector = typeof element.selector === "string" ? element.selector.slice(0, 1000) : "";
      const tag = typeof element.tag === "string" ? element.tag.slice(0, 80) : "";
      if (!id || !selector || !tag || !/^https?:\/\//i.test(url)) throw new Error("网页元素信息不完整");
      return {
        id, url, selector, tag,
        text: typeof element.text === "string" ? element.text.slice(0, 500) : "",
        html: typeof element.html === "string" ? element.html.slice(0, 4000) : "",
        ...(typeof element.note === "string" && element.note.trim() ? { note: element.note.trim().slice(0, 500) } : {}),
      };
    });
  }
  return { parseMessageAttachments, parseBrowserElements };
}
