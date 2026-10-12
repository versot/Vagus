import { useLayoutEffect, useState, type RefObject } from "react";
import { recordPerformance } from "../../../lib/performance.js";

// Keep preparation out of the visible timeline. A Host response does not mean
// that Markdown workers, image loading or virtual-row measurements are done.
export function useConversationReadiness(sessionId: string | null, hydratedSessionId: string | null, scrollRef: RefObject<HTMLElement | null>) {
  const [readySessionId, setReadySessionId] = useState<string | null>(null);
  useLayoutEffect(() => {
    setReadySessionId(null);
    if (!sessionId || hydratedSessionId !== sessionId) return;
    const started = performance.now();
    const maximumPreparationMs = 500;
    let frame = 0;
    let deadline = 0;
    let finished = false;
    let previousLayout = "";
    let stableFrames = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(deadline);
      recordPerformance("conversation.prepare", performance.now() - started);
      setReadySessionId(sessionId);
    };
    const checkLayout = () => {
      const viewport = scrollRef.current;
      if (!viewport) { frame = requestAnimationFrame(checkLayout); return; }
      // The switch starts at the live tail. Scrolling while covered also makes
      // the virtualizer mount and measure the rows that will actually be seen.
      viewport.scrollTop = viewport.scrollHeight;
      const rows = [...viewport.querySelectorAll<HTMLElement>(".timeline-row")].map((row) => {
        const rect = row.getBoundingClientRect();
        return `${row.dataset.timelineRowKey}:${rect.top.toFixed(1)}:${rect.height.toFixed(1)}`;
      });
      const layout = `${viewport.clientWidth}:${viewport.clientHeight}:${viewport.scrollHeight}:${viewport.scrollTop}:${rows.join("|")}`;
      const atBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1;
      stableFrames = atBottom && layout === previousLayout ? stableFrames + 1 : 0;
      previousLayout = layout;
      if (stableFrames >= 3) {
        finish();
        return;
      }
      frame = requestAnimationFrame(checkLayout);
    };
    deadline = window.setTimeout(finish, maximumPreparationMs);
    frame = requestAnimationFrame(checkLayout);
    return () => { finished = true; cancelAnimationFrame(frame); window.clearTimeout(deadline); };
  }, [sessionId, hydratedSessionId, scrollRef]);
  return !sessionId || readySessionId === sessionId && hydratedSessionId === sessionId;
}
