import { type Project, type WorkspaceSession, type WorkspaceSnapshot } from "@vagus/client";
import { useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { manualProjectOrderKey, manualSessionOrderKey, pinnedProjectIdsKey } from "../../../shell/workspace-utils.js";

import type { Dispatch, SetStateAction } from 'react';
import type { SessionActionTooltip } from './types.js';
interface SidebarDragOptions { snapshot: WorkspaceSnapshot; groupMode: 'project' | 'merged'; sortMode: 'recent' | 'manual'; projectSessions: WorkspaceSession[]; pinnedProjects: Project[]; unpinnedProjects: Project[]; pinnedProjectIds: string[]; setPinnedProjectIds: Dispatch<SetStateAction<string[]>>; setManualSessionOrder: Dispatch<SetStateAction<string[]>>; setManualProjectOrder: Dispatch<SetStateAction<string[]>>; clearHoverCards: () => void; setSessionActionTooltip: (tooltip: SessionActionTooltip | null) => void; }


export function useSidebarDrag(options: SidebarDragOptions) {
  const { snapshot, groupMode, sortMode, projectSessions, pinnedProjects, unpinnedProjects, pinnedProjectIds, setPinnedProjectIds, setManualSessionOrder, setManualProjectOrder, clearHoverCards, setSessionActionTooltip } = options;
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dragTargetSessionId, setDragTargetSessionId] = useState<string | null>(null);
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [dragTargetProjectId, setDragTargetProjectId] = useState<string | null>(null);
  const draggedSessionRef = useRef<WorkspaceSession | null>(null);
  const sessionPointerDragRef = useRef<{ pointerId: number; startX: number; startY: number; started: boolean; targetId: string | null } | null>(null);
  const suppressNextSessionClickRef = useRef(false);
  const draggedProjectRef = useRef<Project | null>(null);
  const projectPointerDragRef = useRef<{ pointerId: number; startX: number; startY: number; started: boolean; targetId: string | null } | null>(null);
  const suppressNextProjectClickRef = useRef(false);
  const reorderSession = (target: WorkspaceSession, clientY: number): boolean => {
    const dragged = draggedSessionRef.current;
    if (!dragged || dragged.id === target.id || (groupMode === "project" && dragged.projectId !== target.projectId)) return false;
    const nextOrder = projectSessions.map((session) => session.id);
    const from = nextOrder.indexOf(dragged.id);
    if (from < 0 || !nextOrder.includes(target.id)) return false;
    const targetElement = [...document.querySelectorAll<HTMLElement>(`.session-row[data-session-id="${CSS.escape(target.id)}"]`)]
      .find((row) => row.closest(".project-group") || row.closest(".recent-content"));
    const targetRect = targetElement?.getBoundingClientRect();
    const targetIndexBeforeMove = nextOrder.indexOf(target.id);
    const targetPosition = targetRect ? (clientY - targetRect.top) / targetRect.height : 0;
    const insertAfterTarget = targetRect
      ? targetPosition <= 0.25 ? false : targetPosition >= 0.75 ? true : from < targetIndexBeforeMove
      : false;
    nextOrder.splice(from, 1);
    const targetIndex = nextOrder.indexOf(target.id);
    if (targetIndex < 0) return false;
    nextOrder.splice(targetIndex + (insertAfterTarget ? 1 : 0), 0, dragged.id);
    if (nextOrder.every((id, index) => id === projectSessions[index]?.id)) return false;
    setManualSessionOrder(nextOrder);
    try { window.localStorage.setItem(manualSessionOrderKey, JSON.stringify(nextOrder)); } catch { /* Keep the current in-memory order if storage is unavailable. */ }
    return true;
  };
  const beginSessionPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, session: WorkspaceSession) => {
    if (sortMode !== "manual" || event.button !== 0 || (event.target as HTMLElement).closest("button.session-action")) return;
    sessionPointerDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, started: false, targetId: session.id };
    draggedSessionRef.current = session;
  };
  const moveSessionPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sessionPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.started && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    if (!drag.started) {
      drag.started = true;
      clearHoverCards();
      setSessionActionTooltip(null);
      setDraggingSessionId(draggedSessionRef.current?.id ?? null);
    }
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".session-row[data-session-id]");
    const targetId = row?.dataset.sessionId ?? null;
    const target = snapshot.sessions.find((session) => session.id === targetId && !session.archivedAt);
    const dragged = draggedSessionRef.current;
    if (!target || !dragged || (groupMode === "project" && target.projectId !== dragged.projectId)) return;
    drag.targetId = target.id;
    setDragTargetSessionId(target.id);
  };
  const endSessionPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sessionPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6;
    const hitRow = moved ? document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".session-row[data-session-id]") : null;
    const targetId = hitRow?.dataset.sessionId ?? drag.targetId;
    if ((drag.started || moved) && targetId) {
      const target = snapshot.sessions.find((session) => session.id === targetId && !session.archivedAt);
      if (target && reorderSession(target, event.clientY)) {
        suppressNextSessionClickRef.current = true;
        window.setTimeout(() => { suppressNextSessionClickRef.current = false; }, 80);
      }
    }
    sessionPointerDragRef.current = null;
    draggedSessionRef.current = null;
    setDraggingSessionId(null);
    setDragTargetSessionId(null);
  };
  const captureSessionClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressNextSessionClickRef.current) return;
    suppressNextSessionClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const reorderProject = (target: Project, clientY: number): boolean => {
    const dragged = draggedProjectRef.current;
    if (!dragged || dragged.id === target.id) return false;
    const pinned = pinnedProjectIds.includes(dragged.id);
    if (pinned !== pinnedProjectIds.includes(target.id)) return false;
    const currentOrder = (pinned ? pinnedProjects : unpinnedProjects).map((project) => project.id);
    const from = currentOrder.indexOf(dragged.id);
    const targetIndexBeforeMove = currentOrder.indexOf(target.id);
    if (from < 0 || targetIndexBeforeMove < 0) return false;
    const targetElement = document.querySelector<HTMLElement>(`.project-row[data-project-id="${CSS.escape(target.id)}"]`);
    const targetRect = targetElement?.getBoundingClientRect();
    const targetPosition = targetRect ? (clientY - targetRect.top) / targetRect.height : 0;
    const insertAfterTarget = targetRect
      ? targetPosition <= 0.25 ? false : targetPosition >= 0.75 ? true : from < targetIndexBeforeMove
      : false;
    currentOrder.splice(from, 1);
    const targetIndex = currentOrder.indexOf(target.id);
    if (targetIndex < 0) return false;
    currentOrder.splice(targetIndex + (insertAfterTarget ? 1 : 0), 0, dragged.id);
    const originalOrder = (pinned ? pinnedProjects : unpinnedProjects).map((project) => project.id);
    if (currentOrder.every((id, index) => id === originalOrder[index])) return false;
    if (pinned) {
      setPinnedProjectIds(currentOrder);
      try { window.localStorage.setItem(pinnedProjectIdsKey, JSON.stringify(currentOrder)); } catch { /* Keep the in-memory order when storage is unavailable. */ }
    } else {
      setManualProjectOrder(currentOrder);
      try { window.localStorage.setItem(manualProjectOrderKey, JSON.stringify(currentOrder)); } catch { /* Keep the in-memory order when storage is unavailable. */ }
    }
    return true;
  };
  const beginProjectPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, project: Project) => {
    if (sortMode !== "manual" || event.button !== 0 || (event.target as HTMLElement).closest(".project-actions button")) return;
    projectPointerDragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, started: false, targetId: project.id };
    draggedProjectRef.current = project;
  };
  const moveProjectPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = projectPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.started && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    if (!drag.started) {
      drag.started = true;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* The row may have been detached while dragging. */ }
      clearHoverCards();
      setSessionActionTooltip(null);
      setDraggingProjectId(draggedProjectRef.current?.id ?? null);
    }
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".project-row[data-project-id]");
    const targetId = row?.dataset.projectId ?? null;
    const targetPinned = targetId ? pinnedProjectIds.includes(targetId) : false;
    if (!targetId || targetPinned !== pinnedProjectIds.includes(draggedProjectRef.current?.id ?? "")) {
      drag.targetId = null;
      setDragTargetProjectId(null);
      return;
    }
    drag.targetId = targetId;
    setDragTargetProjectId(targetId);
  };
  const finishProjectPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, cancel = false) => {
    const drag = projectPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6;
    const hitRow = moved ? document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".project-row[data-project-id]") : null;
    const targetId = hitRow?.dataset.projectId ?? drag.targetId;
    const wasDrag = drag.started || moved;
    if (!cancel && wasDrag && targetId) {
      const target = snapshot.projects.find((project) => project.id === targetId);
      if (target) reorderProject(target, event.clientY);
    }
    if (!cancel && wasDrag) {
      suppressNextProjectClickRef.current = true;
      window.setTimeout(() => { suppressNextProjectClickRef.current = false; }, 80);
    }
    projectPointerDragRef.current = null;
    draggedProjectRef.current = null;
    setDraggingProjectId(null);
    setDragTargetProjectId(null);
  };
  const endProjectPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => finishProjectPointerDrag(event);
  const cancelProjectPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => finishProjectPointerDrag(event, true);
  const captureProjectClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressNextProjectClickRef.current) return;
    suppressNextProjectClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };
  return { draggingSessionId, dragTargetSessionId, draggingProjectId, dragTargetProjectId, beginSessionPointerDrag, moveSessionPointerDrag, endSessionPointerDrag, captureSessionClick, beginProjectPointerDrag, moveProjectPointerDrag, endProjectPointerDrag, cancelProjectPointerDrag, captureProjectClick };
}
