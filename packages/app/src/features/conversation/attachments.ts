import { type MessageAttachment } from "@vagus/protocol";
import i18n from "../../locales/i18n.js";

export function readMessageAttachment(file: File): Promise<MessageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(i18n.t("无法读取附件：{{name}}", { name: file.name })));
    reader.onload = () => {
      if (typeof reader.result !== "string") { reject(new Error(i18n.t("无法读取附件：{{name}}", { name: file.name }))); return; }
      const mimeType = (/^data:([^;,]+)/u.exec(reader.result)?.[1] ?? file.type) || "application/octet-stream";
      resolve({ id: crypto.randomUUID(), name: file.name, mimeType, size: file.size, dataUrl: reader.result });
    };
    reader.readAsDataURL(file);
  });
}
