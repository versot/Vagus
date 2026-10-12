import type { BrowserElementReference, MessageAttachment } from "@vagus/protocol";

export function imageContent(attachment: MessageAttachment) {
  const comma = attachment.dataUrl.indexOf(",");
  if (comma < 0) return null;
  return { type: "image" as const, mimeType: attachment.mimeType, data: attachment.dataUrl.slice(comma + 1) };
}

export function browserContext(elements: BrowserElementReference[]): string {
  if (!elements.length) return "";
  return `\n\n[用户选中的网页元素]\n${elements.map((item, index) => `元素 ${index + 1}: <${item.tag}>\nURL: ${item.url}\nSelector: ${item.selector}\n${item.text ? `可见文本: ${item.text}\n` : ""}${item.note ? `用户说明: ${item.note}\n` : ""}${item.html ? `HTML: ${item.html}` : ""}`).join("\n\n")}`;
}
