import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import i18n from "../../../locales/i18n.js";
import type { ChatMessage } from "../types.js";

export function MessageNavigation({ messages, activeId, onJump }: { messages: ChatMessage[]; activeId: string | null; onJump(id: string): void }) {
  const stable = useRef(messages);
  if (stable.current.length !== messages.length || !messages.every((message, index) => stable.current[index] === message)) stable.current = messages;
  const jump = useRef(onJump);
  useLayoutEffect(() => { jump.current = onJump; });
  const callback = useRef((id: string) => jump.current(id));
  return <NavigationContent messages={stable.current} activeId={activeId} onJump={callback.current} />;
}

const NavigationContent = memo(function NavigationContent({ messages, activeId, onJump }: { messages: ChatMessage[]; activeId: string | null; onJump(id: string): void }) {
  useTranslation();
  const navRef = useRef<HTMLElement>(null);
  const [hover, setHover] = useState<{ index: number; top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!activeId) return;
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>(`[data-query-id="${CSS.escape(activeId)}"]`);
    if (!nav || !active) return;
    const navRect = nav.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    const visibleTop = navRect.top + 6;
    const visibleBottom = navRect.bottom - 6;
    if (itemRect.top < visibleTop) nav.scrollTop -= visibleTop - itemRect.top;
    else if (itemRect.bottom > visibleBottom) nav.scrollTop += itemRect.bottom - visibleBottom;
  }, [activeId]);

  const preview = (message: ChatMessage) => (message.text.trim() || message.attachments?.map((attachment) => attachment.name).join(", ") || i18n.t("图片消息")).replace(/\s+/g, " ");
  const showPreview = (button: HTMLButtonElement, index: number) => {
    const nav = navRef.current;
    const rect = button.getBoundingClientRect();
    setHover({ index, top: Math.max(30, Math.min(window.innerHeight - 30, rect.top + rect.height / 2)), left: (nav?.getBoundingClientRect().right ?? rect.right) + 8 });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? messages.length - 1 : Math.max(0, Math.min(messages.length - 1, index + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : event.key === "PageUp" ? -10 : 10)));
    const message = messages[next];
    if (!message) return;
    onJump(message.id);
    navRef.current?.querySelector<HTMLButtonElement>(`[data-query-id="${CSS.escape(message.id)}"]`)?.focus({ preventScroll: true });
  };

  const distributeMarkers = messages.length > 0 && messages.length <= 50;
  const markerNavHeight = distributeMarkers
    ? `min(${messages.length * 12 + (messages.length - 1) * 16 + 12}px, 612px, 58vh, calc(100% - 32px))`
    : undefined;

  return <>
    <nav ref={navRef} className={`conversation-query-nav${distributeMarkers ? " is-distributed" : ""}`} style={markerNavHeight ? { height: markerNavHeight } : undefined} aria-label={i18n.t("用户消息导航")} onScroll={() => setHover(null)}>
      {messages.map((message, index) => <button key={message.id} data-query-id={message.id} type="button" className={`conversation-query-nav-item${activeId === message.id ? " is-active" : ""}`} aria-label={i18n.t("跳转到用户消息 {{index}}：{{preview}}", { index: index + 1, preview: preview(message) })} aria-current={activeId === message.id ? "location" : undefined} aria-posinset={index + 1} aria-setsize={messages.length} onMouseEnter={(event) => showPreview(event.currentTarget, index)} onMouseLeave={() => setHover(null)} onFocus={(event) => showPreview(event.currentTarget, index)} onBlur={() => setHover(null)} onKeyDown={(event) => handleKeyDown(event, index)} onClick={() => onJump(message.id)}><span className="conversation-query-nav-mark" aria-hidden="true" /></button>)}
    </nav>
    {hover && createPortal(<span className="conversation-query-nav-preview" aria-hidden="true" style={{ top: hover.top, left: hover.left }}>{hover.index + 1}. {preview(messages[hover.index]!)}</span>, document.body)}
  </>;
});
