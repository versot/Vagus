import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { WorkspaceSession } from "@vagus/client";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function VirtualSessionList({ sessions, renderRow, selectedId, draggingId }: { sessions: WorkspaceSession[]; renderRow(session: WorkspaceSession): ReactNode; selectedId?: string | null; draggingId?: string | null }) {
  const root = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const pendingFocus = useRef<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const viewport = () => root.current?.closest<HTMLElement>(".sidebar-scroll") ?? null;
  const virtualized = sessions.length > 40;
  const virtualizer = useVirtualizer({
    count: sessions.length, getScrollElement: viewport, getItemKey: (index) => sessions[index]!.id, estimateSize: () => 40, scrollMargin: margin, overscan: 5, useFlushSync: false, rangeExtractor: (range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      for (const id of [selectedId, draggingId, focusedId]) { const index = id ? sessions.findIndex((session) => session.id === id) : -1; if (index >= 0) indexes.add(index); }
      return [...indexes].sort((a, b) => a - b);
    }
  });
  useLayoutEffect(() => {
    const element = root.current;
    const scroll = viewport();
    if (!element || !scroll) return;
    const next = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
    if (Math.abs(next - margin) > .5) setMargin(next);
    const target = pendingFocus.current;
    if (target) { const button = element.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(target)}"] .session-open`); if (button) { button.focus({ preventScroll: true }); pendingFocus.current = null; } }
  });
  useLayoutEffect(() => {
    const element = root.current;
    const scroll = viewport();
    if (!element || !scroll) return;
    const update = () => {
      const next = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      setMargin((current) => Math.abs(next - current) > .5 ? next : current);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of scroll.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);
  const rows = virtualized ? virtualizer.getVirtualItems() : null;
  return <div ref={root} className="sidebar-session-window" style={virtualized ? { height: virtualizer.getTotalSize(), position: "relative" } : undefined} onFocusCapture={(event) => setFocusedId((event.target as Element).closest<HTMLElement>("[data-session-id]")?.dataset.sessionId ?? null)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(null); }} onKeyDown={(event) => {
    if (!virtualized || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const id = (event.target as Element).closest<HTMLElement>("[data-session-id]")?.dataset.sessionId;
    if (!id) return;
    const index = sessions.findIndex((session) => session.id === id);
    const next = event.key === "Home" ? 0 : event.key === "End" ? sessions.length - 1 : Math.max(0, Math.min(sessions.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault(); pendingFocus.current = sessions[next]!.id; virtualizer.scrollToIndex(next, { align: "auto" });
    const button = root.current?.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(sessions[next]!.id)}"] .session-open`);
    if (button) { button.focus({ preventScroll: true }); pendingFocus.current = null; }
  }}>
    {rows ? rows.map((row) => <div key={row.key} className="sidebar-session-window-row" data-index={row.index} ref={virtualizer.measureElement} style={{ position: "absolute", top: 0, width: "100%", transform: `translateY(${row.start - margin}px)` }}>{renderRow(sessions[row.index]!)}</div>) : sessions.map((session, index) => <div className="sidebar-session-window-row" key={session.id} data-index={index} ref={virtualizer.measureElement}>{renderRow(session)}</div>)}
  </div>;
}
