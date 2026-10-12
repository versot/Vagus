import type { SessionUiState } from "@vagus/protocol";
import { ChevronRight, ChevronUp, Layers2, RotateCcw, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../../locales/i18n.js";

type AnsiStyle = CSSProperties;

function ansiColor(index: number): string {
  const lightTheme = document.documentElement.dataset.theme === "light";
  const base = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
  if (index < 16) return `var(--extension-ansi-${index}, ${base[index] ?? base[0]!})`;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    const themeLevel = lightTheme ? Math.round(100 - (level / 255) * 40) : level;
    return `rgb(${themeLevel}, ${themeLevel}, ${themeLevel})`;
  }
  const color = index - 16;
  const channel = (value: number) => value === 0 ? 0 : 55 + value * 40;
  return `rgb(${channel(Math.floor(color / 36))}, ${channel(Math.floor(color / 6) % 6)}, ${channel(color % 6)})`;
}

function readableAnsiForeground(color: string): string {
  if (document.documentElement.dataset.theme !== "light") return color;
  const match = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i);
  if (!match) return color;
  const channels = match.slice(1).map(Number);
  const luminance = channels.reduce((total, channel) => total + (channel / 255) ** 2.2 / 3, 0);
  if (luminance <= 0.18) return color;
  const scale = Math.sqrt(0.18 / luminance);
  return `rgb(${channels.map((channel) => Math.round(channel * scale)).join(", ")})`;
}

function AnsiLine({ text }: { text: string }) {
  const style: AnsiStyle = {};
  const lightTheme = document.documentElement.dataset.theme === "light";
  let cursor = 0;
  const pieces: Array<{ text: string; style: AnsiStyle }> = [];
  const sgrPattern = /\u001b\[([0-9;:]*)m/g;
  const apply = (sequence: string) => {
    const codes = sequence.replaceAll(":", ";").split(";").filter(Boolean).map(Number);
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!;
      if (code === 0) { for (const key of Object.keys(style)) delete (style as Record<string, unknown>)[key]; }
      else if (code === 1) style.fontWeight = 700;
      else if (code === 2) style.opacity = lightTheme ? 1 : 0.65;
      else if (code === 3) style.fontStyle = "italic";
      else if (code === 4) style.textDecoration = "underline";
      else if (code === 9) style.textDecoration = "line-through";
      else if (code === 22) { delete style.fontWeight; delete style.opacity; }
      else if (code === 23) delete style.fontStyle;
      else if (code === 24 || code === 29) delete style.textDecoration;
      else if (code === 39) delete style.color;
      else if (code === 49) delete style.backgroundColor;
      else if (code >= 30 && code <= 37) style.color = ansiColor(code - 30);
      else if (code >= 90 && code <= 97) style.color = ansiColor(code - 90 + 8);
      else if (code >= 40 && code <= 47) style.backgroundColor = ansiColor(code - 40);
      else if (code >= 100 && code <= 107) style.backgroundColor = ansiColor(code - 100 + 8);
      else if ((code === 38 || code === 48) && codes[index + 1] === 5 && codes[index + 2] !== undefined) {
        const value = ansiColor(codes[index + 2]!);
        if (code === 38) style.color = readableAnsiForeground(value); else style.backgroundColor = value;
        index += 2;
      } else if ((code === 38 || code === 48) && codes[index + 1] === 2 && codes[index + 4] !== undefined) {
        const value = `rgb(${codes[index + 2]}, ${codes[index + 3]}, ${codes[index + 4]})`;
        if (code === 38) style.color = readableAnsiForeground(value); else style.backgroundColor = value;
        index += 4;
      }
    }
  };
  for (const match of text.matchAll(sgrPattern)) {
    const start = match.index ?? 0;
    if (start > cursor) pieces.push({ text: text.slice(cursor, start), style: { ...style } });
    apply(match[1] ?? "0");
    cursor = start + match[0].length;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), style: { ...style } });
  if (!pieces.length) pieces.push({ text: "\u00a0", style: {} });
  return <>{pieces.map((piece, index) => <span key={index} style={piece.style}>{piece.text}</span>)}</>;
}

function encodeTuiKey(event: React.KeyboardEvent<HTMLDivElement>): string | null {
  if (event.nativeEvent.isComposing || event.key === "Dead") return null;
  const named: Record<string, string> = {
    Enter: "\r", Escape: "\u001b", Tab: "\t", Backspace: "\u007f", Delete: "\u001b[3~",
    ArrowUp: "\u001b[A", ArrowDown: "\u001b[B", ArrowRight: "\u001b[C", ArrowLeft: "\u001b[D",
    Home: "\u001b[H", End: "\u001b[F", PageUp: "\u001b[5~", PageDown: "\u001b[6~",
  };
  const key = named[event.key];
  if (key) return event.ctrlKey && event.key === "Enter" ? "\u001b[13;5u" : key;
  if (event.ctrlKey && event.key.length === 1) {
    const code = event.key.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
    if (event.key === "[") return "\u001b";
  }
  if (!event.altKey && !event.metaKey && event.key.length === 1) return event.key;
  if (event.altKey && event.key.length === 1) return `\u001b${event.key}`;
  return null;
}

