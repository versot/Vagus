import { invoke, isTauri } from "@tauri-apps/api/core";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Download, FileText, X } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { jsx, jsxs } from "react/jsx-runtime";
import remarkGfm from "remark-gfm";
import { recordPerformance } from "../../../lib/performance.js";
import i18n from "../../../locales/i18n.js";
import { requestMarkdown, type MarkdownBlock } from "../markdown-service.js";
import type { ChatMessage } from "../types.js";
import { BrowserElementChip } from "./browser-element-chip.js";
import { createMarkdownComponents } from "./markdown-components.js";

const plugins = [remarkGfm];
type MarkdownLinkHandler = (url: string) => void;
const MarkdownBody = memo(function MarkdownBody({ text, onOpenUrl }: { text: string; onOpenUrl?: MarkdownLinkHandler }) {
  const components = useMemo(() => createMarkdownComponents(onOpenUrl), [onOpenUrl]);
  return <ReactMarkdown remarkPlugins={plugins} components={components}>{text}</ReactMarkdown>;
});

const ParsedBlock = memo(function ParsedBlock({ block, onOpenUrl }: { block: MarkdownBlock; onOpenUrl?: MarkdownLinkHandler }) {
  return useMemo(() => {
    const started = performance.now();
    // Match react-markdown's default raw-HTML and unsafe-URL handling.
    const stack: Array<{ type: string; children?: unknown[]; properties?: Record<string, unknown> }> = [block.tree];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === "raw") node.type = "text";
      for (const name of ["href", "src", "cite"]) if (typeof node.properties?.[name] === "string") node.properties[name] = defaultUrlTransform(node.properties[name]);
      if (node.children) stack.push(...node.children as typeof stack);
    }
    const result = toJsxRuntime(block.tree, { Fragment, jsx, jsxs, components: createMarkdownComponents(onOpenUrl) });
    recordPerformance("markdown.compile", performance.now() - started);
    return result;
  }, [block, onOpenUrl]);
});
function AsyncMarkdown({ message, onOpenUrl }: { message: ChatMessage; onOpenUrl?: MarkdownLinkHandler }) {
  const [result, setResult] = useState<{ id: string; blocks: MarkdownBlock[] | null } | null>(null);
  useEffect(() => requestMarkdown(message.id, message.text, message.complete || message.role === "user", (blocks) => setResult({ id: message.id, blocks })), [message.id, message.text, message.complete, message.role]);
  if (result?.id === message.id && result.blocks) return <>{result.blocks.map((block) => <ParsedBlock key={block.key} block={block} onOpenUrl={onOpenUrl} />)}</>;
  if (result?.blocks === null) return <MarkdownBody text={message.text} onOpenUrl={onOpenUrl} />;
  return <span data-markdown-pending="true" style={{ whiteSpace: "pre-wrap" }}>{message.text}</span>;
}

