import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";

export interface ConversationRow { key: string; index: number; estimate: number; pinned?: boolean; }
export interface VirtualConversationHandle { scrollToKey(key: string): boolean; getFirstVisibleIndex(): number | null; isVirtualized: boolean; }

export function VirtualConversation({ rows, scrollRef, renderRow, layoutKey, ref }: {
  rows: ConversationRow[];
  scrollRef: RefObject<HTMLElement | null>;
  renderRow(index: number): ReactNode;
  layoutKey: string;
  ref?: Ref<VirtualConversationHandle>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const enabled = rows.length > 80;
  const getItemKey = useCallback((index: number) => rows[index]!.key, [rows]);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = new Set(defaultRangeExtractor(range));
    // Keep the live tail and active controls mounted as older rows leave view.
    for (let index = Math.max(0, rows.length - 20); index < rows.length; index++) indexes.add(index);
    rows.forEach((row, index) => { if (row.pinned) indexes.add(index); });
    return [...indexes].sort((a, b) => a - b);
  }, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length, getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]!.estimate, getItemKey, rangeExtractor,
    // Measure short conversations too, so crossing the virtualization threshold
    // during a prepend retains the same key/size cache and reading anchor.
    overscan: 6, scrollMargin, scrollPaddingStart: 20,
    anchorTo: "end", scrollEndThreshold: 2, useFlushSync: false,
  });
  useLayoutEffect(() => {
    const root = rootRef.current;
    const viewport = scrollRef.current;
    if (!root || !viewport) return;
    const updateMargin = () => {
      const next = root.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
      setScrollMargin((current) => Math.abs(current - next) > 0.5 ? next : current);
    };
    updateMargin();
    const observer = new ResizeObserver(updateMargin);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [scrollRef, layoutKey, enabled]);
  useImperativeHandle(ref, () => ({
    isVirtualized: enabled,
    getFirstVisibleIndex() {
      const viewport = scrollRef.current;
      if (!viewport) return null;
      if (enabled) {
        const item = virtualizer.getVirtualItemForOffset(viewport.scrollTop + 24);
        return item ? rows[item.index]?.index ?? null : null;
      }
      const top = viewport.getBoundingClientRect().top + 24;
      const element = [...rootRef.current?.querySelectorAll<HTMLElement>("[data-conversation-index]") ?? []].find((row) => row.getBoundingClientRect().bottom > top);
      return element ? Number(element.dataset.conversationIndex) : null;
    },
    scrollToKey(key) {
      const index = rows.findIndex((row) => row.key === key);
      if (index < 0) return false;
      const viewport = scrollRef.current;
      if (!viewport) return false;
      const alignTarget = () => {
        const element = viewport.querySelector<HTMLElement>(`[data-timeline-row-key="${CSS.escape(key)}"]`);
        if (!element) return false;
        const viewportRect = viewport.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const topOffset = 20;
        const bottomOffset = 20;
        const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
        const targetTop = maxScrollTop > 0 && viewport.scrollTop >= maxScrollTop - 1 && elementRect.bottom > viewportRect.bottom - bottomOffset
          ? elementRect.bottom - viewportRect.bottom + bottomOffset
          : elementRect.top - viewportRect.top - topOffset;
        if (Math.abs(targetTop) > 0.5) viewport.scrollTop += targetTop;
        return true;
      };
      if (enabled) {
        virtualizer.scrollToIndex(index, { align: "start", behavior: "auto" });
        let attempts = 0;
        let stableFrames = 0;
        const correctMeasuredPosition = () => {
          if (!viewport.isConnected || attempts++ > 12) return;
          const before = viewport.scrollTop;
          const found = alignTarget();
          if (!found) { requestAnimationFrame(correctMeasuredPosition); return; }
          if (Math.abs(viewport.scrollTop - before) < 0.5) stableFrames++;
          else stableFrames = 0;
          // Variable-height rows can still be measured after the first jump. Keep
          // the target anchored until both its position and scroll offset settle.
          if (stableFrames < 2) requestAnimationFrame(correctMeasuredPosition);
        };
        requestAnimationFrame(correctMeasuredPosition);
      } else if (!alignTarget()) return false;
      return true;
    },
  }), [rows, enabled, scrollRef, virtualizer]);
  const virtualRows = enabled ? virtualizer.getVirtualItems() : null;
  return <div ref={rootRef} className={`timeline-rows${enabled ? " is-virtualized" : ""}`} style={enabled ? { height: virtualizer.getTotalSize(), position: "relative" } : undefined}>
    {virtualRows ? virtualRows.map((item) => <div key={item.key} data-index={item.index} data-conversation-index={rows[item.index]!.index} data-timeline-row-key={rows[item.index]!.key} ref={virtualizer.measureElement} className="timeline-row" style={{ position: "absolute", width: "100%", top: 0, left: 0, transform: `translateY(${item.start - scrollMargin}px)` }}>{renderRow(rows[item.index]!.index)}</div>)
      : rows.map((row, index) => <div className="timeline-row" key={row.key} data-index={index} ref={virtualizer.measureElement} data-conversation-index={row.index} data-timeline-row-key={row.key}>{renderRow(row.index)}</div>)}
  </div>;
}