function ExtensionWidget({ widget, onInput }: { widget: SessionUiState["widgets"][number]; onInput(widgetKey: string, input: string): void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const inputCaptureRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  const textLines = widget.content.lines;
  const title = widget.content.title?.trim() || widget.key.replace(/^extension:/, "");
  const interactive = widget.content.type === "tui" && widget.content.interactive === true;
  useEffect(() => {
    const content = contentRef.current;
    if (!interactive || !content || typeof ResizeObserver === "undefined") return;
    let previous = "";
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(content);
      const fontSize = Number.parseFloat(style.fontSize) || 12;
      const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.45;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (context) context.font = style.font;
      const cellWidth = Math.max(1, context?.measureText("M").width ?? fontSize * 0.62);
      const columns = Math.max(24, Math.min(240, Math.floor(content.clientWidth / cellWidth)));
      const rows = Math.max(4, Math.min(40, Math.floor(Math.max(content.clientHeight, lineHeight * 4) / lineHeight)));
      const next = `${columns}x${rows}`;
      if (next === previous) return;
      previous = next;
      onInputRef.current(widget.key, JSON.stringify({ type: "resize", columns, rows }));
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [interactive, widget.key]);
  const sendMouse = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive || event.button !== 0) return;
    const line = (event.target as HTMLElement).closest("pre");
    if (!line || !event.currentTarget.contains(line)) return;
    const bounds = line.getBoundingClientRect();
    const style = getComputedStyle(event.currentTarget);
    const fontSize = Number.parseFloat(style.fontSize) || 12;
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.45;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context) context.font = style.font;
    const cellWidth = Math.max(1, context?.measureText("M").width ?? fontSize * 0.62);
    const x = Math.max(0, Math.floor((event.clientX - bounds.left) / cellWidth));
    const y = Math.max(0, Math.floor((event.clientY - event.currentTarget.getBoundingClientRect().top) / lineHeight));
    const columns = Math.max(24, Math.min(240, Math.floor(event.currentTarget.clientWidth / cellWidth)));
    const rows = Math.max(4, Math.min(40, Math.floor(Math.max(event.currentTarget.clientHeight, lineHeight * 4) / lineHeight)));
    onInput(widget.key, JSON.stringify({ type: "mouse", event: { type: "click", button: "left", x, y, screenX: x, screenY: y, width: columns, height: rows, shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey, clickCount: 1 } }));
  };
  const focusInput = () => inputCaptureRef.current?.focus({ preventScroll: true });
  return <section className="extension-widget" data-widget-key={widget.key} aria-label={title}>
    <div className="extension-widget-title-row"><div className="extension-widget-title" title={title}>{title}</div>{interactive && <button className="extension-widget-close" type="button" aria-label={i18n.t("关闭自定义界面")} title={i18n.t("关闭界面（Esc）")} onClick={() => onInput(widget.key, JSON.stringify({ type: "key", data: "\u001b" }))}><X size={13} aria-hidden="true" /></button>}</div>
    {textLines.length > 0 && <div ref={contentRef} className={`extension-widget-content${widget.content.type === "tui" ? " is-tui" : ""}${interactive ? " is-interactive" : ""}`} tabIndex={interactive ? 0 : undefined} role={interactive ? "application" : undefined} aria-label={interactive ? i18n.t("{{title}}，点击后可使用键盘操作", { title }) : undefined}
      onKeyDown={interactive ? (event) => { const data = encodeTuiKey(event); if (data === null) return; event.preventDefault(); event.stopPropagation(); onInput(widget.key, JSON.stringify({ type: "key", data })); } : undefined}
      onCompositionStart={interactive ? () => { composingRef.current = true; } : undefined}
      onCompositionEnd={interactive ? (event) => { composingRef.current = false; const data = event.data; if (data) onInput(widget.key, JSON.stringify({ type: "key", data })); if (event.target instanceof HTMLTextAreaElement) event.target.value = ""; } : undefined}
      onClick={interactive ? (event) => { sendMouse(event); focusInput(); } : undefined}>
      {interactive && <textarea ref={inputCaptureRef} className="tui-input-capture" aria-hidden="true" tabIndex={-1} onChange={(event) => { if (!composingRef.current) event.currentTarget.value = ""; }} />}
      {textLines.map((line, index) => widget.content.type === "tui"
        ? <pre key={index}><AnsiLine text={line} /></pre>
        : <div key={index}>{line || "\u00a0"}</div>)}
    </div>}
  </section>;
}

