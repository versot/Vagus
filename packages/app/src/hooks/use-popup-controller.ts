import type { Project, WorkspaceSession } from "@vagus/client";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { ActivePopup, ProjectHoverCardPosition, SessionActionTooltip, SessionHoverCardPosition } from "../features/sessions/sidebar/types.js";
import { contextMenuPosition } from "../shell/workspace-utils.js";

const POPUP_EXIT_MS = 140;
const HOVER_CARD_EXIT_MS = 120;
const POPUP_SWITCH_MS = 150;
const sessionContextMenuHeight = () => window.innerHeight <= 460 ? 310 : 370;

type UsePopupControllerOptions = {
  projects: Project[];
  sessions: WorkspaceSession[];
  sidebarRef: RefObject<HTMLElement | null>;
  resizing: RefObject<boolean>;
};

export function usePopupController({ projects, sessions, sidebarRef, resizing }: UsePopupControllerOptions) {
  const [activePopup, setActivePopupState] = useState<ActivePopup | null>(null);
  const [popupSwitching, setPopupSwitching] = useState(false);
  const [popupOpenVersion, setPopupOpenVersion] = useState(0);
  const [popupEnteringVersion, setPopupEnteringVersion] = useState(-1);
  const [sessionHoverCard, setSessionHoverCard] = useState<SessionHoverCardPosition | null>(null);
  const [sessionHoverCardClosing, setSessionHoverCardClosing] = useState(false);
  const [sessionActionTooltip, setSessionActionTooltip] = useState<SessionActionTooltip | null>(null);
  const [projectHoverCard, setProjectHoverCard] = useState<ProjectHoverCardPosition | null>(null);
  const [projectHoverCardClosing, setProjectHoverCardClosing] = useState(false);

  const popupCloseTimer = useRef<number | undefined>(undefined);
  const popupId = useRef(0);
  const activePopupRef = useRef<ActivePopup | null>(null);
  const hoverCloseTimer = useRef<number | undefined>(undefined);
  const sessionHoverCardCloseTimer = useRef<number | undefined>(undefined);
  const projectHoverCardCloseTimer = useRef<number | undefined>(undefined);
  const popupSwitchTimer = useRef<number | undefined>(undefined);
  const popupHandoffFrame = useRef<number | undefined>(undefined);
  const popupEnterFrame = useRef<number | undefined>(undefined);
  const popupTransitioning = useRef(false);
  const lastPointerPosition = useRef({ x: 0, y: 0 });

  const setActivePopup = (next: ActivePopup | null) => {
    activePopupRef.current = next;
    setActivePopupState(next);
  };
  const projectMenu = activePopup?.kind === "project" ? activePopup : null;
  const sessionMenu = activePopup?.kind === "session" ? activePopup : null;
  const menuOpen = activePopup?.kind === "sidebar";
  const menuClosing = Boolean(activePopup?.kind === "sidebar" && activePopup.closing);
  const projectMenuClosing = Boolean(projectMenu?.closing);
  const sessionMenuClosing = Boolean(sessionMenu?.closing);
  const menuSource = activePopup?.kind === "sidebar" ? activePopup.source : "other";
  const menuTop = activePopup?.kind === "sidebar" ? activePopup.top : 146;
  const menuLeft = activePopup?.kind === "sidebar" ? activePopup.left : 0;

  const startPopupEntrance = () => {
    if (popupEnterFrame.current !== undefined) window.cancelAnimationFrame(popupEnterFrame.current);
    const nextVersion = popupOpenVersion + 1;
    setPopupOpenVersion(nextVersion);
    setPopupEnteringVersion(nextVersion);
    popupEnterFrame.current = window.requestAnimationFrame(() => {
      popupEnterFrame.current = window.requestAnimationFrame(() => {
        popupEnterFrame.current = undefined;
        setPopupEnteringVersion(-1);
      });
    });
  };

  const showSessionHoverCard = (session: WorkspaceSession, row: HTMLDivElement) => {
    if (resizing.current || popupTransitioning.current) return;
    if (hoverCloseTimer.current !== undefined) window.clearTimeout(hoverCloseTimer.current);
    if (sessionHoverCardCloseTimer.current !== undefined) window.clearTimeout(sessionHoverCardCloseTimer.current);
    setSessionHoverCardClosing(false);
    if (!row.isConnected) return;
    const rect = row.getBoundingClientRect();
    const cardWidth = Math.min(300, window.innerWidth - 24);
    const sidebar = sidebarRef.current ?? row.closest<HTMLElement>(".sidebar");
    const sidebarRect = sidebar?.getBoundingClientRect();
    const mainPane = sidebar?.parentElement?.querySelector<HTMLElement>(":scope > .main-pane:not(.is-background-view)");
    const anchorRight = mainPane?.getBoundingClientRect().left ?? sidebarRect?.right ?? rect.right;
    const anchorLeft = sidebarRect?.left ?? rect.left;
    const left = window.innerWidth - anchorRight >= cardWidth ? anchorRight - 1 : Math.max(8, anchorLeft - cardWidth + 1);
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 94));
    setProjectHoverCard(null);
    setSessionHoverCard({ sessionId: session.id, left, top });
  };

  const showProjectHoverCard = (project: Project, row: HTMLDivElement) => {
    if (resizing.current || popupTransitioning.current) return;
    if (hoverCloseTimer.current !== undefined) window.clearTimeout(hoverCloseTimer.current);
    if (projectHoverCardCloseTimer.current !== undefined) window.clearTimeout(projectHoverCardCloseTimer.current);
    projectHoverCardCloseTimer.current = undefined;
    setProjectHoverCardClosing(false);
    setSessionHoverCardClosing(false);
    if (!row.isConnected) return;
    const rect = row.getBoundingClientRect();
    const cardWidth = Math.min(340, window.innerWidth - 24);
    const sidebar = sidebarRef.current ?? row.closest<HTMLElement>(".sidebar");
    const sidebarRect = sidebar?.getBoundingClientRect();
    const mainPane = sidebar?.parentElement?.querySelector<HTMLElement>(":scope > .main-pane:not(.is-background-view)");
    const anchorRight = mainPane?.getBoundingClientRect().left ?? sidebarRect?.right ?? rect.right;
    const anchorLeft = sidebarRect?.left ?? rect.left;
    const left = window.innerWidth - anchorRight >= cardWidth ? anchorRight - 1 : Math.max(8, anchorLeft - cardWidth + 1);
    const folderCount = new Set(project.roots?.length ? project.roots : [project.root]).size;
    const cardHeight = 140 + folderCount * 38;
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - cardHeight - 8));
    setSessionHoverCard(null);
    setProjectHoverCard({ projectId: project.id, left, top });
  };

  const fadeProjectHoverCard = () => {
    if (projectHoverCardCloseTimer.current !== undefined) window.clearTimeout(projectHoverCardCloseTimer.current);
    if (!projectHoverCard) { setProjectHoverCard(null); setProjectHoverCardClosing(false); return; }
    setProjectHoverCardClosing(true);
    projectHoverCardCloseTimer.current = window.setTimeout(() => {
      setProjectHoverCard(null);
      setProjectHoverCardClosing(false);
      projectHoverCardCloseTimer.current = undefined;
    }, HOVER_CARD_EXIT_MS);
  };

  const fadeSessionHoverCard = () => {
    if (hoverCloseTimer.current !== undefined) window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = undefined;
    if (sessionHoverCardCloseTimer.current !== undefined) window.clearTimeout(sessionHoverCardCloseTimer.current);
    if (!sessionHoverCard) { setSessionHoverCard(null); setSessionHoverCardClosing(false); return; }
    setSessionHoverCardClosing(true);
    sessionHoverCardCloseTimer.current = window.setTimeout(() => {
      setSessionHoverCard(null);
      setSessionHoverCardClosing(false);
      sessionHoverCardCloseTimer.current = undefined;
    }, HOVER_CARD_EXIT_MS);
  };

  const closePopup = (kind?: ActivePopup["kind"]) => {
    const current = activePopupRef.current;
    if (!current || (kind && current.kind !== kind)) return;
    if (popupCloseTimer.current !== undefined) window.clearTimeout(popupCloseTimer.current);
    setActivePopup({ ...current, closing: true });
    popupCloseTimer.current = window.setTimeout(() => {
      popupCloseTimer.current = undefined;
      if (activePopupRef.current?.id !== current.id) return;
      setActivePopup(null);
      if (popupTransitioning.current || current.kind === "sidebar") return;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (popupTransitioning.current) return;
        const { x, y } = lastPointerPosition.current;
        if (current.kind === "project") {
          const row = document.elementFromPoint(x, y)?.closest<HTMLDivElement>(".project-row");
          const project = row?.dataset.projectId ? projects.find((item) => item.id === row.dataset.projectId) : undefined;
          if (project && row?.isConnected) showProjectHoverCard(project, row);
        } else if (current.kind === "session") {
          const row = document.elementFromPoint(x, y)?.closest<HTMLDivElement>(".session-row");
          const session = row?.dataset.sessionId ? sessions.find((item) => item.id === row.dataset.sessionId) : undefined;
          if (session && row?.isConnected) showSessionHoverCard(session, row);
        }
      }));
    }, POPUP_EXIT_MS);
  };

  const closeProjectMenu = () => closePopup("project");
  const closeSessionMenu = () => closePopup("session");
  const closeSidebarMenu = () => closePopup("sidebar");

  const openProjectMenuAt = (next: { projectId: string; left: number; top: number }) => {
    if (popupCloseTimer.current !== undefined) window.clearTimeout(popupCloseTimer.current);
    popupCloseTimer.current = undefined;
    startPopupEntrance();
    setActivePopup({ kind: "project", ...next, id: ++popupId.current });
  };

  const openSessionMenuAt = (next: { sessionId: string; left: number; top: number }) => {
    if (popupCloseTimer.current !== undefined) window.clearTimeout(popupCloseTimer.current);
    popupCloseTimer.current = undefined;
    startPopupEntrance();
    setActivePopup({ kind: "session", ...next, id: ++popupId.current });
  };

  const openSidebarMenu = (source: "projects" | "recent" | "project-row" | "other" = "other", left = menuLeft, top = menuTop) => {
    if (popupCloseTimer.current !== undefined) window.clearTimeout(popupCloseTimer.current);
    popupCloseTimer.current = undefined;
    startPopupEntrance();
    setActivePopup({ kind: "sidebar", source, left, top, id: ++popupId.current });
  };

  const transitionToPopup = (open: () => void, destination: "sidebar" | "portal" = "portal") => {
    const hasSidebarMenu = activePopup?.kind === "sidebar";
    const hasPortalMenu = activePopup?.kind === "project" || activePopup?.kind === "session";
    const hasMenu = Boolean(activePopup);
    const hasHoverCard = Boolean(projectHoverCard || sessionHoverCard || projectHoverCardClosing || sessionHoverCardClosing);
    const hasPendingSwitch = popupSwitchTimer.current !== undefined || popupHandoffFrame.current !== undefined;
    const shouldWait = hasMenu || hasHoverCard || hasPendingSwitch;
    const crossContainerHandoff = destination === "sidebar" ? hasPortalMenu : hasSidebarMenu;
    const menuExitDelay = hasMenu ? POPUP_EXIT_MS : 0;
    const switchDelay = Math.max(menuExitDelay, hasHoverCard ? HOVER_CARD_EXIT_MS : 0, hasPendingSwitch ? POPUP_SWITCH_MS : 0);
    if (popupSwitchTimer.current !== undefined) window.clearTimeout(popupSwitchTimer.current);
    popupSwitchTimer.current = undefined;
    if (popupHandoffFrame.current !== undefined) window.cancelAnimationFrame(popupHandoffFrame.current);
    popupHandoffFrame.current = undefined;
    popupTransitioning.current = shouldWait;
    setPopupSwitching(shouldWait);
    if (activePopup) closePopup();
    if (projectHoverCard || projectHoverCardClosing) fadeProjectHoverCard();
    if (sessionHoverCard || sessionHoverCardClosing) fadeSessionHoverCard();
    if (!shouldWait) { open(); return; }
    const finishSwitch = () => {
      popupHandoffFrame.current = undefined;
      popupTransitioning.current = false;
      setPopupSwitching(false);
      open();
    };
    popupSwitchTimer.current = window.setTimeout(() => {
      popupSwitchTimer.current = undefined;
      if (!crossContainerHandoff) { finishSwitch(); return; }
      popupHandoffFrame.current = window.requestAnimationFrame(() => {
        popupHandoffFrame.current = window.requestAnimationFrame(finishSwitch);
      });
    }, switchDelay);
  };

  const cancelPopupTransition = () => {
    if (popupSwitchTimer.current !== undefined) window.clearTimeout(popupSwitchTimer.current);
    popupSwitchTimer.current = undefined;
    if (popupHandoffFrame.current !== undefined) window.cancelAnimationFrame(popupHandoffFrame.current);
    popupHandoffFrame.current = undefined;
    popupTransitioning.current = false;
    setPopupSwitching(false);
  };

  const toggleSessionMenuAt = (session: WorkspaceSession, left: number, top: number) => {
    if (sessionMenu?.sessionId === session.id && !sessionMenuClosing) {
      cancelPopupTransition();
      closeSessionMenu();
      return;
    }
    transitionToPopup(() => openSessionMenuAt({ sessionId: session.id, left, top }));
  };

  const requestSessionMenu = (session: WorkspaceSession, clientX: number, clientY: number) => {
    lastPointerPosition.current = { x: clientX, y: clientY };
    const { left, top } = contextMenuPosition(clientX, clientY, 224, sessionContextMenuHeight());
    toggleSessionMenuAt(session, left, top);
  };

  const openSessionContextMenu = (event: ReactMouseEvent<HTMLElement>, session: WorkspaceSession) => {
    event.preventDefault();
    event.stopPropagation();
    requestSessionMenu(session, event.clientX, event.clientY);
  };

  const openSessionMenuFromHeader = (event: ReactMouseEvent<HTMLElement>, session: WorkspaceSession) => {
    event.preventDefault();
    event.stopPropagation();
    lastPointerPosition.current = { x: event.clientX, y: event.clientY };
    if (sessionMenu?.sessionId === session.id && !sessionMenuClosing) {
      cancelPopupTransition();
      closeSessionMenu();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 238;
    const menuHeight = sessionContextMenuHeight();
    const left = Math.max(8, window.innerWidth - menuWidth - 8);
    const top = rect.bottom + menuHeight + 8 <= window.innerHeight
      ? rect.bottom + 6
      : Math.max(8, rect.top - menuHeight - 6);
    cancelPopupTransition();
    closePopup();
    clearHoverCards();
    openSessionMenuAt({ sessionId: session.id, left, top });
  };

  const requestProjectMenu = (project: Project, left: number, top: number) => {
    if (projectMenu?.projectId === project.id && !projectMenuClosing) {
      cancelPopupTransition();
      closeProjectMenu();
      return;
    }
    transitionToPopup(() => openProjectMenuAt({ projectId: project.id, left, top }));
  };

  const openProjectMenu = (event: ReactMouseEvent<HTMLButtonElement>, project: Project) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 238;
    const height = 180;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left - 12));
    const top = rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - height - 6);
    lastPointerPosition.current = { x: event.clientX, y: event.clientY };
    requestProjectMenu(project, left, top);
  };

  const openProjectContextMenu = (event: ReactMouseEvent<HTMLDivElement>, project: Project) => {
    event.preventDefault();
    event.stopPropagation();
    lastPointerPosition.current = { x: event.clientX, y: event.clientY };
    const { left, top } = contextMenuPosition(event.clientX, event.clientY, 238, 228);
    requestProjectMenu(project, left, top);
  };

  const toggleSidebarMenu = (event: ReactMouseEvent<HTMLButtonElement>, source: "projects" | "recent" | "project-row" | "other" = "other") => {
    const sidebar = sidebarRef.current;
    let left = menuLeft;
    let top = menuTop;
    if (sidebar) {
      const sidebarRect = sidebar.getBoundingClientRect();
      const triggerRect = event.currentTarget.getBoundingClientRect();
      const belowTop = triggerRect.bottom - sidebarRect.top + 6;
      const menuHeight = 88;
      top = belowTop + menuHeight <= sidebar.clientHeight ? belowTop : Math.max(8, triggerRect.top - sidebarRect.top - menuHeight - 6);
      left = Math.max(8, triggerRect.left - sidebarRect.left - 2);
    }
    if (menuOpen && menuSource === source && !menuClosing) {
      cancelPopupTransition();
      closeSidebarMenu();
      return;
    }
    transitionToPopup(() => openSidebarMenu(source, left, top), "sidebar");
  };

  const requestSidebarSectionMenu = (clientX: number, clientY: number, source: "projects" | "recent") => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    if (menuOpen && menuSource === source && !menuClosing) {
      cancelPopupTransition();
      closeSidebarMenu();
      return;
    }
    const sidebarRect = sidebar.getBoundingClientRect();
    const menuWidth = 260;
    const menuHeight = 88;
    const left = Math.max(8, Math.min(clientX - sidebarRect.left + 6, sidebar.clientWidth - menuWidth - 8));
    const belowTop = clientY - sidebarRect.top + 6;
    const top = belowTop + menuHeight <= sidebar.clientHeight ? belowTop : Math.max(8, clientY - sidebarRect.top - menuHeight - 6);
    transitionToPopup(() => openSidebarMenu(source, left, top), "sidebar");
  };

  const openSidebarSectionContextMenu = (event: ReactMouseEvent<HTMLElement>, source: "projects" | "recent") => {
    event.preventDefault();
    lastPointerPosition.current = { x: event.clientX, y: event.clientY };
    requestSidebarSectionMenu(event.clientX, event.clientY, source);
  };

  const handlePopupDismissContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const { clientX, clientY } = event;
    lastPointerPosition.current = { x: clientX, y: clientY };
    const dismissLayers = Array.from(document.querySelectorAll<HTMLElement>(".menu-dismiss, .project-menu-dismiss"));
    const previousPointerEvents = dismissLayers.map((layer) => layer.style.pointerEvents);
    dismissLayers.forEach((layer) => { layer.style.pointerEvents = "none"; });
    const underlying = document.elementFromPoint(clientX, clientY);
    dismissLayers.forEach((layer, index) => { layer.style.pointerEvents = previousPointerEvents[index] ?? ""; });

    const sessionRow = underlying?.closest<HTMLElement>(".session-row");
    const session = sessionRow?.dataset.sessionId ? sessions.find((item) => item.id === sessionRow.dataset.sessionId) : undefined;
    if (session) { requestSessionMenu(session, clientX, clientY); return; }

    const projectRow = underlying?.closest<HTMLElement>(".project-row");
    const project = projectRow?.dataset.projectId ? projects.find((item) => item.id === projectRow.dataset.projectId) : undefined;
    if (project) {
      const position = contextMenuPosition(clientX, clientY, 238, 228);
      requestProjectMenu(project, position.left, position.top);
      return;
    }

    const sectionHeading = underlying?.closest<HTMLElement>(".projects-heading, .recent-heading");
    if (sectionHeading) {
      requestSidebarSectionMenu(clientX, clientY, sectionHeading.classList.contains("projects-heading") ? "projects" : "recent");
      return;
    }

    cancelPopupTransition();
    closeProjectMenu();
    closeSessionMenu();
    closeSidebarMenu();
  };

  const closeSessionHoverCardSoon = () => {
    if (hoverCloseTimer.current !== undefined) window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = undefined;
    if (sessionHoverCardCloseTimer.current !== undefined) window.clearTimeout(sessionHoverCardCloseTimer.current);
    if (projectHoverCardCloseTimer.current !== undefined) window.clearTimeout(projectHoverCardCloseTimer.current);
    sessionHoverCardCloseTimer.current = undefined;
    projectHoverCardCloseTimer.current = undefined;
    const closeAfterHandoff = () => window.requestAnimationFrame(() => {
      const { x, y } = lastPointerPosition.current;
      const target = document.elementFromPoint(x, y);
      if (target?.closest(".session-row, .project-row, .session-hover-card, .project-hover-card")) return;
      setSessionHoverCard(null);
      setSessionHoverCardClosing(false);
      setProjectHoverCard(null);
      setProjectHoverCardClosing(false);
    });
    // Leaving a sidebar row is often the start of moving into its floating card.
    // Give that short handoff time to cross the splitter; leaving the card itself
    // uses the immediate handler below.
    if (sessionHoverCard) {
      sessionHoverCardCloseTimer.current = window.setTimeout(() => {
        sessionHoverCardCloseTimer.current = undefined;
        closeAfterHandoff();
      }, 180);
    } else if (projectHoverCard) {
      projectHoverCardCloseTimer.current = window.setTimeout(() => {
        projectHoverCardCloseTimer.current = undefined;
        closeAfterHandoff();
      }, 180);
    } else {
      closeAfterHandoff();
    }
  };

  const closeSessionHoverCardImmediately = () => {
    if (hoverCloseTimer.current !== undefined) window.clearTimeout(hoverCloseTimer.current);
    if (sessionHoverCardCloseTimer.current !== undefined) window.clearTimeout(sessionHoverCardCloseTimer.current);
    if (projectHoverCardCloseTimer.current !== undefined) window.clearTimeout(projectHoverCardCloseTimer.current);
    hoverCloseTimer.current = undefined;
    sessionHoverCardCloseTimer.current = undefined;
    projectHoverCardCloseTimer.current = undefined;
    setSessionHoverCard(null);
    setSessionHoverCardClosing(false);
    setProjectHoverCard(null);
    setProjectHoverCardClosing(false);
  };

  const keepSessionHoverCardOpen = () => {
    if (hoverCloseTimer.current !== undefined) window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = undefined;
    if (sessionHoverCardCloseTimer.current !== undefined) window.clearTimeout(sessionHoverCardCloseTimer.current);
    sessionHoverCardCloseTimer.current = undefined;
    setSessionHoverCardClosing(false);
    if (projectHoverCardCloseTimer.current !== undefined) window.clearTimeout(projectHoverCardCloseTimer.current);
    projectHoverCardCloseTimer.current = undefined;
    setProjectHoverCardClosing(false);
  };

  const showSessionActionTooltip = (event: ReactMouseEvent<HTMLElement>, label: string, shortcut?: string, preferredPlacement?: "above" | "below" | "right") => {
    if (resizing.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const placement = preferredPlacement ?? (rect.top >= 48 ? "above" : "below");
    const width = Math.max(94, label.length * 14 + (shortcut ? shortcut.length * 7 + 22 : 0) + 26);
    const left = placement === "right" ? rect.right + 7 : Math.max(width / 2 + 8, Math.min(window.innerWidth - width / 2 - 8, rect.left + rect.width / 2));
    const top = placement === "above" ? rect.top - 7 : placement === "below" ? rect.bottom + 7 : rect.top + rect.height / 2;
    setSessionActionTooltip({ label, shortcut, left, top, placement });
  };

  const clearHoverCards = () => {
    if (hoverCloseTimer.current !== undefined) window.clearTimeout(hoverCloseTimer.current);
    if (sessionHoverCardCloseTimer.current !== undefined) window.clearTimeout(sessionHoverCardCloseTimer.current);
    if (projectHoverCardCloseTimer.current !== undefined) window.clearTimeout(projectHoverCardCloseTimer.current);
    hoverCloseTimer.current = undefined;
    sessionHoverCardCloseTimer.current = undefined;
    projectHoverCardCloseTimer.current = undefined;
    setSessionHoverCard(null);
    setSessionHoverCardClosing(false);
    setProjectHoverCard(null);
    setProjectHoverCardClosing(false);
  };

  useEffect(() => () => {
    if (popupCloseTimer.current !== undefined) window.clearTimeout(popupCloseTimer.current);
    if (hoverCloseTimer.current !== undefined) window.clearTimeout(hoverCloseTimer.current);
    if (sessionHoverCardCloseTimer.current !== undefined) window.clearTimeout(sessionHoverCardCloseTimer.current);
    if (projectHoverCardCloseTimer.current !== undefined) window.clearTimeout(projectHoverCardCloseTimer.current);
    if (popupSwitchTimer.current !== undefined) window.clearTimeout(popupSwitchTimer.current);
    if (popupHandoffFrame.current !== undefined) window.cancelAnimationFrame(popupHandoffFrame.current);
    if (popupEnterFrame.current !== undefined) window.cancelAnimationFrame(popupEnterFrame.current);
  }, []);

  useEffect(() => {
    const trackPointer = (event: PointerEvent) => { lastPointerPosition.current = { x: event.clientX, y: event.clientY }; };
    window.addEventListener("pointermove", trackPointer);
    return () => window.removeEventListener("pointermove", trackPointer);
  }, []);

  return {
    activePopup, projectMenu, sessionMenu, menuOpen, menuClosing, projectMenuClosing, sessionMenuClosing, menuSource, menuTop, menuLeft,
    popupSwitching, popupOpenVersion, popupEnteringVersion, sessionHoverCard, sessionHoverCardClosing, sessionActionTooltip, projectHoverCard, projectHoverCardClosing,
    setSessionActionTooltip, closeProjectMenu, closeSessionMenu, closeSidebarMenu, transitionToPopup, cancelPopupTransition, fadeProjectHoverCard, fadeSessionHoverCard,
    requestSessionMenu, openSessionContextMenu, openSessionMenuFromHeader, openProjectMenu, openProjectContextMenu, toggleSidebarMenu, openSidebarSectionContextMenu,
    handlePopupDismissContextMenu, handleSidebarMenuContextMenu: handlePopupDismissContextMenu, openSidebarMenu,
    showSessionHoverCard, showProjectHoverCard, closeSessionHoverCardSoon, closeSessionHoverCardImmediately, keepSessionHoverCardOpen, showSessionActionTooltip, clearHoverCards,
  };
}
