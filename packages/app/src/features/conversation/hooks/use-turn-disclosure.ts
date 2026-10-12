import { useEffect, useRef, useState } from "react";




export function useTurnDisclosure() {
  const [expandedTurnIds, setExpandedTurnIds] = useState<Set<string>>(() => new Set());
  const [collapsedActiveTurnId, setCollapsedActiveTurnId] = useState<string | null>(null);
  const [turnTransitions, setTurnTransitions] = useState<Record<string, "expanding" | "collapsing">>({});
  const turnTransitionTimersRef = useRef<Map<string, number>>(new Map());
  const toggleTurnExpansion = (turnId: string, active: boolean) => {
    const expanded = (active ? collapsedActiveTurnId !== turnId : expandedTurnIds.has(turnId)) && turnTransitions[turnId] !== "collapsing";
    const direction = expanded ? "collapsing" : "expanding";
    setTurnTransitions((current) => ({ ...current, [turnId]: direction }));
    if (active) {
      setCollapsedActiveTurnId(direction === "collapsing" ? turnId : null);
      setExpandedTurnIds((current) => {
        if (!current.has(turnId)) return current;
        const next = new Set(current);
        next.delete(turnId);
        return next;
      });
    } else if (direction === "expanding") setExpandedTurnIds((current) => new Set(current).add(turnId));
    const previousTimer = turnTransitionTimersRef.current.get(turnId);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      if (direction === "collapsing") setExpandedTurnIds((current) => { const next = new Set(current); next.delete(turnId); return next; });
      setTurnTransitions((current) => { if (current[turnId] !== direction) return current; const next = { ...current }; delete next[turnId]; return next; });
      turnTransitionTimersRef.current.delete(turnId);
    }, 220);
    turnTransitionTimersRef.current.set(turnId, timer);
  };
  useEffect(() => () => { for (const timer of turnTransitionTimersRef.current.values()) window.clearTimeout(timer); }, []);
  return { expandedTurnIds, setExpandedTurnIds, collapsedActiveTurnId, setCollapsedActiveTurnId, turnTransitions, toggleTurnExpansion };
}