export const MessageContent = memo(function MessageContent({ message, onLoadDeferred, onOpenUrl }: { message: ChatMessage; onLoadDeferred?(message: ChatMessage): Promise<void>; onOpenUrl?: MarkdownLinkHandler }) {
  useTranslation();
  const onOpenUrlRef = useRef(onOpenUrl);
  onOpenUrlRef.current = onOpenUrl;
  const handleOpenUrl = useCallback((url: string) => onOpenUrlRef.current?.(url), []);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<NonNullable<ChatMessage["attachments"]>[number] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const zoomRef = useRef(1);
  useEffect(() => {
    if (!message.contentDeferred || !onLoadDeferred) return;
    let active = true;
    setLoading(true); setFailed(false);
    void onLoadDeferred(message).catch(() => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [message.id, message.contentDeferred, onLoadDeferred]);
  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setPreview(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview]);
  const saveImage = async () => {
    if (!preview || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      if (isTauri()) {
        await invoke<boolean>("save_image_attachment", {
          name: preview.name,
          mimeType: preview.mimeType,
          dataUrl: preview.dataUrl,
          dialogTitle: i18n.t("保存图片到"),
          filterName: i18n.t("图片文件"),
        });
      } else {
        const link = document.createElement("a");
        link.href = preview.dataUrl;
        link.download = preview.name;
        link.click();
      }
    } catch (error) {
      setSaveError(i18n.t("保存图片失败：{{error}}", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSaving(false);
    }
  };
  const onPreviewWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(5, Math.max(0.2, zoomRef.current * factor));
    zoomRef.current = next;
    setZoom(next);
    if (next <= 1) setPan({ x: 0, y: 0 });
  };
  const onPreviewPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
    setIsDragging(true);
  };
  const onPreviewPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setPan({ x: current.panX + event.clientX - current.startX, y: current.panY + event.clientY - current.startY });
  };
  const onPreviewPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const imageAttachments = message.attachments?.filter((attachment) => attachment.mimeType.startsWith("image/") && attachment.dataUrl) ?? [];
  const fileAttachments = message.attachments?.filter((attachment) => !attachment.mimeType.startsWith("image/") && attachment.dataUrl) ?? [];
  return <div className="message-content">
    {message.browserElements?.length ? <BrowserElementChip elements={message.browserElements} /> : null}
    {imageAttachments.length > 0 && <div className="message-attachments">{imageAttachments.map((attachment) => <button className="message-attachment-preview" key={attachment.id} type="button" onClick={() => { setPreview(attachment); zoomRef.current = 1; setZoom(1); setPan({ x: 0, y: 0 }); setSaveError(""); }} title={i18n.t("点击图片放大预览")}><img src={attachment.dataUrl} alt={attachment.name} loading="lazy" /><span className="message-attachment-zoom-hint">{i18n.t("点击图片放大预览")}</span></button>)}</div>}
    {fileAttachments.length > 0 && <div className="message-file-attachments">{fileAttachments.map((attachment) => <div className="message-file-attachment" key={attachment.id}><FileText size={17} aria-hidden="true" /><span title={attachment.name}>{attachment.name}</span><small>{new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(attachment.size / 1024)} KB</small></div>)}</div>}
    {preview && createPortal(<div className="image-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setPreview(null); }}><section className="image-preview-dialog" role="dialog" aria-modal="true" aria-label={preview.name}><header className="image-preview-toolbar"><span className="image-preview-name" title={preview.name}>{preview.name}</span><div className="image-preview-actions"><button type="button" className="image-preview-action" onClick={() => void saveImage()} disabled={saving} title={i18n.t("{{name}} · 下载图片", { name: preview.name })} aria-label={i18n.t("{{name}} · 下载图片", { name: preview.name })}><Download size={16} /><span>{i18n.t(saving ? "正在保存…" : "保存图片")}</span></button><button type="button" className="image-preview-action image-preview-close" onClick={() => setPreview(null)} disabled={saving} title={i18n.t("关闭预览")} aria-label={i18n.t("关闭预览")}><X size={17} /></button></div></header><div className={`image-preview-stage${zoom > 1 ? " is-zoomed" : ""}${isDragging ? " is-dragging" : ""}`} onWheel={onPreviewWheel} onPointerDown={onPreviewPointerDown} onPointerMove={onPreviewPointerMove} onPointerUp={onPreviewPointerUp} onPointerCancel={onPreviewPointerUp} onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }}><img src={preview.dataUrl} alt={preview.name} draggable={false} style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }} />{saveError && <div className="image-preview-error" role="alert">{saveError}</div>}</div></section></div>, document.body)}
    {message.contentDeferred && <button className="message-content-retry" type="button" disabled={loading} onClick={() => { setFailed(false); setLoading(true); void onLoadDeferred?.(message).catch(() => setFailed(true)).finally(() => setLoading(false)); }}>{failed ? i18n.t("重试加载完整内容") : i18n.t(loading ? "正在加载完整内容…" : "加载完整内容")}</button>}
    {message.text.length > 2000 ? <AsyncMarkdown key={message.id} message={message} onOpenUrl={handleOpenUrl} /> : <MarkdownBody text={message.text} onOpenUrl={handleOpenUrl} />}
    {message.deliveryState && <div className={`user-message-delivery is-${message.deliveryState}`} role="status">{message.deliveryState === "sending" ? i18n.t("正在发送…") : i18n.t("发送失败，请在输入框重试")}</div>}
  </div>;
});