export function ExtensionWidgets({ widgets, stale, activation, onInput }: { widgets: SessionUiState["widgets"]; stale: boolean; activation?: { key: string } | null; onInput(widgetKey: string, input: string): void }) {
  useTranslation();
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousActivationRef = useRef(activation);
  const pendingFocusKeyRef = useRef<string | null>(null);
  const contentId = useId();
  const visible = widgets;
  useEffect(() => {
    if (previousActivationRef.current === activation) return;
    previousActivationRef.current = activation;
    if (!activation || stale || !widgets.some((widget) => widget.key === activation.key && widget.content.type === "tui" && widget.content.interactive)) return;
    pendingFocusKeyRef.current = activation.key;
    setExpanded(true);
  }, [activation, stale, widgets]);
  useLayoutEffect(() => {
    if (!expanded || !pendingFocusKeyRef.current) return;
    const list = listRef.current;
    const target = Array.from(list?.querySelectorAll<HTMLElement>(".extension-widget") ?? [])
      .find((element) => element.dataset.widgetKey === pendingFocusKeyRef.current);
    const input = target?.querySelector<HTMLTextAreaElement>(".tui-input-capture");
    if (!list || !target || !input) return;
    // Scroll only the popup's list; never move the conversation viewport.
    list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top;
    input.focus({ preventScroll: true });
    pendingFocusKeyRef.current = null;
  }, [expanded, widgets]);
  useEffect(() => { if (!widgets.length) setExpanded(false); }, [widgets.length]);
  useEffect(() => {
    if (!expanded) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setExpanded(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      // An interactive TUI handles its own Escape key before this listener.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setExpanded(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [expanded]);
  if (!visible.length) return null;
  return <section ref={rootRef} className={`extension-widgets${stale ? " is-stale" : ""}${expanded ? " is-expanded" : ""}`} aria-label={i18n.t("扩展组件")}>
    {stale && <span className="extension-stale-label">{i18n.t("连接已断开，内容可能已过期")}</span>}
    <button ref={triggerRef} className="extension-widgets-heading" aria-expanded={expanded} aria-controls={contentId} title={expanded ? i18n.t("收起扩展组件") : i18n.t("向上打开扩展组件")} onClick={() => {
      if (!expanded) pendingFocusKeyRef.current = [...widgets].reverse().find((widget) => widget.content.type === "tui" && widget.content.interactive)?.key ?? null;
      setExpanded((value) => !value);
    }}>
      <Layers2 size={14} aria-hidden="true" /><span>{i18n.t("扩展组件")}</span><small>{visible.length}</small>
      <ChevronUp className="extension-widgets-chevron" size={14} aria-hidden="true" />
    </button>
    <div id={contentId} className="extension-widgets-reveal" role="region" aria-label={i18n.t("扩展组件详情")} aria-hidden={!expanded} inert={!expanded}>
      <div ref={listRef} className="extension-widgets-list">{visible.map((widget) => <ExtensionWidget key={widget.key} widget={widget} onInput={onInput} />)}</div>
    </div>
  </section>;
}

export function ExtensionStatusRail({ statuses, stale }: { statuses: SessionUiState["statuses"]; stale: boolean }) {
  useTranslation();
  const visibleStatuses = statuses.filter((item) => !item.key.startsWith("claude-subagent:"));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => { if (!visibleStatuses.length) setOpen(false); }, [visibleStatuses.length]);
  if (!visibleStatuses.length) return null;
  return <div className={`extension-status-rail${stale ? " is-stale" : ""}${open ? " is-open" : ""}`} ref={ref} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <button ref={trigger} className="extension-status-trigger" aria-label={visibleStatuses.length > 1 ? i18n.t("扩展状态，{{count}} 项", { count: visibleStatuses.length }) : i18n.t("扩展状态")} aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId}>{i18n.t("扩展状态")}{visibleStatuses.length > 1 ? <small>{visibleStatuses.length}</small> : null}<ChevronRight size={12} /></button>
    {open && <section id={panelId} className="extension-status-popover" aria-label={i18n.t("扩展状态详情")}>
      {visibleStatuses.map((item) => <div className="extension-status-item" key={item.key}><span>{item.text}</span></div>)}
      {stale && <p>{i18n.t("连接恢复后重新获取状态。")}</p>}
    </section>}
  </div>;
}

export function ExtensionDraftBar({ suggestion, canUndo, onAccept, onDiscard, onUndo }: {
  suggestion?: SessionUiState["editorText"]; canUndo: boolean; onAccept(mode: "replace" | "insert"): void; onDiscard(): void; onUndo(): void;
}) {
  useTranslation();
  if (!suggestion && !canUndo) return null;
  return <div className="extension-draft-bar" role="status">
    {suggestion ? <><Layers2 size={13} aria-hidden="true" /><span title={suggestion.text}>{i18n.t("扩展提供了")}{suggestion.text ? i18n.t("草稿") : i18n.t("清空草稿请求")}</span><button onClick={() => onAccept("replace")}>{i18n.t("替换")}</button>{suggestion.text && <button onClick={() => onAccept("insert")}>{i18n.t("插入")}</button>}<button aria-label={i18n.t("忽略扩展草稿")} title={i18n.t("忽略")} onClick={onDiscard}><X size={13} /></button></> : <><CheckMark /><span>{i18n.t("已应用扩展草稿")}</span><button onClick={onUndo}><RotateCcw size={12} />{i18n.t("撤销")}</button></>}
  </div>;
}

function CheckMark() { return <span className="extension-draft-check" aria-hidden="true">✓</span>; }
