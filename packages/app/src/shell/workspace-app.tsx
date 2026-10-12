import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { type Project, type ScheduledTask, type WorkspaceSession, type WorkspaceSnapshot } from "@vagus/client";
import { applySessionUiEvent, type AgentCommandInfo, type AgentEvent, type BrowserElementReference, type MessageAttachment, type SessionTimelineEntry } from "@vagus/protocol";
import { AlertCircle, Archive, ArrowDown, ArrowLeft, ArrowRight, CalendarClock, Check, CheckCircle2, ChevronDown, ChevronRight, Clock3, Copy, Ellipsis, FileText, Folder, FolderOpen, FolderPlus, GitBranch, Home, Import, Keyboard, Laptop, LoaderCircle, Mail, MailOpen, MessageSquare, Minus, PanelLeftClose, PanelLeftOpen, Pause, Pencil, Pin, PinOff, Play, Plus, Search, Send, Settings, Settings2, Square, SquarePen, Target, Trash2, X } from "lucide-react";
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type AnimationEvent as ReactAnimationEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Trans, useTranslation } from "react-i18next";
import { ClaudeIcon } from "../components/icons/claude-icon.js";
import { CodexIcon } from "../components/icons/codex-icon.js";
import { OpenCodeIcon } from "../components/icons/opencode-icon.js";
import { PiIcon } from "../components/icons/pi-icon.js";
import { QoderIcon } from "../components/icons/qoder-icon.js";
import { ZCodeIcon } from "../components/icons/zcode-icon.js";
import { readMessageAttachment } from "../features/conversation/attachments.js";
import { BrowserElementChip } from "../features/conversation/components/browser-element-chip.js";
import { PlanActivityLine, SubagentActivityLine, ThinkingMarker, ToolActivityLine, TurnChangesCard, TurnDiffActivityLine } from "../features/conversation/components/conversation-activity.js";
import { ConversationViewActions } from "../features/conversation/components/conversation-view-actions.js";
import { ExtensionNoticeToast } from "../features/conversation/components/extension-notice-toast.js";
import { ExtensionDraftBar, ExtensionStatusRail, ExtensionWidgets } from "../features/conversation/components/extension-surfaces.js";
import { InteractionCard } from "../features/conversation/components/interaction-card.js";
import { MessageContent } from "../features/conversation/components/message-content.js";
import { MessageNavigation } from "../features/conversation/components/message-navigation.js";
import { SessionUsageControl } from "../features/conversation/components/session-usage-control.js";
import { VirtualConversation, type VirtualConversationHandle } from "../features/conversation/components/virtual-conversation.js";
import { applyToolStarted } from "../features/conversation/conversation-events.js";
import { isConversationActivity, isVisibleChatMessage } from "../features/conversation/conversation-presentation.js";
import { ConversationProjection, type ConversationEntry } from "../features/conversation/conversation-projection.js";
import { timelineToMarkdown } from "../features/conversation/export-markdown.js";
import { formatMessageTime, formatTurnDuration } from "../features/conversation/format.js";
import { HistoryCache, recentWindow, type HistoryWindow } from "../features/conversation/history/history-cache.js";
import { hydrateConversation, mergeHistoryItems } from "../features/conversation/history/hydrate-conversation.js";
import { useConversationReadiness } from "../features/conversation/hooks/use-conversation-readiness.js";
import { useExtensionDraft } from "../features/conversation/hooks/use-extension-draft.js";
import { useMessagePreviews } from "../features/conversation/hooks/use-message-previews.js";
import { useTurnDisclosure } from "../features/conversation/hooks/use-turn-disclosure.js";
import type { ChatInteraction, ChatMessage, ChatNotice, ChatPlan, ChatStatus, ChatTurnDiff, ToolActivity } from "../features/conversation/types.js";
import { animateWorkspacePicker } from "../features/projects/picker/workspace-picker-motion.js";
import { WorkspacePicker } from "../features/projects/picker/workspace-picker.js";
import type { ProjectArchiveNotice } from "../features/projects/types.js";
import { providerHealthFromCatalog } from "../features/providers/catalog-health.js";
import { DraftSessionControls, type DraftSessionSelection } from "../features/providers/draft-session-controls.js";
import { getLastCreatedProviderId, getProviderSessionPreference, rememberLastCreatedProvider, saveProviderSessionPreference } from "../features/providers/provider-session-preferences.js";
import { AgentModeControl, AgentSessionControls } from "../features/providers/session-controls.js";
import { ScheduledTasksPage } from "../features/scheduled-tasks/scheduled-tasks-page.js";
import { useSessionSearch } from "../features/sessions/hooks/use-session-search.js";
import { SessionImportPage } from "../features/sessions/import/session-import-page.js";
import { lastUserMessageAt, summaryOnly, uniqueSessions } from "../features/sessions/session-summary.js";
import { formatSessionUpdatedAt } from "../features/sessions/sidebar/format-time.js";
import { SessionHoverCardTitle } from "../features/sessions/sidebar/session-hover-card-title.js";
import { useSidebarDrag } from "../features/sessions/sidebar/use-sidebar-drag.js";
import { WorkspaceSidebar } from "../features/sessions/sidebar/workspace-sidebar.js";
import { matchesShortcut, shortcutLabel, useKeyboardShortcuts } from "../features/settings/keyboard-shortcuts.js";
import { ArchiveSettingsApp, type SettingsPage } from "../features/settings/settings-app.js";
import { usePopupController } from "../hooks/use-popup-controller.js";
import { writeClipboardText } from "../lib/clipboard.js";
import { host } from "../lib/workspace-host.js";
import i18n from "../locales/i18n.js";
import type { WorkspaceTabContext, WorkspaceTabId } from "../workspace-tabs/registry.js";
import { useWorkspacePanelSize } from "../workspace-tabs/use-workspace-panel-size.js";
import { useWorkspaceViews } from "../workspace-tabs/use-workspace-views.js";
import { WorkspaceTabHost } from "../workspace-tabs/workspace-tab-host.js";
import { WorkspacePanelResizer, WorkspaceViewBar } from "../workspace-tabs/workspace-views.js";
import type { NavigationLocation } from "./navigation-types.js";
import { notifySessionTask, notifyTask } from "./notifications.js";
import { useTopMenus } from "./use-top-menus.js";
import { clearLastConversationProjectId, hasUnreadAssistantReply, pinnedProjectIdsKey, pinnedSessionIdsKey, readLastConversationProjectId, readManualProjectOrder, readManualSessionOrder, readPinnedProjectIds, readPinnedSessionIds, readSessionViewedAt, saveLastConversationProjectId, sessionViewedAtKey, truncateSessionTitle } from "./workspace-utils.js";



declare global { interface Window { __TAURI_INTERNALS__?: unknown } }
const TIMELINE_BOTTOM_THRESHOLD = 2;
const COMMAND_SOURCE_ORDER: Record<AgentCommandInfo["source"], number> = { skill: 0, extension: 1, prompt: 2, builtin: 3, other: 4 };

export function WorkspaceApp() {
  useTranslation();
  const shortcuts = useKeyboardShortcuts();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>({ projects: [], sessions: [], providers: [] });
  useEffect(() => {
    const newestFirst = [...snapshot.sessions]
      .filter((session) => !session.scheduledTaskId && session.providerId && session.runtimeSettings)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const seeded = new Set<string>();
    for (const session of newestFirst) {
      const providerId = session.providerId!;
      if (seeded.has(providerId)) continue;
      seeded.add(providerId);
      const saved = getProviderSessionPreference(providerId);
      const settings = session.runtimeSettings!;
      const missing: { modelId?: string | null; thinkingLevel?: string | null; modeId?: string | null } = {};
      if (saved.modelId === undefined && settings.modelId) missing.modelId = settings.modelId;
      if (saved.thinkingLevel === undefined && settings.thinkingLevel !== undefined) missing.thinkingLevel = settings.thinkingLevel;
      if (saved.modeId === undefined && settings.currentModeId) missing.modeId = settings.currentModeId;
      if (Object.keys(missing).length) saveProviderSessionPreference(providerId, missing);
    }
  }, [snapshot.sessions]);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const previousSessionStatesRef = useRef(new Map<string, WorkspaceSession["state"]>());
  const pendingTaskNoticesRef = useRef(new Map<string, { title: string; body: string }>());
  const taskNoticeTimersRef = useRef(new Map<string, number>());
  useEffect(() => {
    for (const session of snapshot.sessions) {
      if (!previousSessionStatesRef.current.has(session.id)) previousSessionStatesRef.current.set(session.id, session.state);
    }
  }, [snapshot.sessions]);
  const liveCustomWidgetKeysRef = useRef(new Map<string, Set<string>>());
  const [customUiActivation, setCustomUiActivation] = useState<{ sessionId: string; key: string } | null>(null);
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now());
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [draftSessionSelection, setDraftSessionSelection] = useState<DraftSessionSelection | null>(null);
  const [hostCapabilities, setHostCapabilities] = useState<{ sessionModelSelection: boolean; sessionUsage: boolean; sessionQueue: boolean; sessionContext: boolean; sessionCommands: boolean }>({ sessionModelSelection: false, sessionUsage: false, sessionQueue: false, sessionContext: false, sessionCommands: false });
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [hydratedSessionId, setHydratedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyQueries, setHistoryQueries] = useState<ChatMessage[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyCursorRef = useRef<{ sessionId: string; beforeSequence: number | null; hasMore: boolean } | null>(null);
  const deferredContentRequestsRef = useRef(new Map<string, Promise<void>>());
  const olderHistoryRequestRef = useRef<Promise<void> | null>(null);
  const initialHistoryLoadRef = useRef<{ sessionId: string; events: AgentEvent[] } | null>(null);
  const agentEventHandlerRef = useRef<(event: AgentEvent) => void>(() => undefined);
  const pendingHistoryAnchorRef = useRef<{ key: string; top: number; scrollHeight: number; scrollTop: number } | null>(null);
  const pendingQueryJumpRef = useRef<string | null>(null);
  const { localMessagePreviews, updateMessagePreviews } = useMessagePreviews();
  const [activities, setActivities] = useState<ToolActivity[]>([]);
  const [statuses, setStatuses] = useState<ChatStatus[]>([]);
  const [interactions, setInteractions] = useState<ChatInteraction[]>([]);
  const [notices, setNotices] = useState<ChatNotice[]>([]);
  const [plans, setPlans] = useState<ChatPlan[]>([]);
  const [turnDiffs, setTurnDiffs] = useState<ChatTurnDiff[]>([]);
  const historyCacheRef = useRef(new HistoryCache());
  const historyOwnerRef = useRef<string | null>(null);
  const latestHistoryRef = useRef<HistoryWindow | null>(null);
  if (selectedSessionId && historyOwnerRef.current === selectedSessionId) {
    const cursor = historyCursorRef.current;
    latestHistoryRef.current = { sessionId: selectedSessionId, messages, activities, statuses, interactions, notices, plans, turnDiffs, queries: historyQueries, beforeSequence: cursor?.beforeSequence ?? null, hasMore: cursor?.hasMore ?? false };
  }
  const [showNewActivity, setShowNewActivity] = useState(false);
  const [activeQueryMessageId, setActiveQueryMessageId] = useState<string | null>(null);
  const timelineOrderRef = useRef(0);
  const followTimelineRef = useRef(true);
  const [composerAttachments, setComposerAttachments] = useState<MessageAttachment[]>([]);
  const [composerBrowserElements, setComposerBrowserElements] = useState<BrowserElementReference[]>([]);
  const [busy, setBusy] = useState(false);
  const [compactingSessionIds, setCompactingSessionIds] = useState<Set<string>>(() => new Set());
  const [queuedDeliveryMode, setQueuedDeliveryMode] = useState<"follow-up" | "steer">("follow-up");
  const [queueDeliveryMenuOpen, setQueueDeliveryMenuOpen] = useState(false);
  const queueDeliveryControlRef = useRef<HTMLDivElement>(null);
  const [slashCommands, setSlashCommands] = useState<AgentCommandInfo[]>([]);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashCommandIndex, setSlashCommandIndex] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashMenuId = useId();
  const commandCacheRef = useRef(new Map<string, AgentCommandInfo[]>());
  const commandRequestRef = useRef(new Set<string>());
  const commandUpdateVersionRef = useRef(new Map<string, number>());
  const [busySessionIds, setBusySessionIds] = useState<Set<string>>(() => new Set());
  const busySessionIdsRef = useRef(new Set<string>());
  const [creatingSession, setCreatingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismissExtensionDraft = useCallback((sessionId: string, requestId: string) => {
    void host.request("sessions.editor-text.dismiss", { sessionId, requestId }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);
  const extensionUi = snapshot.sessions.find((session) => session.id === selectedSessionId)?.ui;
  const hasActiveCustomUi = extensionUi?.widgets.some((widget) => widget.content.type === "tui" && widget.content.interactive === true) ?? false;
  const selectedSessionSendPending = selectedSessionId
    ? busySessionIds.has(selectedSessionId)
    : busy;
  const extensionDraft = useExtensionDraft(selectedSessionId, connected ? extensionUi?.editorText : undefined, dismissExtensionDraft);
  const { composer, setComposer } = extensionDraft;
  const [extensionNotices, setExtensionNotices] = useState<{ sessionId: string; message: string; id: number }[]>([]);
  const extensionNoticeIdRef = useRef(0);
  const [status, setStatus] = useState<string | null>(null);
  const [interactionBusyId, setInteractionBusyId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectEditId, setProjectEditId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectFolders, setProjectFolders] = useState<string[]>([]);
  const [projectBusy, setProjectBusy] = useState(false);
  const [removeProjectConfirmId, setRemoveProjectConfirmId] = useState<string | null>(null);
  const [archiveProjectTarget, setArchiveProjectTarget] = useState<Project | null>(null);
  const [archiveProjectBusy, setArchiveProjectBusy] = useState(false);
  const [archiveProjectError, setArchiveProjectError] = useState<string | null>(null);
  const [sessionRenameTarget, setSessionRenameTarget] = useState<WorkspaceSession | null>(null);
  const [sessionRenameTitle, setSessionRenameTitle] = useState("");
  const [sessionRenameError, setSessionRenameError] = useState<string | null>(null);
  const [sessionRenameBusy, setSessionRenameBusy] = useState(false);
  const [permanentDeleteSessionTarget, setPermanentDeleteSessionTarget] = useState<WorkspaceSession | null>(null);
  const [permanentDeleteSessionBusy, setPermanentDeleteSessionBusy] = useState(false);
  const [permanentDeleteSessionError, setPermanentDeleteSessionError] = useState<string | null>(null);
  const [deleteSuccessNotice, setDeleteSuccessNotice] = useState(false);
  const deleteSuccessNoticeTimerRef = useRef<number | undefined>(undefined);
  const { fileMenuOpen, setFileMenuOpen, editMenuOpen, setEditMenuOpen, editMenuTargetRef, viewMenuOpen, setViewMenuOpen, helpMenuOpen, setHelpMenuOpen, viewBrowserSubmenuOpen, setViewBrowserSubmenuOpen, anyTopMenuOpen, hoverTopMenu, clickTopMenu, closeTopMenus } = useTopMenus();
  const [sessionImportOpen, setSessionImportOpen] = useState(false);
  const openFolderActionRef = useRef<() => void>(() => { });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPageRequest, setSettingsPageRequest] = useState<SettingsPage | null>(null);
  const [hiddenWorkspaceTabsOpen, setHiddenWorkspaceTabsOpen] = useState(false);
  const [settingsForwardAvailable, setSettingsForwardAvailable] = useState(false);
  const workspaceViews = useWorkspaceViews(selectedSessionId);
  const { workspaceViewBodyRef, workspacePanelRatio, workspaceSidePanelWidth, resizeWorkspaceSidePanel } = useWorkspacePanelSize(selectedSessionId);
  const workspacePagesRef = useRef<HTMLDivElement>(null);
  const previousWorkspaceSessionRef = useRef(selectedSessionId);
  const pickerEntranceFrameRef = useRef(0);
  const pickerEntranceAnimationsRef = useRef<Animation[]>([]);
  const cancelPickerEntrance = useCallback(() => {
    window.cancelAnimationFrame(pickerEntranceFrameRef.current);
    pickerEntranceFrameRef.current = 0;
    for (const animation of pickerEntranceAnimationsRef.current) animation.cancel();
    pickerEntranceAnimationsRef.current = [];
  }, []);
  useEffect(() => cancelPickerEntrance, [cancelPickerEntrance]);
  useLayoutEffect(() => {
    if (previousWorkspaceSessionRef.current === selectedSessionId) return;
    previousWorkspaceSessionRef.current = selectedSessionId;
    cancelPickerEntrance();
    const pages = workspacePagesRef.current;
    if (!pages) return;
    pages.classList.add("is-switching-session");
    let releaseFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      releaseFrame = window.requestAnimationFrame(() => pages.classList.remove("is-switching-session"));
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(releaseFrame);
    };
  }, [selectedSessionId, cancelPickerEntrance]);
  const viewReturnFocusRef = useRef<HTMLElement | null>(null);
  const openTabPicker = () => {
    viewReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { sideTab, panelHidden, fullView, activeTab } = workspaceViews.state;
    const alreadyVisible = sideTab === "picker" && !panelHidden && (!fullView || activeTab === "picker");
    cancelPickerEntrance();
    workspaceViews.openPicker();
    if (alreadyVisible || !selectedSessionId) return;
    const openingSessionId = selectedSessionId;
    const animatePanel = !fullView && (!sideTab || panelHidden);
    pickerEntranceFrameRef.current = window.requestAnimationFrame(() => {
      pickerEntranceFrameRef.current = 0;
      if (selectedSessionRef.current !== openingSessionId || !workspacePagesRef.current) return;
      pickerEntranceAnimationsRef.current = animateWorkspacePicker(workspacePagesRef.current, animatePanel);
    });
  };
  const toggleWorkspaceRightPanel = () => {
    if (workspaceViews.state.fullView) { workspaceViews.exitFullView(); return; }
    if (workspaceViews.state.sideTab && !workspaceViews.state.panelHidden) workspaceViews.hideSidePanel();
    else if (workspaceViews.state.sideTab) workspaceViews.showSidePanel();
    else openTabPicker();
  };
  const closeTabPicker = () => {
    cancelPickerEntrance(); workspaceViews.closePicker(); requestAnimationFrame(() => {
      if (viewReturnFocusRef.current?.isConnected) viewReturnFocusRef.current.focus();
      else document.querySelector<HTMLButtonElement>('.workspace-tabs [role="tab"][aria-selected="true"], [data-workspace-view-trigger]')?.focus();
    });
  };
  const openWorkspaceTab = (type: string, input?: unknown): WorkspaceTabId | null => {
    cancelPickerEntrance();
    try {
      const id = workspaceViews.openTab(type, workspaceTabContext, input);
      if (id) requestAnimationFrame(() => document.getElementById(`workspace-${id}-panel`)?.focus());
      return id;
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return null; }
  };
  const closeWorkspaceTab = (id: WorkspaceTabId) => {
    if (id === "picker") closeTabPicker(); else workspaceViews.closeTab(id);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.workspace-tabs [role="tab"][aria-selected="true"], [data-workspace-view-trigger]')?.focus());
  };
  const projectsHeadingRef = useRef<HTMLDivElement>(null);
  const recentHeadingRef = useRef<HTMLDivElement>(null);
  const [sortMode, setSortMode] = useState<"recent" | "manual">(() => {
    try { return window.localStorage.getItem("vagus.sidebar.session-sort-mode.v1") === "manual" ? "manual" : "recent"; } catch { return "recent"; }
  });
  const [manualSessionOrder, setManualSessionOrder] = useState<string[]>(readManualSessionOrder);
  const [manualProjectOrder, setManualProjectOrder] = useState<string[]>(readManualProjectOrder);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>(readPinnedSessionIds);
  const [pinnedProjectIds, setPinnedProjectIds] = useState<string[]>(readPinnedProjectIds);
  const [groupMode, setGroupMode] = useState<"project" | "merged">("project");
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [expandedProjectSessions, setExpandedProjectSessions] = useState<string[]>([]);
  const [projectsSectionCollapsed, setProjectsSectionCollapsed] = useState(false);
  const [recentSectionCollapsed, setRecentSectionCollapsed] = useState(false);
  const [pinnedSectionCollapsed, setPinnedSectionCollapsed] = useState(false);
  const [sessionViewedAt, setSessionViewedAt] = useState<Record<string, string>>(readSessionViewedAt);
  const [sidebarWidth, setSidebarWidth] = useState(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-default-width")) || 306);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [busyState, setBusyState] = useState(false);
  const [goalActionBusy, setGoalActionBusy] = useState(false);
  const [goalDeleteOpen, setGoalDeleteOpen] = useState(false);
  const [goalDeleteBusy, setGoalDeleteBusy] = useState(false);
  const [goalDeleteError, setGoalDeleteError] = useState<string | null>(null);
  const [durationNow, setDurationNow] = useState(() => Date.now());
  const { expandedTurnIds, setExpandedTurnIds, collapsedActiveTurnId, setCollapsedActiveTurnId, turnTransitions, toggleTurnExpansion: toggleTurnDisclosure } = useTurnDisclosure();
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(() => new Set());
  const [editingUserMessage, setEditingUserMessage] = useState<{ id: string; text: string; attachments: MessageAttachment[]; browserElements?: BrowserElementReference[] } | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [branchingMessageId, setBranchingMessageId] = useState<string | null>(null);
  const [nav, setNav] = useState<"home" | "scheduled">("home");
  const navRef = useRef(nav);
  navRef.current = nav;
  const [activeScheduledTask, setActiveScheduledTask] = useState<ScheduledTask | null>(null);
  const lastHomeLocationRef = useRef<{ projectId: string | null; sessionId: string | null }>({ projectId: null, sessionId: null });
  const handleActiveScheduledTask = useCallback((task: ScheduledTask | null) => {
    setActiveScheduledTask(task);
    if (!task) return;
    setSelectedProjectId(task.projectId);
    setSelectedSessionId(task.sessionId);
  }, []);
  const [navigationVersion, setNavigationVersion] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [startingApp, setStartingApp] = useState(true);
  const [initialWindowReady, setInitialWindowReady] = useState(() => !("__TAURI_INTERNALS__" in window));
  const [initialWorkspaceReady, setInitialWorkspaceReady] = useState(false);
  const fullscreenTogglePending = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [projectArchiveNotice, setProjectArchiveNotice] = useState<ProjectArchiveNotice | null>(null);
  const [projectlessDraft, setProjectlessDraft] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [workspacePickerPlacement, setWorkspacePickerPlacement] = useState<"composer" | "welcome">("composer");
  const [welcomeLogoAnimating, setWelcomeLogoAnimating] = useState(false);
  const welcomeLogoAnimatingRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingEditAnchorRef = useRef<{ viewport: HTMLElement; message: HTMLElement; top: number } | null>(null);
  const suppressNextTimelineScrollRef = useRef(false);
  const manualTimelineScrollLockRef = useRef(false);
  const manualTimelineScrollTimerRef = useRef<number | undefined>(undefined);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualConversationRef = useRef<VirtualConversationHandle>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const homePagePositionRef = useRef<{ sessionId: string | null; conversationScrollTop: number; sidebarScrollTop: number; wasAtBottom: boolean } | null>(null);
  const resizing = useRef(false);
  const selectedSessionRef = useRef<string | null>(null);
  const captureHomePagePosition = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    homePagePositionRef.current = {
      sessionId: selectedSessionRef.current,
      conversationScrollTop: viewport.scrollTop,
      sidebarScrollTop: sidebarRef.current?.querySelector<HTMLElement>(".sidebar-scroll")?.scrollTop ?? 0,
      wasAtBottom: distanceToBottom <= TIMELINE_BOTTOM_THRESHOLD,
    };
  }, []);
  const initialSessionIdRef = useRef<string | null>(null);
  if (initialSessionIdRef.current === null) {
    const requestedSessionId = new URLSearchParams(window.location.search).get("sessionId")
      ?? (import.meta.env.VITE_PROFILE_SESSION_ID || null);
    const windowLabel = "__TAURI_INTERNALS__" in window ? getCurrentWindow().label : "";
    initialSessionIdRef.current = requestedSessionId ?? (windowLabel.startsWith("chat-") ? windowLabel.slice("chat-".length) : null);
  }
  const skipSessionHydrationRef = useRef<string | null>(null);
  const selectedProjectRef = useRef<string | null>(null);
  const startNewChatRef = useRef<((projectId?: string | null) => void) | null>(null);
  const lastConversationProjectIdRef = useRef<string | null>(readLastConversationProjectId());
  const projectArchiveNoticeTimer = useRef<number | undefined>(undefined);
  const copyFeedbackTimerRef = useRef<number | undefined>(undefined);
  const navigationHistory = useRef<NavigationLocation[]>([{ projectId: null, sessionId: null, nav: "home" }]);
  const navigationCursor = useRef(0);
  const ordinarySessions = useMemo(() => snapshot.sessions.filter((session) => !session.scheduledTaskId), [snapshot.sessions]);
  const popupController = usePopupController({ projects: snapshot.projects, sessions: ordinarySessions, sidebarRef, resizing });
  const {
    projectMenu, sessionMenu, menuOpen, menuClosing, projectMenuClosing, sessionMenuClosing, menuSource, menuTop, menuLeft,
    popupSwitching, popupOpenVersion, popupEnteringVersion, sessionHoverCard, sessionHoverCardClosing, sessionActionTooltip,
    projectHoverCard, projectHoverCardClosing, setSessionActionTooltip, closeProjectMenu, closeSessionMenu, closeSidebarMenu,
    cancelPopupTransition, fadeProjectHoverCard, openSessionContextMenu, openSessionMenuFromHeader, openProjectMenu, openProjectContextMenu,
    toggleSidebarMenu, openSidebarSectionContextMenu, handlePopupDismissContextMenu, handleSidebarMenuContextMenu,
    showSessionHoverCard, showProjectHoverCard, closeSessionHoverCardSoon, closeSessionHoverCardImmediately, keepSessionHoverCardOpen,
    showSessionActionTooltip, clearHoverCards,
  } = popupController;
  const toggleSidebar = () => {
    closeSidebarMenu();
    // Width changes from native window restoration or responsive CSS must be instant.
    // Arm a transition only for this explicit user operation.
    if (sidebarRef.current) sidebarRef.current.dataset.userWidthMotion = "true";
    setSidebarCollapsed((collapsed) => !collapsed);
  };
  const shortcutHintVersion = JSON.stringify(shortcuts);
  useEffect(() => { setSessionActionTooltip(null); }, [shortcutHintVersion, setSessionActionTooltip]);
  selectedSessionRef.current = selectedSessionId;
  selectedProjectRef.current = selectedProjectId;
  const openSettingsView = (initialPage?: SettingsPage) => {
    captureHomePagePosition();
    cancelPopupTransition();
    setSettingsPageRequest(initialPage ?? null);
    setSessionImportOpen(false);
    setSettingsOpen(true); setSettingsForwardAvailable(false); closeTopMenus(); closeSidebarMenu(); closeProjectMenu(); closeSessionMenu();
    clearHoverCards(); setSearchOpen(false);
  };
  const canGoBack = navigationCursor.current > 0;
  const canGoForward = navigationCursor.current < navigationHistory.current.length - 1;

  useEffect(() => () => {
    if (projectArchiveNoticeTimer.current !== undefined) window.clearTimeout(projectArchiveNoticeTimer.current);
  }, []);
  function markSessionRead(sessionId: string) {
    const viewedAt = new Date().toISOString();
    setSessionViewedAt((current) => {
      const next = { ...current, [sessionId]: viewedAt };
      try { window.localStorage.setItem(sessionViewedAtKey, JSON.stringify(next)); } catch { /* Keep the read state in memory if storage is unavailable. */ }
      return next;
    });
  }
  function toggleSessionRead(session: WorkspaceSession) {
    setSessionViewedAt((current) => {
      const next = { ...current, [session.id]: hasUnreadAssistantReply(session, current) ? new Date().toISOString() : "unread" };
      try { window.localStorage.setItem(sessionViewedAtKey, JSON.stringify(next)); } catch { /* Keep the read state in memory if storage is unavailable. */ }
      return next;
    });
  }

  const navigateTo = useCallback((location: NavigationLocation, record = true) => {
    if (location.nav !== "home") captureHomePagePosition();
    setSessionImportOpen(false);
    if (record) {
      setSettingsForwardAvailable(false);
      const current = navigationHistory.current[navigationCursor.current];
      if (!current || current.projectId !== location.projectId || current.sessionId !== location.sessionId || current.nav !== location.nav) {
        navigationHistory.current = navigationHistory.current.slice(0, navigationCursor.current + 1);
        navigationHistory.current.push(location);
        navigationCursor.current = navigationHistory.current.length - 1;
      }
    } else navigationHistory.current[navigationCursor.current] = location;
    setSelectedProjectId(location.projectId);
    setSelectedSessionId(location.sessionId);
    setSlashMenuOpen(false);
    setComposerAttachments([]);
    setNav(location.nav);
    setNavigationVersion((version) => version + 1);
  }, [captureHomePagePosition]);

  const moveHistory = useCallback((direction: -1 | 1) => {
    const next = navigationCursor.current + direction;
    if (next < 0 || next >= navigationHistory.current.length) return;
    navigationCursor.current = next;
    const location = navigationHistory.current[next];
    if (!location) return;
    if (location.nav !== "home") captureHomePagePosition();
    setSelectedProjectId(location.projectId);
    setSelectedSessionId(location.sessionId);
    setSlashMenuOpen(false);
    setNav(location.nav);
    setNavigationVersion((version) => version + 1);
    setSearchOpen(false);
  }, [captureHomePagePosition]);

  const goBack = () => {
    if (settingsOpen) { setSettingsOpen(false); setSettingsForwardAvailable(true); }
    else { setSettingsForwardAvailable(false); moveHistory(-1); }
  };
  const goForward = () => {
    if (settingsOpen) return;
    if (settingsForwardAvailable) { setSettingsForwardAvailable(false); setSettingsOpen(true); }
    else moveHistory(1);
  };
  const toggleFullscreen = useCallback(async () => {
    if (fullscreenTogglePending.current) return;
    fullscreenTogglePending.current = true;
    try {
      const appWindow = getCurrentWindow();
      const next = !await appWindow.isFullscreen();
      await appWindow.setFullscreen(next);
      setFullscreen(next);
    } finally { fullscreenTogglePending.current = false; }
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) { setInitialWindowReady(true); return; }
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let active = true;
    const updateWindowState = async () => {
      const [isMaximized, isFullscreen] = await Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()]);
      if (!active) return;
      setMaximized(isMaximized);
      setFullscreen(isFullscreen);
      return true;
    };
    void updateWindowState().then((initialized) => {
      if (!initialized || !active) return;
      setInitialWindowReady(true);
    });
    void appWindow.onResized(updateWindowState).then((stop) => { unlisten = stop; });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!initialWindowReady || !initialWorkspaceReady) return;
    let releaseFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      releaseFrame = window.requestAnimationFrame(() => setStartingApp(false));
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(releaseFrame);
    };
  }, [initialWindowReady, initialWorkspaceReady]);

  useEffect(() => {
    let unlistenFocus: (() => void) | undefined;
    let active = true;
    const finishSidebarMotion = () => {
      if (sidebarRef.current) delete sidebarRef.current.dataset.userWidthMotion;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") finishSidebarMotion();
    };
    window.addEventListener("blur", finishSidebarMotion);
    document.addEventListener("visibilitychange", onVisibilityChange);
    if ("__TAURI_INTERNALS__" in window) {
      void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused) finishSidebarMotion();
      }).then((stop) => { if (active) unlistenFocus = stop; else stop(); });
    }
    return () => {
      active = false;
      window.removeEventListener("blur", finishSidebarMotion);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unlistenFocus?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.body.dataset.shortcutRecording) return;
      if (event.key === "Escape") { cancelPopupTransition(); closeProjectMenu(); closeSessionMenu(); closeSidebarMenu(); closeTopMenus(); }
      // AltGr input may report Ctrl+Alt; preserve the character it actually types.
      if (event.ctrlKey && event.altKey && event.key.length === 1 && event.code.startsWith("Key") && event.key.toUpperCase() !== event.code.slice(3)) return;
      const action = matchesShortcut(event, "open-settings") ? openSettingsView
        : matchesShortcut(event, "toggle-fullscreen") ? () => { void toggleFullscreen().catch((reason: unknown) => setError(`${i18n.t("窗口操作失败")}：${String(reason)}`)); }
          : matchesShortcut(event, "new-chat") ? () => { setSettingsOpen(false); setSettingsForwardAvailable(false); startNewChatRef.current?.(); }
            : matchesShortcut(event, "open-folder") ? () => { openFolderActionRef.current(); }
              : matchesShortcut(event, "close-window") ? () => { runWindowAction(() => getCurrentWindow().close()); }
                : matchesShortcut(event, "go-back") ? goBack
                  : matchesShortcut(event, "go-forward") ? goForward
                    : !settingsOpen && matchesShortcut(event, "search-sessions") ? () => setSearchOpen(true)
                      : !settingsOpen && nav !== "scheduled" && matchesShortcut(event, "toggle-sidebar") ? toggleSidebar
                        : !settingsOpen && selectedSessionId && matchesShortcut(event, "toggle-right-panel") ? () => { closeTopMenus(); toggleWorkspaceRightPanel(); }
                          : null;
      if (action) { event.preventDefault(); if (!event.repeat) action(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moveHistory, nav, settingsOpen, settingsForwardAvailable, toggleFullscreen, selectedSessionId, workspaceViews.state]);

  const refresh = useCallback(async () => {
    const next = await host.request("workspace.snapshot");
    const unique = { ...next, sessions: uniqueSessions(next.sessions) };
    setSnapshot(unique);
    return unique;
  }, []);
  const scanImportableSessions = useCallback((providerId: string) => host.request("providers.sessions.importable", { providerId }), []);
  const importProviderSession = useCallback((providerId: string, sourceId: string) => host.request("sessions.import", { providerId, sourceId }), []);

  useEffect(() => {
    if (!busyState) return;
    setDurationNow(Date.now());
    const timer = window.setInterval(() => setDurationNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busyState]);

  useEffect(() => {
    // A custom Pi TUI is an interactive extension operation, not a model turn.
    // Keep the RPC request pending while it is open, but don't show the chat as
    // generating a response or keep its elapsed-time indicator running.
    if (hasActiveCustomUi) setBusyState(false);
  }, [hasActiveCustomUi]);

  useEffect(() => {
    const refreshRelativeTime = () => setRelativeTimeNow(Date.now());
    const timer = window.setInterval(refreshRelativeTime, 60_000);
    document.addEventListener("visibilitychange", refreshRelativeTime);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshRelativeTime);
    };
  }, []);

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current !== undefined) window.clearTimeout(copyFeedbackTimerRef.current);
    if (manualTimelineScrollTimerRef.current !== undefined) window.clearTimeout(manualTimelineScrollTimerRef.current);
    for (const timer of taskNoticeTimersRef.current.values()) window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let active = true;
    let previouslyConnected = false;
    const unlistenConnection = host.onConnection(value => {
      if (!active) return;
      setConnected(value);
      if (value && previouslyConnected) {
        historyCacheRef.current.clear(); latestHistoryRef.current = null;
        skipSessionHydrationRef.current = null;
        setConnectionEpoch(epoch => epoch + 1);
        void refresh().catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
      }
      if (value) previouslyConnected = true;
    });
    const handleEvent = (event: AgentEvent) => {
      if (!active) return;
      // Preview acknowledgements are independent of timeline hydration. An
      // input accepted during loading may already be included in the page.
      if (event.type === "message.started" && event.clientMessageId) updateMessagePreviews((current) => current.some((preview) => preview.sessionId === event.sessionId && preview.message.id === event.clientMessageId) ? current.map((preview) => preview.sessionId === event.sessionId && preview.message.id === event.clientMessageId ? { ...preview, confirmedMessageId: event.messageId } : preview) : current);
      if (event.type === "message.completed" || (event.type === "message.delta" && event.text)) updateMessagePreviews((current) => current.some((preview) => preview.sessionId === event.sessionId && preview.confirmedMessageId === event.messageId) ? current.filter((preview) => preview.sessionId !== event.sessionId || preview.confirmedMessageId !== event.messageId) : current);
      if ("sessionId" in event && (event.type === "message.completed" || event.type === "tool.completed")) {
        const updatedAt = event.occurredAt ?? new Date().toISOString();
        setSnapshot((current) => ({
          ...current,
          sessions: current.sessions.map((session) => session.id === event.sessionId ? { ...session, updatedAt } : session),
        }));
      }
      if (event.type === "ui.status" || event.type === "ui.widget" || event.type === "ui.editorText" || event.type === "ui.editorText.dismissed" || event.type === "ui.reset") {
        if (event.type === "ui.reset") liveCustomWidgetKeysRef.current.set(event.sessionId, new Set());
        if (event.type === "ui.widget") {
          let keys = liveCustomWidgetKeysRef.current.get(event.sessionId);
          if (!keys) {
            keys = new Set(snapshotRef.current.sessions.find((session) => session.id === event.sessionId)?.ui?.widgets
              .filter((widget) => widget.content.type === "tui" && widget.content.interactive).map((widget) => widget.key) ?? []);
            liveCustomWidgetKeysRef.current.set(event.sessionId, keys);
          }
          if (event.content?.type === "tui" && event.content.interactive && event.content.lines.length) {
            if (!keys.has(event.key) && event.sessionId === selectedSessionRef.current) {
              setCustomUiActivation({ sessionId: event.sessionId, key: event.key });
            }
            keys.add(event.key);
          } else keys.delete(event.key);
        }
        setSnapshot((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === event.sessionId ? { ...session, ui: applySessionUiEvent(session.ui, event) } : session) }));
      }
      if (event.type === "ui.title") void refresh().catch(() => undefined);
      const loading = initialHistoryLoadRef.current;
      if (loading && "sessionId" in event && event.sessionId === loading.sessionId && event.sessionId === selectedSessionRef.current && ["message.started", "message.delta", "message.completed", "tool.started", "tool.updated", "tool.completed", "interaction.requested", "interaction.responded", "notification", "provider.error", "ui.status", "session.settings.updated", "session.commands.updated", "session.usage.updated", "session.plan.updated", "session.turn.diff.updated"].includes(event.type)) {
        loading.events.push(event);
        return;
      }
      if (event.type === "provider.models.updated") {
        setSnapshot((current) => ({ ...current, providers: current.providers.map((provider) => provider.id === event.catalog.providerId ? { ...provider, health: providerHealthFromCatalog(event.catalog) } : provider) }));
      } else if (event.type === "session.commands.updated") {
        commandUpdateVersionRef.current.set(event.sessionId, (commandUpdateVersionRef.current.get(event.sessionId) ?? 0) + 1);
        commandCacheRef.current.set(event.sessionId, event.commands);
        if (selectedSessionRef.current === event.sessionId) setSlashCommands(event.commands);
      } else if (event.type === "provider.enabled.updated") {
        setSnapshot((current) => ({ ...current, providers: current.providers.map((provider) => provider.id === event.providerId ? { ...provider, enabled: event.enabled } : provider) }));
      } else if (event.type === "session.usage.updated") {
        setSnapshot((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === event.sessionId ? { ...session, usage: event.usage } : session) }));
      } else if (event.type === "session.settings.updated") {
        setSnapshot((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === event.sessionId ? { ...session, runtimeSettings: event.settings } : session) }));
      } else if (event.type === "session.queue.updated") {
        setSnapshot((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === event.sessionId ? { ...session, queue: event.queue } : session) }));
      } else if (event.type === "session.turn.diff.updated" && event.sessionId === selectedSessionRef.current) {
        setTurnDiffs((current) => {
          const id = `turn-diff-${encodeURIComponent(event.turnId)}`;
          const previous = current.find((entry) => entry.id === id);
          const order = previous?.order ?? event.sequence ?? timelineOrderRef.current;
          timelineOrderRef.current = Math.max(timelineOrderRef.current, order + 1);
          const next: ChatTurnDiff = { id, order, turnId: event.turnId, diff: event.diff, ...(event.truncated ? { truncated: true } : {}) };
          return previous ? current.map((entry) => entry.id === id ? next : entry) : [...current, next];
        });
      } else if (event.type === "session.plan.updated" && event.sessionId === selectedSessionRef.current) {
        setPlans((current) => {
          const previous = current.find((plan) => plan.id === event.planId);
          const order = previous?.order ?? event.sequence ?? timelineOrderRef.current;
          timelineOrderRef.current = Math.max(timelineOrderRef.current, order + 1);
          const next: ChatPlan = { id: event.planId, order, ...(event.turnId ? { turnId: event.turnId } : previous?.turnId ? { turnId: previous.turnId } : {}), ...(event.explanation ? { explanation: event.explanation } : {}), steps: event.steps };
          return previous ? current.map((plan) => plan.id === event.planId ? next : plan) : [...current, next];
        });
      } else if (event.type === "session.compaction") {
        setCompactingSessionIds((current) => {
          const next = new Set(current);
          if (event.state === "started") next.add(event.sessionId);
          else next.delete(event.sessionId);
          return next;
        });
      } else if (event.type === "session.state") {
        const previousState = previousSessionStatesRef.current.get(event.sessionId);
        previousSessionStatesRef.current.set(event.sessionId, event.state);
        if (event.state === "running") {
          const timer = taskNoticeTimersRef.current.get(event.sessionId);
          if (timer !== undefined) window.clearTimeout(timer);
          taskNoticeTimersRef.current.delete(event.sessionId);
          pendingTaskNoticesRef.current.delete(event.sessionId);
        }
        const completedRun = previousState === "running" && event.state === "idle";
        const failedRun = (previousState === "running" || previousState === "starting") && event.state === "ended" && pendingTaskNoticesRef.current.has(event.sessionId);
        if (completedRun || failedRun) {
          const fallbackTitle = snapshotRef.current.sessions.find((session) => session.id === event.sessionId)?.title ?? "Vagus";
          const previousTimer = taskNoticeTimersRef.current.get(event.sessionId);
          if (previousTimer !== undefined) window.clearTimeout(previousTimer);
          const timer = window.setTimeout(() => {
            taskNoticeTimersRef.current.delete(event.sessionId);
            const currentState = previousSessionStatesRef.current.get(event.sessionId);
            if (currentState !== "idle" && currentState !== "ended") return;
            pendingTaskNoticesRef.current.delete(event.sessionId);
            void notifySessionTask(event.sessionId, fallbackTitle);
          }, 500);
          taskNoticeTimersRef.current.set(event.sessionId, timer);
        }
        if (event.state === "starting" || event.state === "ended") {
          setCompactingSessionIds((current) => {
            if (!current.has(event.sessionId)) return current;
            const next = new Set(current);
            next.delete(event.sessionId);
            return next;
          });
        }
        setSnapshot((current) => ({ ...current, sessions: current.sessions.map((s) => s.id === event.sessionId ? { ...s, state: event.state } : s) }));
        if (event.sessionId === selectedSessionRef.current) {
          setBusyState(event.state === "running");
          if (event.state === "idle" || event.state === "ended") setStatus(null);
        }
      } else if (event.type === "message.started") {
        if (event.sessionId !== selectedSessionRef.current) return;
        const order = event.sequence ?? timelineOrderRef.current;
        timelineOrderRef.current = Math.max(timelineOrderRef.current, order + 1);
        setMessages((current) => current.some((m) => m.id === event.messageId)
          ? event.replay ? current.map((m) => m.id === event.messageId ? { ...m, text: "", complete: false, completedAt: undefined } : m) : current
          : [...current, { id: event.messageId, role: event.role, text: "", complete: false, order, occurredAt: event.occurredAt, ...(event.turnId ? { turnId: event.turnId } : {}), ...(event.attachments?.length ? { attachments: event.attachments } : {}), ...(event.browserElements?.length ? { browserElements: event.browserElements } : {}) }]);
      } else if (event.type === "message.delta") {
        if (event.sessionId !== selectedSessionRef.current) return;
        setMessages((current) => current.map((m) => m.id === event.messageId ? { ...m, text: m.text + event.text } : m));
      } else if (event.type === "message.completed") {
        if (event.sessionId === selectedSessionRef.current) {
          setMessages((current) => current.map((m) => m.id === event.messageId ? { ...m, complete: true, completedAt: event.occurredAt } : m));
          markSessionRead(event.sessionId);
        }
        // Completion events arrive for sessions outside the active view too.
        // Refresh their summary so lastAssistantAt can drive the unread marker.
        void refresh().catch(() => undefined);
      } else if (event.type === "workspace.changed") {
        void refresh().then((next) => {
          const selectedId = selectedSessionRef.current;
          const selected = selectedId ? next.sessions.find((session) => session.id === selectedId) : null;
          if (navRef.current === "home" && selectedId && (!selected || selected.archivedAt)) navigateTo({ projectId: selected?.projectId ?? selectedProjectRef.current, sessionId: null, nav: "home" }, false);
        }).catch(() => undefined);
      } else if (event.type === "session.history.updated") {
        const sessionId = event.sessionId;
        if (sessionId !== selectedSessionRef.current) return;
        void host.request("sessions.open", { sessionId, historyLimit: 120 }).then((opened) => {
          if (selectedSessionRef.current !== sessionId) return;
          const history = hydrateConversation(opened);
          setSnapshot((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === opened.id ? summaryOnly(opened) : session) }));
          timelineOrderRef.current = Math.max(timelineOrderRef.current, history.nextOrder);
          setMessages((current) => mergeHistoryItems(current, history.messages));
          setActivities((current) => mergeHistoryItems(current, history.activities));
          setStatuses((current) => mergeHistoryItems(current, history.statuses));
          setInteractions((current) => mergeHistoryItems(current, history.interactions));
          setNotices((current) => mergeHistoryItems(current, history.notices));
          setPlans((current) => mergeHistoryItems(current, history.plans));
          setTurnDiffs((current) => mergeHistoryItems(current, history.turnDiffs));
          setHistoryQueries((current) => mergeHistoryItems(current, (opened.queryMarkers ?? []).map((marker) => ({ id: marker.id, role: "user" as const, text: marker.text, complete: true, order: marker.sequence, occurredAt: marker.occurredAt }))));
          const previousCursor = historyCursorRef.current?.sessionId === sessionId ? historyCursorRef.current : null;
          const hasMore = previousCursor?.hasMore ?? Boolean(opened.history?.hasMore);
          historyCursorRef.current = { sessionId, beforeSequence: previousCursor?.hasMore ? previousCursor.beforeSequence : opened.history?.beforeSequence ?? null, hasMore };
          setHistoryHasMore(hasMore);
        }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
      } else if (event.type === "tool.started") {
        if (event.sessionId !== selectedSessionRef.current) return;
        const order = event.sequence ?? timelineOrderRef.current;
        timelineOrderRef.current = Math.max(timelineOrderRef.current, order + 1);
        setActivities((current) => applyToolStarted(current, event, order));
      } else if (event.type === "tool.updated") {
        if (event.sessionId !== selectedSessionRef.current) return;
        setActivities((current) => current.map((t) => t.id === event.toolCallId ? {
          ...t,
          ...(event.parentToolCallId !== undefined ? { parentToolCallId: event.parentToolCallId } : {}),
          ...(event.name !== undefined ? { name: event.name } : {}),
          ...(event.title !== undefined ? { title: event.title } : {}),
          ...(event.toolKind !== undefined ? { toolKind: event.toolKind } : {}),
          ...(event.input !== undefined ? { input: event.input } : {}),
          ...(event.content !== undefined ? { content: event.content } : {}),
          ...(event.locations !== undefined ? { locations: event.locations } : {}),
          ...(event.output !== undefined ? { output: event.output } : {}),
          ...(event.outputDelta !== undefined ? { output: `${typeof t.output === "string" ? t.output : ""}${event.outputDelta}` } : {}),
          ...(event.terminalExitCode !== undefined ? { terminalExitCode: event.terminalExitCode } : {}),
        } : t));
      } else if (event.type === "tool.completed") {
        if (event.sessionId !== selectedSessionRef.current) return;
        setActivities((current) => current.map((t) => t.id === event.toolCallId ? { ...t, state: event.isError ? "error" : "done", ...(event.output !== undefined ? { output: event.output } : {}), ...(event.terminalExitCode !== undefined ? { terminalExitCode: event.terminalExitCode } : {}) } : t));
      } else if (event.type === "interaction.requested" && event.sessionId === selectedSessionRef.current) {
        const order = event.sequence ?? timelineOrderRef.current;
        timelineOrderRef.current = Math.max(timelineOrderRef.current, order + 1);
        setInteractions((current) => current.some((item) => item.id === event.interactionId) ? current : [...current, { id: event.interactionId, order, ...(event.turnId ? { turnId: event.turnId } : {}), interaction: event.interaction, state: "pending" }]);
      } else if (event.type === "interaction.responded" && event.sessionId === selectedSessionRef.current) {
        setInteractions((current) => current.map((item) => item.id === event.interactionId && item.state === "pending" ? { ...item, state: event.value === null ? "cancelled" : "responded", response: event.value, reason: event.reason } : item));
      } else if (event.type === "provider.error") {
        if (event.sessionId) pendingTaskNoticesRef.current.set(event.sessionId, { title: i18n.t("Agent 遇到错误"), body: event.message });
        else void notifyTask(i18n.t("Agent 遇到错误"), event.message);
        if (event.sessionId && event.sessionId === selectedSessionRef.current) {
          const order = event.sequence ?? timelineOrderRef.current;
          timelineOrderRef.current = Math.max(timelineOrderRef.current, order + 1);
          setNotices((current) => [...current, { id: `notice-${order}`, order, ...(event.turnId ? { turnId: event.turnId } : {}), level: "error", message: event.message }]);
          setBusyState(false);
        } else setError(event.message);
      } else if (event.type === "notification") {
        if (event.level !== "info") {
          const title = event.level === "error" ? i18n.t("Agent 遇到错误") : i18n.t("Agent 需要注意");
          if (event.sessionId) pendingTaskNoticesRef.current.set(event.sessionId, { title, body: event.message });
          else void notifyTask(title, event.message);
        }
        if (event.sessionId === selectedSessionRef.current && event.level !== "info") {
          const order = event.sequence ?? timelineOrderRef.current;
          timelineOrderRef.current = Math.max(timelineOrderRef.current, order + 1);
          setNotices((current) => [...current, { id: `notice-${order}`, order, ...(event.turnId ? { turnId: event.turnId } : {}), level: event.level, message: event.message }]);
        }
        if (event.sessionId === selectedSessionRef.current && event.level === "info") {
          const id = ++extensionNoticeIdRef.current;
          setExtensionNotices((current) => [...current, { sessionId: event.sessionId, message: event.message, id }]);
        }
      } else if (event.type === "ui.status") {
        if (event.sessionId !== selectedSessionRef.current) return;
        if ((event.key.startsWith("claude-subagent:") || event.key.startsWith("subagent:")) && event.text) {
          const order = event.sequence ?? timelineOrderRef.current;
          timelineOrderRef.current = Math.max(timelineOrderRef.current, order + 1);
          const id = `subagent-${encodeURIComponent(event.key)}`;
          setStatuses((current) => {
            const previous = current.find((item) => item.id === id);
            const next: ChatStatus = { id, order: previous?.order ?? order, ...(event.turnId ? { turnId: event.turnId } : previous?.turnId ? { turnId: previous.turnId } : {}), key: event.key, text: event.text!, ...(event.subagentSessionId ? { subagentSessionId: event.subagentSessionId } : {}), ...(event.subagentCancellable !== undefined ? { subagentCancellable: event.subagentCancellable } : previous?.subagentCancellable !== undefined ? { subagentCancellable: previous.subagentCancellable } : {}), ...(event.subagentState ? { subagentState: event.subagentState } : {}) };
            return previous ? current.map((item) => item.id === id ? next : item) : [...current, next];
          });
          return;
        }
        if (event.key !== "agent-activity") return;
        if (event.text && !event.turnId) return;
        setStatus(event.text);
        if (event.text) {
          const order = event.sequence ?? timelineOrderRef.current;
          timelineOrderRef.current = Math.max(timelineOrderRef.current, order + 1);
          setStatuses((current) => current.some((item) => item.id === `status-${order}`) ? current : [...current, { id: `status-${order}`, order, ...(event.turnId ? { turnId: event.turnId } : {}), key: event.key, text: event.text! }]);
        }
      }
    };
    agentEventHandlerRef.current = handleEvent;
    const unlisten = host.onEvent(handleEvent);
    const connect = async () => {
      if ("__TAURI_INTERNALS__" in window) {
        const startupError = await invoke<string | null>("host_startup_error");
        if (startupError) throw new Error(startupError);
      }
      await host.connect();
      return refresh();
    };
    void connect().then(async (data) => {
      if (!active) return;
      const initialSession = initialSessionIdRef.current
        ? data.sessions.find((session) => session.id === initialSessionIdRef.current && !session.archivedAt)
        : undefined;
      if (initialSession) {
        navigateTo({ projectId: initialSession.projectId, sessionId: initialSession.id, nav: "home" }, false);
        return;
      }
      const firstProject = data.projects.find((project) => project.id === lastConversationProjectIdRef.current) ?? data.projects[0];
      if (firstProject) navigateTo({ projectId: firstProject.id, sessionId: null, nav: "home" }, false);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => {
      if (active) setInitialWorkspaceReady(true);
    });
    return () => { active = false; unlisten(); unlistenConnection(); host.close(); };
  }, [navigateTo, refresh, updateMessagePreviews]);

  useLayoutEffect(() => {
    if (latestHistoryRef.current) historyCacheRef.current.set(latestHistoryRef.current);
    latestHistoryRef.current = null;
    historyOwnerRef.current = null;
    if (manualTimelineScrollTimerRef.current !== undefined) window.clearTimeout(manualTimelineScrollTimerRef.current);
    manualTimelineScrollTimerRef.current = undefined;
    manualTimelineScrollLockRef.current = false;
    followTimelineRef.current = true;
    setCollapsedActiveTurnId(null);
    setExpandedTurnIds(new Set());
    setExpandedActivityIds(new Set());
    setEditingUserMessage(null);
    setShowNewActivity(false);
    setHistoryQueries([]);
    setHistoryHasMore(false);
    setHistoryLoading(false);
    historyCursorRef.current = null;
    olderHistoryRequestRef.current = null;
    pendingHistoryAnchorRef.current = null;
    pendingQueryJumpRef.current = null;
    initialHistoryLoadRef.current = null;
    setHydratedSessionId(null);
    if (!selectedSessionId) { timelineOrderRef.current = 0; followTimelineRef.current = true; setShowNewActivity(false); setMessages([]); setActivities([]); setStatuses([]); setInteractions([]); setNotices([]); setPlans([]); setTurnDiffs([]); setBusy(false); setBusyState(false); setStatus(null); return; }
    if (skipSessionHydrationRef.current === selectedSessionId) {
      skipSessionHydrationRef.current = null;
      historyOwnerRef.current = selectedSessionId;
      setHydratedSessionId(selectedSessionId);
      markSessionRead(selectedSessionId);
      return;
    }
    markSessionRead(selectedSessionId);
    const session = snapshot.sessions.find((item) => item.id === selectedSessionId);
    const cached = historyCacheRef.current.get(selectedSessionId);
    if (session) {
      timelineOrderRef.current = (session.eventSequence ?? 0) + 1;
      setMessages(cached?.messages ?? []); setActivities(cached?.activities ?? []); setStatuses(cached?.statuses ?? []); setInteractions(cached?.interactions ?? []); setNotices(cached?.notices ?? []); setPlans(cached?.plans ?? []); setTurnDiffs(cached?.turnDiffs ?? []); setSelectedProjectId(session.projectId); setBusyState(session.state === "running");
      historyOwnerRef.current = selectedSessionId;
      if (cached) {
        setHistoryQueries(cached.queries);
        historyCursorRef.current = { sessionId: selectedSessionId, beforeSequence: cached.beforeSequence, hasMore: cached.hasMore };
        setHistoryHasMore(cached.hasMore);
      }
      lastConversationProjectIdRef.current = session.projectId;
      setProjectlessDraft(session.projectId === null);
      if (session.projectId) saveLastConversationProjectId(session.projectId);
      else clearLastConversationProjectId();
    }
    setError(null); setStatus(null); setExtensionNotices([]);
    const loading = { sessionId: selectedSessionId, events: [] as AgentEvent[] };
    initialHistoryLoadRef.current = loading;
    setHistoryLoading(true);
    let active = true;
    void host.request("sessions.open", { sessionId: selectedSessionId, historyLimit: 120 }).then((opened) => {
      if (!active || selectedSessionRef.current !== selectedSessionId) return;
      const loadedHistory = hydrateConversation(opened);
      // A cached window can be larger than the server's normal opening page.
      // Merge the fresh page into it instead of replacing it and visibly
      // shrinking a long conversation during the switch.
      const history = cached ? {
        ...loadedHistory,
        messages: mergeHistoryItems(cached.messages, loadedHistory.messages),
        activities: mergeHistoryItems(cached.activities, loadedHistory.activities),
        statuses: mergeHistoryItems(cached.statuses, loadedHistory.statuses),
        interactions: mergeHistoryItems(cached.interactions, loadedHistory.interactions),
        notices: mergeHistoryItems(cached.notices, loadedHistory.notices),
        plans: mergeHistoryItems(cached.plans, loadedHistory.plans),
        turnDiffs: mergeHistoryItems(cached.turnDiffs, loadedHistory.turnDiffs),
      } : loadedHistory;
      setSnapshot((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === opened.id ? summaryOnly(opened) : session) }));
      setBusyState(opened.state === "running");
      markSessionRead(opened.id);
      timelineOrderRef.current = Math.max(timelineOrderRef.current, history.nextOrder);
      setMessages(history.messages); setActivities(history.activities); setStatuses(history.statuses); setInteractions(history.interactions); setNotices(history.notices); setPlans(history.plans); setTurnDiffs(history.turnDiffs);
      setHistoryQueries((opened.queryMarkers ?? []).map((marker) => ({ id: marker.id, role: "user", text: marker.text, complete: true, order: marker.sequence, occurredAt: marker.occurredAt })));
      const hasMore = cached ? cached.hasMore : opened.history?.hasMore ?? false;
      historyCursorRef.current = { sessionId: selectedSessionId, beforeSequence: cached ? (cached.hasMore ? cached.beforeSequence : null) : opened.history?.beforeSequence ?? null, hasMore };
      setHistoryHasMore(hasMore);
      initialHistoryLoadRef.current = null;
      // Events received before the snapshot are already in it. Replay only
      // newer events after hydration so an in-flight reply cannot lose text.
      for (const event of loading.events) if ((event.sequence ?? Infinity) > (opened.eventSequence ?? 0)) agentEventHandlerRef.current(event);
      setHydratedSessionId(selectedSessionId);
    }).catch((reason: unknown) => {
      if (!active) return;
      initialHistoryLoadRef.current = null;
      for (const event of loading.events) agentEventHandlerRef.current(event);
      setError(reason instanceof Error ? reason.message : String(reason));
      setHydratedSessionId(selectedSessionId);
    }).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; if (initialHistoryLoadRef.current === loading) initialHistoryLoadRef.current = null; };
  }, [selectedSessionId, connectionEpoch]);

  useEffect(() => {
    if (!connected) return;
    void host.request("sessions.subscribe", { sessionId: selectedSessionId }).catch((reason: unknown) => {
      console.warn("Could not update the active session event subscription", reason);
    });
  }, [connected, selectedSessionId]);

  useLayoutEffect(() => {
    const anchor = pendingEditAnchorRef.current;
    if (!anchor) return;
    pendingEditAnchorRef.current = null;
    const offset = anchor.message.getBoundingClientRect().top - anchor.top;
    if (Math.abs(offset) > 0.5) {
      suppressNextTimelineScrollRef.current = true;
      anchor.viewport.scrollTop += offset;
      window.requestAnimationFrame(() => { suppressNextTimelineScrollRef.current = false; });
    }
    const textarea = editTextareaRef.current;
    textarea?.focus({ preventScroll: true });
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [editingUserMessage?.id]);

  // Local previews are scoped to their conversation and never written to Host history.
  // Keep the full preview visible until the canonical user text arrives.
  const displayMessages = useMemo(() => {
    const result = [...messages];
    for (const preview of localMessagePreviews) {
      if (preview.sessionId !== selectedSessionId || (!selectedSessionId && preview.projectId !== selectedProjectId)) continue;
      const index = preview.confirmedMessageId ? result.findIndex((message) => message.id === preview.confirmedMessageId) : -1;
      if (index >= 0) {
        const confirmed = result[index]!;
        result[index] = { ...confirmed, text: confirmed.text || preview.message.text };
      } else result.push(preview.message);
    }
    return result;
  }, [messages, localMessagePreviews, selectedSessionId, selectedProjectId]);

  const projectionRef = useRef(new ConversationProjection());
  const conversationEntries = useMemo(() => projectionRef.current.update({ messages, displayMessages, activities, statuses, interactions, notices, plans, turnDiffs, busy: busyState }), [messages, displayMessages, activities, statuses, interactions, notices, plans, turnDiffs, busyState]);
  const liveUsersRef = useRef<ChatMessage[]>([]);
  const liveUsers = displayMessages.filter((message) => message.role === "user" && isVisibleChatMessage(message));
  if (liveUsersRef.current.length !== liveUsers.length || !liveUsers.every((message, index) => liveUsersRef.current[index] === message)) liveUsersRef.current = liveUsers;
  const stableLiveUsers = liveUsersRef.current;
  const userQueryMessages = useMemo(() => mergeHistoryItems(historyQueries, stableLiveUsers), [stableLiveUsers, historyQueries]);
  const latestConversationEntry = useMemo(() => {
    for (let index = conversationEntries.length - 1; index >= 0; index--) if (conversationEntries[index]!.kind !== "duration") return conversationEntries[index];
    return undefined;
  }, [conversationEntries]);
  const latestUserMessageId = stableLiveUsers.reduce<ChatMessage | undefined>((latest, message) => !latest || message.order > latest.order ? message : latest, undefined)?.id;
  const projectionDurations = projectionRef.current.getDurations();
  const turnDurations = useMemo(() => new Map(projectionDurations.map((entry) => [entry.turnId, entry])), [projectionDurations]);
  const activeTurnId = projectionDurations.find((entry) => entry.active)?.turnId;
  const visibleConversationRows = useMemo(() => conversationEntries.flatMap((entry, index) => {
    if (entry.kind === "duration") return [{ key: `duration:${entry.turnId}`, index, estimate: 36, pinned: false }];
    const duration = entry.value.turnId ? turnDurations.get(entry.value.turnId) : undefined;
    const expanded = duration && (duration.active ? collapsedActiveTurnId !== duration.turnId : expandedTurnIds.has(duration.turnId));
    const collapsing = duration && turnTransitions[duration.turnId] === "collapsing";
    if (duration && !expanded && !collapsing && entry.order > duration.userOrder && !(entry.kind === "message" && entry.value.id === duration.finalAssistantMessageId)) return [];
    const estimate = entry.kind === "message" ? Math.min(2000, 70 + Math.ceil(entry.value.text.length / 80) * 23) : entry.kind === "plan" ? Math.min(520, 58 + entry.value.steps.length * 26 + Math.ceil((entry.value.explanation?.length ?? 0) / 90) * 16) : entry.kind === "turnDiff" ? 48 : entry.kind === "interaction" ? 180 : entry.kind === "notice" ? 64 : 36;
    const pinned = (entry.kind === "interaction" && entry.value.state === "pending") || (entry.kind === "message" && entry.value.id === editingUserMessage?.id) || (entry.kind === "tool" && expandedActivityIds.has(entry.value.id));
    return [{ key: `${entry.kind}:${entry.value.id}`, index, estimate, pinned }];
  }), [conversationEntries, turnDurations, expandedTurnIds, collapsedActiveTurnId, turnTransitions, editingUserMessage?.id, expandedActivityIds]);
  const toggleTurnExpansion = (turnId: string) => toggleTurnDisclosure(turnId, turnDurations.get(turnId)?.active ?? false);
  const decorateTurnProcessEntry = (entry: Exclude<ConversationEntry, { kind: "duration" }>, node: ReactNode): ReactNode => {
    const turnId = entry.value.turnId;
    const duration = turnId ? turnDurations.get(turnId) : undefined;
    if (!duration || entry.order <= duration.userOrder || (entry.kind === "message" && entry.value.id === duration.finalAssistantMessageId)) return node;
    const transition = turnTransitions[turnId!];
    return transition ? <div className={`turn-process-transition is-${transition}`} key={`turn-process-${turnId}-${entry.kind}-${entry.order}`}><div className="turn-process-transition-inner">{node}</div></div> : node;
  };
  const activeStatusId = busyState && latestConversationEntry?.kind === "status" ? latestConversationEntry.value.id : null;
  const loadOlderHistory = (): Promise<void> => {
    if (olderHistoryRequestRef.current) return olderHistoryRequestRef.current;
    const cursor = historyCursorRef.current;
    if (!cursor?.hasMore || cursor.beforeSequence === null || cursor.sessionId !== selectedSessionRef.current) return Promise.resolve();
    setHistoryLoading(true);
    const request = host.request("sessions.history", { sessionId: cursor.sessionId, beforeSequence: cursor.beforeSequence, limit: 120 }).then((page) => {
      if (historyCursorRef.current !== cursor || selectedSessionRef.current !== cursor.sessionId) return;
      const session = snapshotRef.current.sessions.find((item) => item.id === cursor.sessionId);
      if (!session) return;
      const viewport = scrollRef.current;
      if (viewport && !pendingQueryJumpRef.current) {
        const viewportTop = viewport.getBoundingClientRect().top;
        const anchor = [...viewport.querySelectorAll<HTMLElement>("[data-timeline-row-key]")].find((element) => element.getBoundingClientRect().bottom > viewportTop);
        if (anchor) pendingHistoryAnchorRef.current = { key: anchor.dataset.timelineRowKey!, top: anchor.getBoundingClientRect().top, scrollHeight: viewport.scrollHeight, scrollTop: viewport.scrollTop };
      }
      const older = hydrateConversation({ ...session, timeline: page.entries });
      setMessages((current) => mergeHistoryItems(older.messages, current));
      setActivities((current) => mergeHistoryItems(older.activities, current));
      setStatuses((current) => mergeHistoryItems(older.statuses, current));
      setInteractions((current) => mergeHistoryItems(older.interactions, current));
      setNotices((current) => mergeHistoryItems(older.notices, current));
      setPlans((current) => mergeHistoryItems(older.plans, current));
      setTurnDiffs((current) => mergeHistoryItems(older.turnDiffs, current));
      historyCursorRef.current = { sessionId: cursor.sessionId, beforeSequence: page.beforeSequence, hasMore: page.hasMore };
      setHistoryHasMore(page.hasMore);
    }).catch((reason: unknown) => {
      if (selectedSessionRef.current === cursor.sessionId) {
        pendingHistoryAnchorRef.current = null;
        pendingQueryJumpRef.current = null;
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (olderHistoryRequestRef.current === request) { olderHistoryRequestRef.current = null; setHistoryLoading(false); }
    });
    olderHistoryRequestRef.current = request;
    return request;
  };
  const jumpToUserQuery = async (messageId: string) => {
    if (manualTimelineScrollTimerRef.current !== undefined) window.clearTimeout(manualTimelineScrollTimerRef.current);
    manualTimelineScrollTimerRef.current = undefined;
    manualTimelineScrollLockRef.current = false;
    followTimelineRef.current = false;
    setActiveQueryMessageId(messageId);
    setShowNewActivity(true);
    pendingHistoryAnchorRef.current = null;
    pendingQueryJumpRef.current = messageId;
    if (virtualConversationRef.current?.scrollToKey(`message:${messageId}`)) { pendingQueryJumpRef.current = null; return; }
    const query = userQueryMessages.find((message) => message.id === messageId);
    const sessionId = selectedSessionRef.current;
    if (!query || !sessionId) return;
    while (selectedSessionRef.current === sessionId) {
      const cursor = historyCursorRef.current;
      if (!cursor?.hasMore || cursor.beforeSequence === null || cursor.beforeSequence <= query.order) break;
      const previousSequence = cursor.beforeSequence;
      await loadOlderHistory();
      if (selectedSessionRef.current !== sessionId) return;
      if (virtualConversationRef.current?.scrollToKey(`message:${messageId}`)) { pendingQueryJumpRef.current = null; return; }
      const nextCursor = historyCursorRef.current;
      if (!nextCursor || nextCursor.beforeSequence === previousSequence) break;
    }
    pendingQueryJumpRef.current = null;
  };
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const jump = pendingQueryJumpRef.current;
    if (jump && virtualConversationRef.current?.scrollToKey(`message:${jump}`)) { pendingQueryJumpRef.current = null; pendingHistoryAnchorRef.current = null; return; }
    const anchor = pendingHistoryAnchorRef.current;
    if (!viewport || !anchor) return;
    pendingHistoryAnchorRef.current = null;
    const element = viewport.querySelector<HTMLElement>(`[data-timeline-row-key="${CSS.escape(anchor.key)}"]`);
    if (element) viewport.scrollTop += element.getBoundingClientRect().top - anchor.top;
    else if (!virtualConversationRef.current?.isVirtualized) viewport.scrollTop = anchor.scrollTop + viewport.scrollHeight - anchor.scrollHeight;
  }, [conversationEntries, visibleConversationRows]);
  const preserveTimelineDisclosureAnchor = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLElement>(".conversation-activity-header[aria-expanded], .interaction-settled-heading[aria-expanded], .turn-duration button[aria-expanded]");
    if (!anchor) return;
    const anchorTop = anchor.getBoundingClientRect().top;
    followTimelineRef.current = false;
    window.requestAnimationFrame(() => {
      const viewport = scrollRef.current;
      if (!viewport || !anchor.isConnected) return;
      const offset = anchor.getBoundingClientRect().top - anchorTop;
      if (Math.abs(offset) > 0.5) viewport.scrollTop += offset;
    });
  };

  const holdTimelineForManualScroll = () => {
    manualTimelineScrollLockRef.current = true;
    followTimelineRef.current = false;
    if (manualTimelineScrollTimerRef.current !== undefined) window.clearTimeout(manualTimelineScrollTimerRef.current);
    manualTimelineScrollTimerRef.current = window.setTimeout(() => {
      manualTimelineScrollTimerRef.current = undefined;
      manualTimelineScrollLockRef.current = false;
      const viewport = scrollRef.current;
      if (!viewport) return;
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const atBottom = distanceToBottom <= TIMELINE_BOTTOM_THRESHOLD;
      followTimelineRef.current = atBottom;
      setShowNewActivity(conversationEntries.length > 0 && !atBottom);
    }, 180);
  };

  const beginTimelineFollow = () => {
    if (manualTimelineScrollTimerRef.current !== undefined) {
      window.clearTimeout(manualTimelineScrollTimerRef.current);
      manualTimelineScrollTimerRef.current = undefined;
    }
    manualTimelineScrollLockRef.current = false;
    followTimelineRef.current = true;
    const current = latestHistoryRef.current;
    if (current && !editingUserMessage && !expandedActivityIds.size && !olderHistoryRequestRef.current) {
      const recent = recentWindow(current);
      if (recent !== current) {
        pendingHistoryAnchorRef.current = null;
        pendingQueryJumpRef.current = null;
        setMessages(recent.messages); setActivities(recent.activities); setStatuses(recent.statuses); setInteractions(recent.interactions); setNotices(recent.notices); setPlans(recent.plans); setTurnDiffs(recent.turnDiffs);
        historyCursorRef.current = { sessionId: recent.sessionId, beforeSequence: recent.beforeSequence, hasMore: recent.hasMore };
        setHistoryHasMore(recent.hasMore);
      }
    }
    setShowNewActivity(false);
    const viewport = scrollRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  };

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    if (manualTimelineScrollLockRef.current) {
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      setShowNewActivity(conversationEntries.length > 0 && distanceToBottom > TIMELINE_BOTTOM_THRESHOLD);
      return;
    }
    if (followTimelineRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      setShowNewActivity(false);
      return;
    }
    const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const showJumpButton = conversationEntries.length > 0 && distanceToBottom > TIMELINE_BOTTOM_THRESHOLD;
    if (distanceToBottom <= TIMELINE_BOTTOM_THRESHOLD) followTimelineRef.current = true;
    setShowNewActivity(showJumpButton);
  }, [conversationEntries]);

  useEffect(() => {
    const viewport = scrollRef.current;
    const content = viewport?.querySelector<HTMLElement>(".message-flow");
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => {
      if (!followTimelineRef.current) return;
      // Keep the bottom aligned before paint, including when extension controls
      // change the viewport height without adding a conversation entry.
      viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [selectedSessionId, conversationEntries.length > 0]);

  const projectSessions = useMemo(() => {
    const sessions = ordinarySessions.filter((session) => !session.archivedAt);
    if (sortMode === "recent") sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    else {
      const order = new Map(manualSessionOrder.map((id, index) => [id, index]));
      sessions.sort((a, b) => {
        const aIndex = order.get(a.id);
        const bIndex = order.get(b.id);
        if (aIndex === undefined && bIndex === undefined) return b.updatedAt.localeCompare(a.updatedAt);
        if (aIndex === undefined) return 1;
        if (bIndex === undefined) return -1;
        return aIndex - bIndex;
      });
    }
    return sessions;
  }, [manualSessionOrder, ordinarySessions, sortMode]);
  const pinnedSessions = useMemo(() => {
    const pinned = new Set(pinnedSessionIds);
    return projectSessions.filter((session) => pinned.has(session.id));
  }, [projectSessions, pinnedSessionIds]);
  const pinnedProjects = useMemo(() => pinnedProjectIds.flatMap((id) => {
    const project = snapshot.projects.find((item) => item.id === id);
    return project ? [project] : [];
  }), [pinnedProjectIds, snapshot.projects]);
  const unpinnedProjects = useMemo(() => {
    const pinned = new Set(pinnedProjectIds);
    const projects = snapshot.projects.filter((project) => !pinned.has(project.id));
    if (sortMode === "manual") {
      const order = new Map(manualProjectOrder.map((id, index) => [id, index]));
      return projects.sort((a, b) => {
        const aIndex = order.get(a.id);
        const bIndex = order.get(b.id);
        if (aIndex === undefined && bIndex === undefined) return 0;
        if (aIndex === undefined) return 1;
        if (bIndex === undefined) return -1;
        return aIndex - bIndex;
      });
    }
    return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [snapshot.projects, pinnedProjectIds, sortMode, manualProjectOrder]);
  const unpinnedProjectSessions = useMemo(() => {
    const pinned = new Set(pinnedSessionIds);
    return projectSessions.filter((session) => !pinned.has(session.id));
  }, [projectSessions, pinnedSessionIds]);
  const recentEligibleSessions = useMemo(() => {
    const pinned = new Set(pinnedSessionIds);
    return projectSessions.filter((session) => !pinned.has(session.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [projectSessions, pinnedSessionIds]);
  const recentSessions = useMemo(() => recentEligibleSessions.slice(0, 10), [recentEligibleSessions]);
  const sidebarRecentSessions = groupMode === "merged" ? recentEligibleSessions : recentSessions;
  const selectedProject = snapshot.projects.find((item) => item.id === selectedProjectId) ?? null;
  const selectedSession = snapshot.sessions.find((item) => item.id === selectedSessionId) ?? null;
  useEffect(() => {
    if (nav !== "home" || selectedSession?.scheduledTaskId) return;
    lastHomeLocationRef.current = { projectId: selectedSession?.projectId ?? selectedProjectId, sessionId: selectedSession?.id ?? null };
  }, [nav, selectedProjectId, selectedSession?.id, selectedSession?.projectId, selectedSession?.scheduledTaskId]);
  const openMarkdownUrl = (rawUrl: string) => {
    let url: URL;
    try { url = new URL(rawUrl); } catch { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    const openedTab = openWorkspaceTab("browser", { url: url.href });
    if (!openedTab) {
      void invoke("open_external_url", { url: url.href }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : i18n.t("无法打开授权页面，请稍后重试")));
      return;
    }
    if (navRef.current === "scheduled") navigateTo({ projectId: selectedSession?.projectId ?? selectedProjectId, sessionId: selectedSessionId, nav: "home" });
  };
  const workspaceTabContext: WorkspaceTabContext = {
    host, sessionId: selectedSessionId, projectId: selectedSession?.projectId ?? null,
    cwd: selectedSession?.projectId ? snapshot.projects.find(project => project.id === selectedSession.projectId)?.root ?? null : selectedProject?.root ?? null,
    openUrl: openMarkdownUrl,
    attachBrowserElement: ({ element, imageDataUrl, fileName }) => {
      setComposerBrowserElements(current => current.some(item => item.id === element.id) ? current : [...current, element].slice(-20));
      if (imageDataUrl) {
        const size = Math.floor(((imageDataUrl.split(",", 2)[1] ?? "").length * 3) / 4);
        setComposerAttachments(current => current.length >= 4 || current.reduce((total, item) => total + item.size, size) > 5 * 1024 * 1024
          ? current
          : [...current, { id: crypto.randomUUID(), name: fileName ?? "browser-element.png", mimeType: "image/png", size, dataUrl: imageDataUrl }]);
      }
    },
  };
  const timelineReady = useConversationReadiness(selectedSessionId, hydratedSessionId, scrollRef);
  useLayoutEffect(() => {
    if (settingsOpen || nav !== "home" || sessionImportOpen) return;
    const saved = homePagePositionRef.current;
    let frame = 0;
    let attempts = 0;
    if (saved) {
      const restore = () => {
        const viewport = scrollRef.current;
        const sidebarScroll = sidebarRef.current?.querySelector<HTMLElement>(".sidebar-scroll");
        if (!viewport) {
          if (attempts++ < 12) frame = window.requestAnimationFrame(restore);
          return;
        }
        if (sidebarScroll) sidebarScroll.scrollTop = saved.sidebarScrollTop;
        if (saved.sessionId === selectedSessionRef.current) {
          const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
          viewport.scrollTop = saved.wasAtBottom ? maxScrollTop : Math.min(saved.conversationScrollTop, maxScrollTop);
          followTimelineRef.current = saved.wasAtBottom;
          const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
          setShowNewActivity(conversationEntries.length > 0 && distanceToBottom > TIMELINE_BOTTOM_THRESHOLD);
        }
        if (attempts++ < 8) frame = window.requestAnimationFrame(restore);
        else if (homePagePositionRef.current === saved) homePagePositionRef.current = null;
      };
      frame = window.requestAnimationFrame(restore);
    }
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      const viewport = scrollRef.current;
      if (!viewport) return;
      const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      homePagePositionRef.current = {
        sessionId: selectedSessionRef.current,
        conversationScrollTop: viewport.scrollTop,
        sidebarScrollTop: sidebarRef.current?.querySelector<HTMLElement>(".sidebar-scroll")?.scrollTop ?? 0,
        wasAtBottom: distanceToBottom <= TIMELINE_BOTTOM_THRESHOLD,
      };
    };
  }, [settingsOpen, nav, sessionImportOpen]);
  const sessionRunning = Boolean(selectedSession && (busyState || selectedSession.state === "running"));
  const selectedSessionCompacting = Boolean(selectedSessionId && compactingSessionIds.has(selectedSessionId));
  useEffect(() => {
    if (!queueDeliveryMenuOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!queueDeliveryControlRef.current?.contains(event.target as Node)) setQueueDeliveryMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQueueDeliveryMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [queueDeliveryMenuOpen]);
  useEffect(() => {
    if (!sessionRunning) setQueueDeliveryMenuOpen(false);
  }, [sessionRunning]);
  const headerWorkspaceName = selectedProject?.name ?? (selectedSession?.projectId === null ? i18n.t("此计算机") : i18n.t("选择一个项目"));
  const availableProviders = useMemo(() => snapshot.providers.filter((provider) => provider.enabled && provider.health === "healthy"), [snapshot.providers]);
  const selectedDraftProvider = availableProviders.find((provider) => provider.id === selectedProviderId) ?? availableProviders[0] ?? null;
  const selectedSessionProvider = snapshot.providers.find((provider) => provider.id === selectedSession?.providerId) ?? snapshot.providers.find((provider) => provider.id === "pi") ?? null;
  const providerSupports = (id: string) => Boolean(selectedSessionProvider?.capabilities.some((capability) => capability.id === id && capability.status !== "unsupported"));
  const selectedSessionSupportsQueue = hostCapabilities.sessionQueue && providerSupports("session.queue");
  const selectedSessionSupportsContext = hostCapabilities.sessionContext && providerSupports("session.context");
  const selectedSessionSupportsCommands = Boolean(selectedSessionProvider?.capabilities.some((capability) => capability.id === "session.commands" && capability.status !== "unsupported"));
  const selectedSessionSupportsFork = Boolean(selectedSessionProvider?.capabilities.some((capability) => capability.id === "session.fork" && capability.status !== "unsupported"));
  const latestCompletedAssistantMessage = [...messages].reverse().find((message) => message.role === "assistant" && message.complete);
  const openCodeBranchMessageId = selectedSessionProvider?.id === "opencode"
    && latestCompletedAssistantMessage
    && !messages.some((message) => message.role === "user" && message.order > latestCompletedAssistantMessage.order)
    ? latestCompletedAssistantMessage.id
    : null;
  const activeProviderSupportsAttachments = (selectedSession ? selectedSessionProvider : selectedDraftProvider)?.capabilities.some((capability) => capability.id === "message.attachments" && capability.status !== "unsupported") ?? false;
  const activeProviderSupportsFileAttachments = (selectedSession ? selectedSessionProvider : selectedDraftProvider)?.id === "opencode";

  useEffect(() => {
    if (selectedProviderId && availableProviders.some((provider) => provider.id === selectedProviderId)) return;
    const rememberedProviderId = getLastCreatedProviderId();
    const preferredProvider = availableProviders.find((provider) => provider.id === rememberedProviderId)
      ?? availableProviders.find((provider) => provider.id === "pi")
      ?? availableProviders[0]
      ?? null;
    setSelectedProviderId(preferredProvider?.id ?? null);
  }, [availableProviders, selectedProviderId]);

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    if (!connected) {
      setHostCapabilities({ sessionModelSelection: false, sessionUsage: false, sessionQueue: false, sessionContext: false, sessionCommands: false });
      return () => { active = false; if (retryTimer !== undefined) window.clearTimeout(retryTimer); };
    }
    let attempt = 0;
    const readCapabilities = async () => {
      try {
        const capabilities = await host.request("host.capabilities");
        if (active) setHostCapabilities({ sessionModelSelection: capabilities.sessionModelSelection === true, sessionUsage: capabilities.sessionUsage === true, sessionQueue: capabilities.sessionQueue === true, sessionContext: capabilities.sessionContext === true, sessionCommands: capabilities.sessionCommands === true });
      } catch {
        // A transient RPC race (for example during reconnect/HMR) must not
        // permanently disable every session control that depends on this RPC.
        // Keep the last known capabilities and retry while the host is connected.
        if (active) {
          const delay = Math.min(5000, 250 * 2 ** Math.min(attempt++, 5));
          retryTimer = window.setTimeout(() => { void readCapabilities(); }, delay);
        }
      }
    };
    void readCapabilities();
    return () => { active = false; if (retryTimer !== undefined) window.clearTimeout(retryTimer); };
  }, [connected]);

  useEffect(() => {
    if (!agentPickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!agentPickerRef.current?.contains(event.target as Node)) setAgentPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAgentPickerOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [agentPickerOpen]);
  const hoverProjectData = projectHoverCard ? snapshot.projects.find((item) => item.id === projectHoverCard.projectId) ?? null : null;
  const hoverSessionData = sessionHoverCard ? snapshot.sessions.find((item) => item.id === sessionHoverCard.sessionId) ?? null : null;
  const hoverSessionProject = hoverSessionData?.projectId ? snapshot.projects.find((item) => item.id === hoverSessionData.projectId) ?? null : null;
  const projectMenuData = projectMenu ? snapshot.projects.find((item) => item.id === projectMenu.projectId) ?? null : null;
  const sessionMenuData = sessionMenu ? snapshot.sessions.find((item) => item.id === sessionMenu.sessionId) ?? null : null;
  const sessionMenuSupportsFork = Boolean(sessionMenuData && snapshot.providers.find((provider) => provider.id === (sessionMenuData.providerId ?? "pi"))?.capabilities.some((capability) => capability.id === "session.fork" && capability.status !== "unsupported"));
  const sessionMenuSubmenuOpensLeft = Boolean(sessionMenu && sessionMenu.left + 224 + 8 + 210 > window.innerWidth);
  const projectMenuRoots = projectMenuData?.roots?.length ? projectMenuData.roots : projectMenuData ? [projectMenuData.root] : [];
  const hoverProjectSessions = hoverProjectData ? snapshot.sessions.filter((session) => session.projectId === hoverProjectData.id && !session.scheduledTaskId) : [];
  const hoverProjectRunningCount = hoverProjectSessions.filter((session) => session.state === "running").length;
  const hoverProjectUnreadCount = hoverProjectSessions.filter((session) => hasUnreadAssistantReply(session, sessionViewedAt)).length;
  const searchResults = useSessionSearch(host, searchQuery, searchOpen);
  const searchedSessions = useMemo(() => {
    const q = searchQuery.trim().toLocaleLowerCase();
    return projectSessions.filter((session) => !q || searchResults.ids?.has(session.id)).slice(0, Math.max(30, searchResults.ids?.size ?? 30));
  }, [projectSessions, searchQuery, searchResults.ids]);
  const searchActions = [
    { id: "new-chat", label: i18n.t("新会话"), icon: <SquarePen size={16} />, run: () => { setSearchOpen(false); startNewChat(); } },
    { id: "add-project", label: i18n.t("添加项目"), icon: <FolderPlus size={16} />, run: () => { setSearchOpen(false); startProjectCreate(); } },
    { id: "import-session", label: i18n.t("导入会话"), icon: <Import size={16} />, run: () => { closeSidebarMenu(); closeProjectMenu(); closeSessionMenu(); clearHoverCards(); setSearchOpen(false); setSessionImportOpen(true); } },
    { id: "scheduled", label: i18n.t("定时任务"), icon: <Clock3 size={16} />, run: () => { setSearchOpen(false); setSettingsOpen(false); navigateTo({ projectId: selectedProjectId, sessionId: selectedSessionId, nav: "scheduled" }); } },
    { id: "settings", label: i18n.t("设置"), icon: <Settings size={16} />, run: () => openSettingsView() },
    { id: "keyboard-shortcuts", label: i18n.t("键盘快捷键"), icon: <Keyboard size={16} />, run: () => openSettingsView("keyboard") },
  ];
  const filteredSearchActions = searchQuery.trim()
    ? searchActions.filter((action) => action.label.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()))
    : searchActions;
  const { draggingSessionId, dragTargetSessionId, draggingProjectId, dragTargetProjectId, beginSessionPointerDrag, moveSessionPointerDrag, endSessionPointerDrag, captureSessionClick, beginProjectPointerDrag, moveProjectPointerDrag, endProjectPointerDrag, cancelProjectPointerDrag, captureProjectClick } = useSidebarDrag({ snapshot, groupMode, sortMode, projectSessions, pinnedProjects, unpinnedProjects, pinnedProjectIds, setPinnedProjectIds, setManualSessionOrder, setManualProjectOrder, clearHoverCards, setSessionActionTooltip });

  const clearProjectArchiveNotice = () => {
    if (projectArchiveNoticeTimer.current !== undefined) window.clearTimeout(projectArchiveNoticeTimer.current);
    setProjectArchiveNotice((current) => current ? { ...current, closing: true } : null);
    projectArchiveNoticeTimer.current = window.setTimeout(() => {
      projectArchiveNoticeTimer.current = undefined;
      setProjectArchiveNotice(null);
    }, 180);
  };

  const showProjectArchiveNotice = (next: ProjectArchiveNotice) => {
    if (projectArchiveNoticeTimer.current !== undefined) window.clearTimeout(projectArchiveNoticeTimer.current);
    projectArchiveNoticeTimer.current = undefined;
    setProjectArchiveNotice(next);
    if (next.kind === "archived" || next.kind === "undone") projectArchiveNoticeTimer.current = window.setTimeout(clearProjectArchiveNotice, 3000);
  };

  const toggleSessionPin = (session: WorkspaceSession) => {
    setPinnedSessionIds((current) => {
      const next = current.includes(session.id) ? current.filter((id) => id !== session.id) : [...current, session.id];
      try { window.localStorage.setItem(pinnedSessionIdsKey, JSON.stringify(next)); } catch { /* Keep the current in-memory state if storage is unavailable. */ }
      return next;
    });
  };

  const archiveSession = async (session: WorkspaceSession) => {
    setError(null);
    try {
      await host.request("sessions.archive", { sessionId: session.id });
      await refresh();
      clearHoverCards();
      if (selectedSessionId === session.id) navigateTo({ projectId: session.projectId, sessionId: null, nav: "home" });
      showProjectArchiveNotice({ kind: "archived", sessionIds: [session.id], count: 1, scope: "single" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const copySessionMarkdown = (session: WorkspaceSession) => {
    closeSessionMenu();
    void (async () => {
      const opened = await host.request("sessions.open", { sessionId: session.id, historyLimit: 120 });
      let cursor = opened.history?.beforeSequence ?? null;
      let hasMore = opened.history?.hasMore ?? false;
      const chunks: string[] = [];
      let pageEntries: SessionTimelineEntry[] = opened.timeline ?? [];
      const appendPage = async (entries: SessionTimelineEntry[]) => {
        const result = new Array<string>(entries.length);
        let next = 0;
        const worker = async () => {
          while (next < entries.length) {
            const index = next++;
            let entry = entries[index]!;
            if ((entry.kind === "message" || entry.kind === "tool") && entry.contentDeferred) entry = await host.request("sessions.entry", { sessionId: session.id, entryId: entry.id }, 30_000);
            result[index] = timelineToMarkdown([entry]);
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, entries.length) }, worker));
        chunks.push(result.filter(Boolean).join("\n"));
      };
      await appendPage(pageEntries);
      while (hasMore && cursor !== null) {
        const page = await host.request("sessions.history", { sessionId: session.id, beforeSequence: cursor, limit: 120 }, 30_000);
        if (!page.entries.length) break;
        await appendPage(page.entries);
        cursor = page.beforeSequence;
        hasMore = page.hasMore;
      }
      const content = chunks.reverse().filter(Boolean).join("\n");
      await writeClipboardText(`# ${opened.title}\n${content ? `\n${content}` : ""}\n`);
    })().then(() => {
      setNotice(i18n.t("整个聊天已复制为 Markdown"));
      window.setTimeout(() => setNotice(null), 2400);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : i18n.t("复制到剪贴板失败")));
  };

  const loadDeferredMessage = useCallback((message: ChatMessage): Promise<void> => {
    const sessionId = selectedSessionRef.current;
    if (!sessionId || !message.contentDeferred) return Promise.resolve();
    const requestKey = `${sessionId}:${message.id}`;
    const existing = deferredContentRequestsRef.current.get(requestKey);
    if (existing) return existing;
    const request = host.request("sessions.entry", { sessionId, entryId: message.id }, 30_000).then((entry) => {
      if (entry.kind !== "message" || selectedSessionRef.current !== sessionId) return;
      setMessages((current) => current.map((item) => item.id === entry.id
        ? { ...item, text: entry.text, attachments: entry.attachments, browserElements: entry.browserElements, contentDeferred: undefined }
        : item));
    }).finally(() => deferredContentRequestsRef.current.delete(requestKey));
    deferredContentRequestsRef.current.set(requestKey, request);
    return request;
  }, []);

  const loadDeferredTool = useCallback((activity: ToolActivity): Promise<void> => {
    const sessionId = selectedSessionRef.current;
    if (!sessionId || !activity.contentDeferred) return Promise.resolve();
    const requestKey = `${sessionId}:${activity.id}`;
    const existing = deferredContentRequestsRef.current.get(requestKey);
    if (existing) return existing;
    const request = host.request("sessions.entry", { sessionId, entryId: activity.id }, 30_000).then((entry) => {
      if (entry.kind !== "tool" || selectedSessionRef.current !== sessionId) return;
      setActivities((current) => current.map((item) => item.id === entry.id
        ? { ...item, input: entry.input, content: entry.content, locations: entry.locations, output: entry.output, contentDeferred: undefined }
        : item));
    }).finally(() => deferredContentRequestsRef.current.delete(requestKey));
    deferredContentRequestsRef.current.set(requestKey, request);
    return request;
  }, []);

  const copySessionWorkingDirectory = (session: WorkspaceSession) => {
    closeSessionMenu();
    const project = snapshot.projects.find((item) => item.id === session.projectId);
    const workingDirectory = project?.root ?? project?.roots?.[0];
    if (!workingDirectory) {
      setNotice(i18n.t("此聊天没有关联的工作目录"));
      window.setTimeout(() => setNotice(null), 2400);
      return;
    }
    void writeClipboardText(workingDirectory).then(() => {
      setNotice(i18n.t("工作目录已复制到剪贴板"));
      window.setTimeout(() => setNotice(null), 2400);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : i18n.t("复制到剪贴板失败")));
  };

  const renameSession = async () => {
    const target = sessionRenameTarget;
    const title = sessionRenameTitle.trim();
    if (!target || !title) return;
    setSessionRenameBusy(true);
    setSessionRenameError(null);
    try {
      const updated = await host.request("sessions.rename", { sessionId: target.id, title });
      setSnapshot((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === updated.id ? summaryOnly(updated) : session) }));
      setSessionRenameTarget(null);
      setNotice(i18n.t("聊天已重命名"));
      window.setTimeout(() => setNotice(null), 2400);
    } catch (reason) {
      setSessionRenameError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSessionRenameBusy(false);
    }
  };

  const permanentlyDeleteSession = async () => {
    const target = permanentDeleteSessionTarget;
    if (!target) return;
    setPermanentDeleteSessionBusy(true);
    setPermanentDeleteSessionError(null);
    try {
      await host.request("sessions.delete-permanent", { sessionId: target.id });
      setSnapshot((current) => ({ ...current, sessions: current.sessions.filter((session) => session.id !== target.id) }));
      setPinnedSessionIds((current) => {
        const next = current.filter((id) => id !== target.id);
        try { window.localStorage.setItem(pinnedSessionIdsKey, JSON.stringify(next)); } catch { /* Keep the current in-memory state if storage is unavailable. */ }
        return next;
      });
      if (selectedSessionId === target.id) {
        navigateTo({ projectId: target.projectId, sessionId: null, nav: "home" });
        setMessages([]); setStatuses([]); setPlans([]); setTurnDiffs([]);
      }
      setPermanentDeleteSessionTarget(null);
      if (deleteSuccessNoticeTimerRef.current !== undefined) window.clearTimeout(deleteSuccessNoticeTimerRef.current);
      setDeleteSuccessNotice(true);
      deleteSuccessNoticeTimerRef.current = window.setTimeout(() => {
        setDeleteSuccessNotice(false);
        deleteSuccessNoticeTimerRef.current = undefined;
      }, 3000);
    } catch (reason) {
      setPermanentDeleteSessionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPermanentDeleteSessionBusy(false);
    }
  };

  const dismissDeleteSuccessNotice = () => {
    if (deleteSuccessNoticeTimerRef.current !== undefined) window.clearTimeout(deleteSuccessNoticeTimerRef.current);
    deleteSuccessNoticeTimerRef.current = undefined;
    setDeleteSuccessNotice(false);
  };

  const requestProjectArchive = (project: Project) => {
    const count = snapshot.sessions.filter((session) => session.projectId === project.id && !session.archivedAt && !session.scheduledTaskId).length;
    if (count === 0) { setNotice(i18n.t("该项目没有可归档的聊天")); window.setTimeout(() => setNotice(null), 2400); return; }
    setArchiveProjectError(null);
    setArchiveProjectTarget(project);
  };

  const archiveProjectChats = async () => {
    const project = archiveProjectTarget;
    if (!project) return;
    setArchiveProjectBusy(true);
    setArchiveProjectError(null);
    try {
      const result = await host.request("sessions.archive-in-project", { projectId: project.id });
      await refresh();
      clearHoverCards();
      if (selectedSession?.projectId === project.id) navigateTo({ projectId: project.id, sessionId: null, nav: "home" });
      setArchiveProjectTarget(null);
      if (result.archived > 0) showProjectArchiveNotice({ kind: "archived", sessionIds: result.sessionIds, count: result.archived, scope: "project" });
      else { setNotice(i18n.t("该项目没有可归档的聊天")); window.setTimeout(() => setNotice(null), 2400); }
    } catch (reason) { setArchiveProjectError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setArchiveProjectBusy(false); }
  };

  const undoProjectArchive = async () => {
    if (!projectArchiveNotice || projectArchiveNotice.kind !== "archived") return;
    const sessionIds = projectArchiveNotice.sessionIds;
    showProjectArchiveNotice({ kind: "undoing" });
    try {
      for (const sessionId of sessionIds) await host.request("sessions.unarchive", { sessionId });
      await refresh();
      showProjectArchiveNotice({ kind: "undone" });
    } catch (reason) {
      clearProjectArchiveNotice();
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const toggleProjectPin = (project: Project) => {
    setPinnedProjectIds((current) => {
      const next = current.includes(project.id) ? current.filter((id) => id !== project.id) : [...current, project.id];
      try { window.localStorage.setItem(pinnedProjectIdsKey, JSON.stringify(next)); } catch { /* Keep the current in-memory state if storage is unavailable. */ }
      return next;
    });
    closeProjectMenu();
    fadeProjectHoverCard();
  };

  const startProjectCreate = () => {
    setProjectEditId(null); setProjectName(""); setProjectFolders([]); setError(null); setProjectDialogOpen(true);
  };

  const startNewChat = (requestedProjectId?: string | null) => {
    setSessionImportOpen(false);
    const rememberedProject = snapshot.projects.find((project) => project.id === lastConversationProjectIdRef.current);
    const projectId = (requestedProjectId ? snapshot.projects.find((project) => project.id === requestedProjectId)?.id : null)
      ?? rememberedProject?.id ?? selectedProjectId ?? snapshot.projects[0]?.id ?? null;
    if (!projectId) { startProjectCreate(); return; }
    clearHoverCards(); closeSidebarMenu(); closeProjectMenu(); closeSessionMenu();
    setWorkspacePickerOpen(false); setProjectlessDraft(false);
    setSearchOpen(false); setError(null); setMessages([]); setActivities([]); setStatuses([]); setPlans([]); setTurnDiffs([]); setComposer("", null); setStatus(null);
    navigateTo({ projectId, sessionId: null, nav: "home" });
  };

  const startProjectlessChat = () => {
    setSessionImportOpen(false);
    clearHoverCards(); closeSidebarMenu(); closeProjectMenu(); closeSessionMenu();
    setWorkspacePickerOpen(false); setProjectlessDraft(true); setSearchOpen(false); setError(null);
    setMessages([]); setActivities([]); setStatuses([]); setPlans([]); setTurnDiffs([]); setComposer("", null); setStatus(null);
    navigateTo({ projectId: null, sessionId: null, nav: "home" });
  };
  const toggleWorkspacePicker = (placement: "composer" | "welcome") => {
    setAgentPickerOpen(false);
    setSessionActionTooltip(null);
    if (workspacePickerOpen && workspacePickerPlacement === placement) {
      setWorkspacePickerOpen(false);
      return;
    }
    setWorkspacePickerPlacement(placement);
    setWorkspacePickerOpen(true);
  };
  const startWelcomeLogoAnimation = () => {
    if (welcomeLogoAnimatingRef.current) return;
    welcomeLogoAnimatingRef.current = true;
    setWelcomeLogoAnimating(true);
  };
  const finishWelcomeLogoAnimation = (event: ReactAnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.animationName !== "vagus-nerve-response") return;
    welcomeLogoAnimatingRef.current = false;
    setWelcomeLogoAnimating(false);
  };
  startNewChatRef.current = startNewChat;

  const startProjectEdit = (project: Project) => {
    setProjectEditId(project.id); setProjectName(project.name); setProjectFolders(project.roots?.length ? [...project.roots] : [project.root]);
    setError(null); clearHoverCards(); closeProjectMenu(); setProjectDialogOpen(true);
  };

  const saveProject = async () => {
    setError(null);
    const roots = [...new Set(projectFolders.map((path) => path.trim()).filter(Boolean))];
    if (!projectName.trim() || roots.length === 0) { setError(i18n.t("请填写项目名称并至少选择一个本机文件夹")); return; }
    setProjectBusy(true);
    try {
      if (projectEditId) {
        await host.request("projects.update", { projectId: projectEditId, name: projectName.trim(), roots });
        await refresh();
        setNotice(i18n.t("项目已保存"));
      } else {
        const created = await host.request("projects.create", { name: projectName.trim(), root: roots[0], roots });
        const next = await refresh();
        setProjectlessDraft(false);
        navigateTo({ projectId: created.id, sessionId: null, nav: "home" });
        if (!next.projects.length) throw new Error(i18n.t("项目创建成功，但工作区刷新失败"));
        setNotice(i18n.t("项目已添加"));
      }
      setProjectDialogOpen(false); setProjectEditId(null); setProjectName(""); setProjectFolders([]);
      window.setTimeout(() => setNotice(null), 2400);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setProjectBusy(false); }
  };

  const chooseFolders = async () => {
    let folders: string[] = [];
    if ("__TAURI_INTERNALS__" in window) {
      const result = await open({ directory: true, multiple: true, title: i18n.t("选择项目文件夹") });
      folders = Array.isArray(result) ? result : typeof result === "string" ? [result] : [];
    } else {
      const folder = window.prompt(i18n.t("输入本机项目文件夹路径"));
      if (folder) folders = [folder];
    }
    if (!folders.length) return;
    setProjectFolders((current) => [...new Set([...current, ...folders])]);
    if (!projectName.trim()) setProjectName(folders[0]!.split(/[\\/]/).filter(Boolean).at(-1) ?? i18n.t("新项目"));
  };

  const openFolderFromMenu = async () => {
    let folder: string | null = null;
    if ("__TAURI_INTERNALS__" in window) {
      const result = await open({ directory: true, multiple: false, title: i18n.t("打开文件夹") });
      folder = typeof result === "string" ? result : Array.isArray(result) ? result[0] ?? null : null;
    } else {
      folder = window.prompt(i18n.t("输入本机项目文件夹路径"));
    }
    if (!folder) return;
    const normalizedFolder = folder.replace(/[\\/]+$/, "").toLocaleLowerCase();
    const existingProject = snapshot.projects.find((project) =>
      (project.roots?.length ? project.roots : [project.root]).some((root) => root.replace(/[\\/]+$/, "").toLocaleLowerCase() === normalizedFolder),
    );
    setFileMenuOpen(false);
    setSettingsOpen(false);
    if (existingProject) {
      setProjectlessDraft(false);
      navigateTo({ projectId: existingProject.id, sessionId: null, nav: "home" });
      return;
    }
    const projectName = folder.split(/[\\/]/).filter(Boolean).at(-1) ?? i18n.t("新项目");
    try {
      const created = await host.request("projects.create", { name: projectName, root: folder, roots: [folder] });
      await refresh();
      setProjectlessDraft(false);
      navigateTo({ projectId: created.id, sessionId: null, nav: "home" });
      setNotice(i18n.t("项目已添加"));
      window.setTimeout(() => setNotice(null), 2400);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  openFolderActionRef.current = () => { void openFolderFromMenu(); };

  const removeProject = async () => {
    if (!removeProjectConfirmId) return;
    const project = snapshot.projects.find((item) => item.id === removeProjectConfirmId);
    if (!project) return;
    setProjectBusy(true); setError(null);
    try {
      await host.request("projects.remove", { projectId: project.id });
      const next = await refresh();
      if (selectedProjectId === project.id) navigateTo({ projectId: next.projects[0]?.id ?? null, sessionId: null, nav: "home" });
      setPinnedProjectIds((current) => {
        const updated = current.filter((id) => id !== project.id);
        try { window.localStorage.setItem(pinnedProjectIdsKey, JSON.stringify(updated)); } catch { /* Keep the current in-memory state if storage is unavailable. */ }
        return updated;
      });
      setRemoveProjectConfirmId(null); setProjectDialogOpen(false); setProjectEditId(null); setProjectFolders([]); setProjectName("");
      setNotice(i18n.t("项目已从 Vagus 移除")); window.setTimeout(() => setNotice(null), 2400);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setProjectBusy(false); }
  };

  const openSession = async (session: WorkspaceSession) => {
    setSessionImportOpen(false);
    navigateTo({ projectId: session.projectId, sessionId: session.id, nav: "home" }); setSearchOpen(false); setError(null);
  };

  const branchSession = async (sessionId: string, messageId?: string) => {
    if (branchingMessageId) return false;
    setSessionActionTooltip(null);
    setError(null);
    setBranchingMessageId(messageId ?? sessionId);
    try {
      const branched = await host.request("sessions.branch", { sessionId, ...(messageId ? { messageId } : {}) });
      setSnapshot((current) => ({ ...current, sessions: [summaryOnly(branched), ...current.sessions.filter((item) => item.id !== branched.id)] }));
      await openSession(branched);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : i18n.t("创建分支会话失败"));
      return false;
    } finally {
      setBranchingMessageId(null);
    }
  };

  const branchFromAssistantMessage = (message: ChatMessage) => selectedSessionId
    ? branchSession(selectedSessionId, message.id)
    : Promise.resolve();

  const addComposerAttachments = (files: File[]) => {
    if (!files.length) return;
    const supportsArbitraryFiles = (selectedSession ? selectedSessionProvider : selectedDraftProvider)?.id === "opencode";
    if (composerAttachments.length + files.length > 4) { setError(i18n.t("一次最多添加 4 个附件")); return; }
    if (!supportsArbitraryFiles && files.some((file) => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type))) { setError(i18n.t("目前支持 PNG、JPEG、WebP 和 GIF 图片")); return; }
    if (files.some((file) => file.size > 4 * 1024 * 1024)) { setError(i18n.t("单个附件不能超过 4 MB")); return; }
    if (composerAttachments.reduce((sum, item) => sum + item.size, 0) + files.reduce((sum, file) => sum + file.size, 0) > 5 * 1024 * 1024) { setError(i18n.t("附件总大小不能超过 5 MB")); return; }
    const namedFiles = files.map((file, index) => file.name ? file : new File([file], `clipboard-image-${index + 1}.${file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1] || "png"}`, { type: file.type }));
    void Promise.all(namedFiles.map(readMessageAttachment)).then((items) => setComposerAttachments((current) => [...current, ...items])).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const handleComposerPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const itemFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .flatMap((item) => {
        const file = item.getAsFile();
        return file ? [file] : [];
      });
    const files = itemFiles.length ? itemFiles : Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    if (!activeProviderSupportsAttachments) { setError(i18n.t("当前 Agent 不支持图片附件")); return; }
    addComposerAttachments(files);
  };

  const sendMessage = async (override?: { text: string; attachments: MessageAttachment[]; browserElements?: BrowserElementReference[] }, explicitDeliveryMode?: "immediate" | "steer" | "follow-up"): Promise<boolean> => {
    const text = (override?.text ?? composer).trim();
    const attachments = override?.attachments ?? composerAttachments;
    const browserElements = override?.browserElements ?? composerBrowserElements;
    const keepComposerDraft = override !== undefined;
    const currentSessionSendPending = selectedSessionId
      ? busySessionIdsRef.current.has(selectedSessionId)
      : busy;
    const pauseGoalWhileRunning = Boolean(selectedSessionId && selectedSessionProvider?.id === "codex" && /^\/goal\s+pause$/iu.test(text) && currentSessionSendPending);
    if (pauseGoalWhileRunning && selectedSessionId) {
      setSlashMenuOpen(false);
      if (attachments.length || browserElements.length) {
        setError(i18n.t("此指令不支持图片或网页元素附件，请先移除附件"));
        return false;
      }
      try {
        await host.request("sessions.execute-command", { sessionId: selectedSessionId, action: "goal", input: "pause" });
        if (!keepComposerDraft) setComposer("", selectedSessionId);
        return true;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return false;
      }
    }
    if ((!text && attachments.length === 0 && browserElements.length === 0) || currentSessionSendPending || hasActiveCustomUi) return false;
    if (selectedSessionId && compactingSessionIds.has(selectedSessionId)) return false;
    if (!selectedSessionId) {
      if (!selectedProjectId && !projectlessDraft) { startProjectCreate(); return false; }
      if (!selectedDraftProvider) { setError(i18n.t("当前没有已启用且健康的 Agent，请到设置中检查提供方状态。")); return false; }
    }
    setSlashMenuOpen(false);
    let activeId = selectedSessionId;
    let createdForThisSend = false;
    const initiallyRunning = Boolean(activeId && (snapshot.sessions.find((session) => session.id === activeId)?.state === "running" || busyState));
    // Commands may open a panel; queued inputs become history only when consumed.
    const clientMessageId = !text.startsWith("/") && !initiallyRunning ? crypto.randomUUID() : undefined;
    const failMessagePreview = () => {
      if (!clientMessageId) return;
      updateMessagePreviews((current) => current.map((preview) => preview.message.id === clientMessageId && !preview.confirmedMessageId ? { ...preview, message: { ...preview.message, deliveryState: "failed" } } : preview));
    };
    if (clientMessageId) {
      beginTimelineFollow();
      updateMessagePreviews((current) => [
        ...current.filter((preview) => !(preview.sessionId === activeId && preview.projectId === selectedProjectId && preview.message.deliveryState === "failed" && preview.message.text === text && (preview.message.attachments?.length ?? 0) === attachments.length && attachments.every((attachment, index) => attachment.dataUrl === preview.message.attachments?.[index]?.dataUrl))),
        { sessionId: activeId, projectId: selectedProjectId, message: { id: clientMessageId, role: "user", text, attachments, browserElements, complete: false, order: activeId ? timelineOrderRef.current : 0, occurredAt: new Date().toISOString(), deliveryState: "sending" } },
      ]);
      if (!keepComposerDraft) { setComposer("", activeId); setComposerAttachments([]); setComposerBrowserElements([]); }
    }
    if (!activeId) {
      setError(null); setBusy(true); setCreatingSession(true);
      try {
        const selection = draftSessionSelection?.providerId === selectedDraftProvider!.id ? draftSessionSelection : null;
        const created = await host.request("sessions.create", {
          projectId: selectedProjectId,
          providerId: selectedDraftProvider!.id,
          ...(hostCapabilities.sessionModelSelection && selection?.modelId ? {
            modelId: selection.modelId,
            ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
            ...(selection.modeId ? { modeId: selection.modeId } : {}),
          } : {}),
        });
        rememberLastCreatedProvider(selectedDraftProvider!.id);
        activeId = created.id;
        createdForThisSend = true;
        if (clientMessageId) updateMessagePreviews((current) => current.map((preview) => preview.message.id === clientMessageId ? { ...preview, sessionId: created.id } : preview));
        skipSessionHydrationRef.current = created.id;
        selectedSessionRef.current = created.id;
        setSnapshot((current) => ({ ...current, sessions: uniqueSessions([summaryOnly(created), ...current.sessions]) }));
        navigateTo({ projectId: selectedProjectId, sessionId: created.id, nav: "home" }); setMessages([]); setActivities([]); setStatuses([]); setPlans([]); setTurnDiffs([]);
        lastConversationProjectIdRef.current = selectedProjectId;
        if (selectedProjectId) saveLastConversationProjectId(selectedProjectId);
        else clearLastConversationProjectId();
      } catch (reason) {
        failMessagePreview();
        setError(reason instanceof Error ? reason.message : String(reason));
        if (clientMessageId && !keepComposerDraft) { setComposer(text, null); if (!selectedSessionRef.current) setComposerAttachments(attachments); }
        setBusy(false); setCreatingSession(false); return false;
      }
      setBusy(false); setCreatingSession(false);
    }
    if (!activeId) return false;
    if (compactingSessionIds.has(activeId)) return false;
    if (busySessionIdsRef.current.has(activeId)) return false;
    const targetSession = snapshot.sessions.find((session) => session.id === activeId);
    const agentIsRunning = busySessionIdsRef.current.has(activeId) || targetSession?.state === "running" || (activeId === selectedSessionId && busyState);
    const deliveryMode = explicitDeliveryMode ?? (agentIsRunning ? queuedDeliveryMode : "immediate");
    busySessionIdsRef.current.add(activeId);
    setBusySessionIds(new Set(busySessionIdsRef.current));
    setError(null);
    let compactCommand = false;
    let chatStarted = false;
    try {
      // New providers can emit the first user-message deltas synchronously
      // from sessions.send. High-frequency deltas are routed only to the
      // subscribed client, so don't race the React subscription effect.
      if (createdForThisSend && selectedSessionRef.current === activeId) {
        await host.request("sessions.subscribe", { sessionId: activeId });
      }
      const inputCommand = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
      if (inputCommand) {
        let command: AgentCommandInfo | undefined;
        if (hostCapabilities.sessionCommands && selectedSessionSupportsCommands) {
          const commands = commandCacheRef.current.get(activeId)
            ?? await host.request("sessions.get-commands", { sessionId: activeId });
          commandCacheRef.current.set(activeId, commands);
          command = commands.find((item) => item.name === inputCommand[1]);
        }
        if (command?.action === "compact") {
          if (!selectedSessionSupportsContext) throw new Error(i18n.t("当前 Agent 不支持手动压缩上下文"));
          if (agentIsRunning || targetSession?.state === "starting") throw new Error(i18n.t("请等待当前回复完成后再压缩上下文"));
          if (attachments.length) throw new Error(i18n.t("压缩指令不支持图片附件，请先移除附件"));
          compactCommand = true;
          setCompactingSessionIds((current) => new Set(current).add(activeId));
          if (!keepComposerDraft) { setComposer("", activeId); if (!selectedSessionId) setComposer("", null); }
          const result = await host.request("sessions.compact", {
            sessionId: activeId, ...(inputCommand[2]?.trim() ? { instructions: inputCommand[2].trim() } : {}),
          }, 0);
          if (result.usage) setSnapshot((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === activeId ? { ...session, usage: result.usage! } : session) }));
          return true;
        }
        if (command?.action === "fork") {
          if (agentIsRunning || targetSession?.state === "starting") throw new Error(i18n.t("请等待当前回复完成后再创建分支"));
          if (attachments.length || browserElements.length) throw new Error(i18n.t("此指令不支持图片或网页元素附件，请先移除附件"));
          if (!keepComposerDraft) { setComposer("", activeId); if (!selectedSessionId) setComposer("", null); }
          return await branchSession(activeId);
        }
        if (command?.action) {
          if (agentIsRunning || targetSession?.state === "starting") throw new Error(i18n.t("请等待当前回复完成后再执行此命令"));
          if (attachments.length || browserElements.length) throw new Error(i18n.t("此指令不支持图片或网页元素附件，请先移除附件"));
          if (!keepComposerDraft) { setComposer("", activeId); if (!selectedSessionId) setComposer("", null); }
          await host.request("sessions.execute-command", {
            sessionId: activeId,
            action: command.action,
            input: inputCommand[2]?.trim() ?? "",
          });
          return true;
        }
        // Codex has no native slash-command discovery API. Only commands
        // explicitly mapped by this Provider may run; never leak an unknown
        // slash command into the model as ordinary chat text.
        if (selectedSessionProvider?.id === "codex") {
          throw new Error(i18n.t("此 Codex 指令尚未接入 Vagus，未发送消息"));
        }
      }
      beginTimelineFollow();
      chatStarted = true;
      setBusyState(true);
      if (!keepComposerDraft && !clientMessageId) { setComposer("", activeId); if (!selectedSessionId) setComposer("", null); setComposerAttachments([]); setComposerBrowserElements([]); }
      const result = await host.request("sessions.send", { sessionId: activeId, text, attachments, browserElements, deliveryMode, ...(clientMessageId ? { clientMessageId } : {}) }, 0);
      if (clientMessageId && (result.disposition === "handled" || result.disposition === "queued")) updateMessagePreviews((current) => current.filter((preview) => preview.message.id !== clientMessageId));
      if (result.disposition === "handled" && !agentIsRunning && selectedSessionRef.current === activeId) setBusyState(false);
    }
    catch (reason) {
      failMessagePreview();
      setError(reason instanceof Error ? reason.message : String(reason));
      if (chatStarted) setBusyState(false);
      if (!keepComposerDraft) { setComposer(text, activeId); if (selectedSessionRef.current === activeId) { setComposerAttachments(attachments); setComposerBrowserElements(browserElements); } }
      return false;
    }
    finally {
      busySessionIdsRef.current.delete(activeId);
      setBusySessionIds(new Set(busySessionIdsRef.current));
      if (compactCommand) setCompactingSessionIds((current) => { const next = new Set(current); next.delete(activeId); return next; });
    }
    return true;
  };

  const updateComposerText = (value: string) => {
    setComposer(value);
    setSlashCommandIndex(0);
    const match = /^\/([^\s]*)$/.exec(value.trimStart());
    if (!selectedSessionId || !hostCapabilities.sessionCommands || !selectedSessionSupportsCommands || !match) {
      setSlashMenuOpen(false);
      return;
    }
    setSlashMenuOpen(true);
    const cached = commandCacheRef.current.get(selectedSessionId);
    if (cached) {
      setSlashCommands(cached);
      return;
    }
    const requestSessionId = selectedSessionId;
    setSlashCommands([]);
    if (commandRequestRef.current.has(requestSessionId)) return;
    commandRequestRef.current.add(requestSessionId);
    const updateVersionAtRequest = commandUpdateVersionRef.current.get(requestSessionId) ?? 0;
    void host.request("sessions.get-commands", { sessionId: requestSessionId })
      .then((commands) => {
        const latestUpdateVersion = commandUpdateVersionRef.current.get(requestSessionId) ?? 0;
        const effectiveCommands = latestUpdateVersion !== updateVersionAtRequest
          ? commandCacheRef.current.get(requestSessionId) ?? commands
          : commands;
        if (latestUpdateVersion === updateVersionAtRequest) commandCacheRef.current.set(requestSessionId, commands);
        if (selectedSessionRef.current === requestSessionId) setSlashCommands(effectiveCommands);
      })
      .catch(() => {
        if (selectedSessionRef.current === requestSessionId) setSlashCommands([]);
      }).finally(() => commandRequestRef.current.delete(requestSessionId));
  };

  const matchingSlashCommands = slashMenuOpen
    ? slashCommands
      .filter((command) => command.name.toLowerCase().startsWith(composer.trimStart().slice(1).toLowerCase()))
      .sort((left, right) => COMMAND_SOURCE_ORDER[left.source] - COMMAND_SOURCE_ORDER[right.source])
    : [];
  const slashMenuVisible = slashMenuOpen && (matchingSlashCommands.length > 0 || Boolean(selectedSessionId && commandRequestRef.current.has(selectedSessionId)));
  const activeSlashCommandIndex = Math.min(slashCommandIndex, Math.max(0, matchingSlashCommands.length - 1));
  const activeSlashCommandId = slashMenuVisible && matchingSlashCommands.length > 0 ? `${slashMenuId}-option-${activeSlashCommandIndex}` : undefined;
  useLayoutEffect(() => {
    const menu = slashMenuRef.current;
    const option = activeSlashCommandId ? document.getElementById(activeSlashCommandId) : null;
    if (!menu || !option) return;
    const menuBounds = menu.getBoundingClientRect();
    const optionBounds = option.getBoundingClientRect();
    if (optionBounds.top < menuBounds.top + 5) menu.scrollTop -= menuBounds.top + 5 - optionBounds.top;
    else if (optionBounds.bottom > menuBounds.bottom - 5) menu.scrollTop += optionBounds.bottom - (menuBounds.bottom - 5);
  }, [activeSlashCommandId, composer, slashCommands]);
  const insertSlashCommand = (command: AgentCommandInfo) => {
    setComposer(`/${command.name} `);
    setSlashMenuOpen(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  };
  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter" && event.repeat) { event.preventDefault(); return; }
    if (slashMenuVisible) {
      if (event.key === "Escape") {
        event.preventDefault(); setSlashMenuOpen(false); return;
      }
      if (!event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          if (matchingSlashCommands.length) {
            const direction = event.key === "ArrowDown" ? 1 : -1;
            setSlashCommandIndex((activeSlashCommandIndex + direction + matchingSlashCommands.length) % matchingSlashCommands.length);
          }
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const command = matchingSlashCommands[activeSlashCommandIndex];
          if (command) insertSlashCommand(command);
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
  };

  const resendEditedMessage = async () => {
    if (!editingUserMessage) return;
    const sent = await sendMessage({ text: editingUserMessage.text, attachments: editingUserMessage.attachments ?? [], browserElements: editingUserMessage.browserElements });
    if (sent) setEditingUserMessage(null);
  };

  const pauseGoalInput = selectedSessionProvider?.id === "codex" && /^\/goal\s+pause$/iu.test(composer.trim());
  const goal = selectedSession?.providerId === "codex" ? selectedSession.runtimeSettings?.goal : null;
  const changeGoalStatus = async (action: "pause" | "resume") => {
    if (!selectedSessionId || goalActionBusy) return;
    setGoalActionBusy(true);
    try { await host.request("sessions.execute-command", { sessionId: selectedSessionId, action: "goal", input: action }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setGoalActionBusy(false); }
  };
  const deleteGoal = async () => {
    if (!selectedSessionId || goalDeleteBusy) return;
    setGoalDeleteBusy(true);
    setGoalDeleteError(null);
    try {
      await host.request("sessions.execute-command", { sessionId: selectedSessionId, action: "goal", input: "clear" });
      setGoalDeleteOpen(false);
    } catch (reason) { setGoalDeleteError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setGoalDeleteBusy(false); }
  };
  const cancelRun = async () => {
    if (pauseGoalInput) { await sendMessage(); return; }
    if (!selectedSessionId) return;
    try { await host.request("sessions.cancel", { sessionId: selectedSessionId }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const cancelSubagent = async (subagentSessionId: string) => {
    if (!selectedSessionId) return;
    try { await host.request("sessions.cancel-subagent", { sessionId: selectedSessionId, subagentSessionId }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const clearSessionQueue = async () => {
    if (!selectedSessionId) return;
    try {
      await host.request("sessions.clear-queue", { sessionId: selectedSessionId });
    } catch (reason) { setError(reason instanceof Error ? reason.message : i18n.t("清空待处理消息失败")); }
  };

  const respondInteraction = async (interactionId: string, value: string | boolean | null) => {
    if (!selectedSessionId) return;
    setInteractionBusyId(interactionId);
    try { await host.request("interactions.respond", { sessionId: selectedSessionId, interactionId, value }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setInteractionBusyId(null); }
  };

  const resizeStart = (event: ReactMouseEvent) => {
    if (sidebarRef.current) delete sidebarRef.current.dataset.userWidthMotion;
    resizing.current = true;
    setIsResizingSidebar(true);
    clearHoverCards();
    setSessionActionTooltip(null);
    event.preventDefault();
  };
  useEffect(() => {
    const move = (event: MouseEvent) => { if (resizing.current) setSidebarWidth(Math.min(440, Math.max(240, event.clientX - (sidebarCollapsed ? 56 : 56)))); };
    const up = () => { resizing.current = false; setIsResizingSidebar(false); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up); window.addEventListener("blur", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); window.removeEventListener("blur", up); };
  }, [sidebarCollapsed]);

  const runWindowAction = (action: () => Promise<unknown>) => {
    void action().catch((reason: unknown) => setError(`${i18n.t("窗口操作失败")}: ${reason instanceof Error ? reason.message : String(reason)}`));
  };
  const runComposerEdit = async (command: "undo" | "redo" | "cut" | "copy" | "paste" | "delete" | "select-all") => {
    setEditMenuOpen(false);
    const target = editMenuTargetRef.current ?? composerRef.current;
    if (!target) return;
    target.focus({ preventScroll: true });
    if (command === "select-all") { target.select(); return; }
    if (command === "paste") {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      try {
        const text = await navigator.clipboard.readText();
        target.focus({ preventScroll: true });
        target.setRangeText(text, start, end, "end");
        target.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (reason) { setError(reason instanceof Error ? reason.message : i18n.t("无法访问剪贴板")); }
      return;
    }
    if (command === "cut" || command === "copy") {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      if (end <= start) return;
      try {
        await writeClipboardText(target.value.slice(start, end));
        if (command === "cut") {
          target.focus({ preventScroll: true });
          target.setRangeText("", start, end, "end");
          target.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } catch (reason) { setError(reason instanceof Error ? reason.message : i18n.t("无法访问剪贴板")); }
      return;
    }
    if (command === "delete") {
      const start = target.selectionStart ?? target.value.length;
      const selectionEnd = target.selectionEnd ?? start;
      const end = selectionEnd > start ? selectionEnd : Math.min(target.value.length, start + 1);
      target.setRangeText("", start, end, "end");
      target.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    document.execCommand(command);
  };
  const startWindowResize = (event: ReactMouseEvent<HTMLDivElement>, direction: "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West") => {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startResizeDragging(direction).catch((reason: unknown) => setError(`${i18n.t("窗口缩放失败")}: ${reason instanceof Error ? reason.message : String(reason)}`));
  };
  const toggleWindowMaximize = async () => {
    const appWindow = getCurrentWindow();
    await appWindow.toggleMaximize();
    setMaximized(await appWindow.isMaximized());
  };

  void navigationVersion;
  const railSettingsButton = <button className={`rail-button${settingsOpen ? " active" : ""}`} title="" aria-label={i18n.t("打开设置")} aria-current={settingsOpen ? "page" : undefined} onMouseEnter={(event) => showSessionActionTooltip(event, "打开设置", shortcutLabel(shortcuts["open-settings"]), "right")} onMouseLeave={() => setSessionActionTooltip(null)} onClick={() => { setSessionActionTooltip(null); openSettingsView(); }}><Settings size={19} /></button>;
  return <div className={`app-shell ${startingApp ? "is-starting" : ""} ${isResizingSidebar ? "is-resizing-sidebar" : ""} ${maximized ? "is-maximized" : ""} ${fullscreen ? "is-fullscreen" : ""}`} onContextMenu={(event) => event.preventDefault()}>
    {!fullscreen && <div className="window-resize-edges" aria-hidden="true">{(["North", "South", "East", "West", "NorthWest", "NorthEast", "SouthWest", "SouthEast"] as const).map((direction) => <div key={direction} className={`window-resize-edge ${direction.toLowerCase()}`} onMouseDown={(event) => startWindowResize(event, direction)} />)}</div>}
    <header className="titlebar">
      <div className="titlebar-history">
        <button className="titlebar-button" title="" aria-label={i18n.t("后退")} disabled={!settingsOpen && !canGoBack} onMouseEnter={(event) => showSessionActionTooltip(event, "后退", shortcutLabel(shortcuts["go-back"]))} onMouseLeave={() => setSessionActionTooltip(null)} onClick={goBack}><ArrowLeft size={17} /></button>
        <button className="titlebar-button" title="" aria-label={i18n.t("前进")} disabled={settingsOpen || (!settingsForwardAvailable && !canGoForward)} onMouseEnter={(event) => showSessionActionTooltip(event, "前进", shortcutLabel(shortcuts["go-forward"]))} onMouseLeave={() => setSessionActionTooltip(null)} onClick={goForward}><ArrowRight size={17} /></button>
        {!settingsOpen && nav !== "scheduled" && <button className="titlebar-button" title="" aria-label={i18n.t("显示或隐藏侧边栏")} onMouseEnter={(event) => showSessionActionTooltip(event, "显示/隐藏侧边栏", shortcutLabel(shortcuts["toggle-sidebar"]))} onMouseLeave={() => setSessionActionTooltip(null)} onClick={() => { setSessionActionTooltip(null); toggleSidebar(); }}>{sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>}
      </div>
      <nav className="titlebar-menus" aria-label={i18n.t("应用菜单")}>
        <div className="titlebar-menu-wrap">
          <button className={`titlebar-menu-button ${fileMenuOpen ? "is-open" : ""}`} aria-expanded={fileMenuOpen} onMouseEnter={() => hoverTopMenu("file")} onClick={() => clickTopMenu("file")}>{i18n.t("文件")}</button>
          {fileMenuOpen && <><div className="titlebar-edit-menu titlebar-file-menu">
            <button onClick={() => { setFileMenuOpen(false); runWindowAction(() => invoke("open_workspace_window")); }}><span>{i18n.t("新建窗口")}</span></button>
            <button onClick={() => { setFileMenuOpen(false); setSettingsOpen(false); setSettingsForwardAvailable(false); startNewChatRef.current?.(); }}><span>{i18n.t("新聊天")}</span>{shortcuts["new-chat"] && <kbd>{shortcutLabel(shortcuts["new-chat"])}</kbd>}</button>
            <button onClick={() => { setFileMenuOpen(false); openFolderActionRef.current(); }}><span>{i18n.t("打开文件夹")}</span>{shortcuts["open-folder"] && <kbd>{shortcutLabel(shortcuts["open-folder"])}</kbd>}</button>
            <div className="titlebar-menu-separator" />
            <button onClick={() => { setFileMenuOpen(false); runWindowAction(() => getCurrentWindow().close()); }}><span>{i18n.t("关闭")}</span>{shortcuts["close-window"] && <kbd>{shortcutLabel(shortcuts["close-window"])}</kbd>}</button>
          </div></>}
        </div>
        <div className="titlebar-menu-wrap">
          <button className={`titlebar-menu-button ${editMenuOpen ? "is-open" : ""}`} aria-expanded={editMenuOpen} onMouseDown={() => {
            const active = document.activeElement;
            editMenuTargetRef.current = active instanceof HTMLTextAreaElement
              || (active instanceof HTMLInputElement && ["text", "search", "url", "tel", "password"].includes(active.type))
              ? active
              : composerRef.current;
          }} onMouseEnter={() => hoverTopMenu("edit")} onClick={() => clickTopMenu("edit")}>{i18n.t("编辑")}</button>
          {editMenuOpen && <><div className="titlebar-edit-menu">
            <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runComposerEdit("undo")}><span>{i18n.t("撤销")}</span><kbd>Ctrl+Z</kbd></button>
            <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runComposerEdit("redo")}><span>{i18n.t("重做")}</span><kbd>Ctrl+Y</kbd></button>
            <div className="titlebar-menu-separator" />
            <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runComposerEdit("cut")}><span>{i18n.t("剪切")}</span><kbd>Ctrl+X</kbd></button>
            <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runComposerEdit("copy")}><span>{i18n.t("复制")}</span><kbd>Ctrl+C</kbd></button>
            <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runComposerEdit("paste")}><span>{i18n.t("粘贴")}</span><kbd>Ctrl+V</kbd></button>
            <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runComposerEdit("delete")}><span>{i18n.t("删除")}</span></button>
            <div className="titlebar-menu-separator" />
            <button onMouseDown={(event) => event.preventDefault()} onClick={() => void runComposerEdit("select-all")}><span>{i18n.t("全选")}</span><kbd>Ctrl+A</kbd></button>
            <div className="titlebar-menu-separator" />
            <button onMouseDown={(event) => event.preventDefault()} onClick={() => openSettingsView()}><span>{i18n.t("设置")}</span>{shortcuts["open-settings"] && <kbd>{shortcutLabel(shortcuts["open-settings"])}</kbd>}</button>
          </div></>}
        </div>
        <div className="titlebar-menu-wrap">
          <button className={`titlebar-menu-button ${viewMenuOpen ? "is-open" : ""}`} aria-expanded={viewMenuOpen} onMouseEnter={() => hoverTopMenu("view")} onClick={() => clickTopMenu("view")}>{i18n.t("视图")}</button>
          {viewMenuOpen && <><div className="titlebar-edit-menu titlebar-view-menu">
            {nav !== "scheduled" && <button onClick={() => { setViewMenuOpen(false); toggleSidebar(); }}><span>{i18n.t("显示/隐藏侧边栏")}</span><kbd>{shortcutLabel(shortcuts["toggle-sidebar"])}</kbd></button>}
            <button disabled={!selectedSessionId} onClick={() => { setViewMenuOpen(false); toggleWorkspaceRightPanel(); }}><span>{i18n.t("显示/隐藏右侧栏")}</span>{shortcuts["toggle-right-panel"] && <kbd>{shortcutLabel(shortcuts["toggle-right-panel"])}</kbd>}</button>
            <div className="titlebar-menu-separator" />
            <button disabled={!selectedSessionId} onClick={() => { setViewMenuOpen(false); openWorkspaceTab("terminal"); }}><span>{i18n.t("打开终端")}</span></button>
            <div className={`titlebar-menu-submenu${viewBrowserSubmenuOpen ? " is-open" : ""}`}>
              <button aria-haspopup="true" aria-expanded={viewBrowserSubmenuOpen} onClick={() => setViewBrowserSubmenuOpen((open) => !open)}><span>{i18n.t("浏览器")}</span><ChevronRight size={15} /></button>
              <div className="titlebar-menu-submenu-panel">
                <button disabled={!selectedSessionId} onClick={() => { setViewMenuOpen(false); openWorkspaceTab("browser"); }}><span>{i18n.t("新建浏览器标签")}</span></button>
                {workspaceViews.items.filter((item) => item.id.startsWith("browser-")).map((item) => <button key={item.id} onClick={() => { setViewMenuOpen(false); workspaceViews.selectTab(item.id); }}><span className="titlebar-menu-item-truncate">{item.title}</span></button>)}
              </div>
            </div>
            <div className="titlebar-menu-separator" />
            <button disabled={!canGoBack && !(settingsOpen)} onClick={() => { setViewMenuOpen(false); goBack(); }}><span>{i18n.t("后退")}</span><kbd>{shortcutLabel(shortcuts["go-back"])}</kbd></button>
            <button disabled={settingsOpen || !settingsForwardAvailable && !canGoForward} onClick={() => { setViewMenuOpen(false); goForward(); }}><span>{i18n.t("前进")}</span><kbd>{shortcutLabel(shortcuts["go-forward"])}</kbd></button>
            <div className="titlebar-menu-separator" />
            <button onClick={() => { setViewMenuOpen(false); runWindowAction(toggleFullscreen); }}><span>{i18n.t(fullscreen ? "退出全屏" : "进入全屏")}</span><kbd>{shortcutLabel(shortcuts["toggle-fullscreen"])}</kbd></button>
          </div></>}
        </div>
        <div className="titlebar-menu-wrap">
          <button className={`titlebar-menu-button ${helpMenuOpen ? "is-open" : ""}`} aria-expanded={helpMenuOpen} onMouseEnter={() => hoverTopMenu("help")} onClick={() => clickTopMenu("help")}>{i18n.t("帮助")}</button>
          {helpMenuOpen && <><div className="titlebar-edit-menu titlebar-help-menu">
            <button onClick={() => { setHelpMenuOpen(false); setNotice(i18n.t("当前已是最新版本")); window.setTimeout(() => setNotice(null), 2400); }}><span>{i18n.t("检查更新")}</span></button>
          </div></>}
        </div>
        {anyTopMenuOpen && <button className="titlebar-menu-dismiss" aria-label={i18n.t("关闭菜单")} onClick={closeTopMenus} />}
      </nav>
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="titlebar-window-controls">
        <button className="window-control" title={i18n.t("最小化")} aria-label={i18n.t("最小化")} onClick={() => runWindowAction(() => getCurrentWindow().minimize())}><Minus size={15} /></button>
        <button className="window-control" title={maximized ? i18n.t("还原") : i18n.t("最大化")} aria-label={maximized ? i18n.t("还原") : i18n.t("最大化")} onClick={() => runWindowAction(toggleWindowMaximize)}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button>
        <button className="window-control close" title={i18n.t("关闭")} aria-label={i18n.t("关闭")} onClick={() => runWindowAction(() => getCurrentWindow().close())}><X size={16} /></button>
      </div>
    </header>
    <div className={`app-frame${nav === "scheduled" ? " is-scheduled" : ""}${settingsOpen ? " is-settings-open" : ""}`}>
      {settingsOpen && <div className="settings-view-overlay">
        <aside className="rail" aria-label={i18n.t("主导航")}>
          <button className="rail-button" title="" aria-label={i18n.t("首页")} onMouseEnter={(event) => showSessionActionTooltip(event, "首页", undefined, "right")} onMouseLeave={() => setSessionActionTooltip(null)} onClick={() => { setSessionActionTooltip(null); setSettingsOpen(false); }}><Home size={19} /></button>
          <button className={`rail-button ${nav === "scheduled" ? "active" : ""}`} title="" aria-label={i18n.t("定时任务")} onMouseEnter={(event) => showSessionActionTooltip(event, "定时任务", undefined, "right")} onMouseLeave={() => setSessionActionTooltip(null)} onClick={() => { setSessionActionTooltip(null); setSettingsOpen(false); navigateTo({ projectId: selectedProjectId, sessionId: selectedSessionId, nav: "scheduled" }); }}><Clock3 size={19} /></button>
          {railSettingsButton}
          <div className="rail-spacer" />
        </aside>
        <ArchiveSettingsApp initialPage={settingsPageRequest ?? undefined} onViewSession={(session) => { setSettingsOpen(false); void openSession(session); }} />
      </div>}
      <>
        <aside className="rail" inert={settingsOpen} aria-label={i18n.t("主导航")}>
          <button className={`rail-button ${nav === "home" ? "active" : ""}`} title="" aria-label={i18n.t("首页")} onMouseEnter={(event) => showSessionActionTooltip(event, "首页", undefined, "right")} onMouseLeave={() => setSessionActionTooltip(null)} onClick={() => { setSessionActionTooltip(null); const homeLocation = lastHomeLocationRef.current; navigateTo({ ...homeLocation, nav: "home" }); }}><Home size={19} /></button>
          <button className={`rail-button ${nav === "scheduled" ? "active" : ""}`} title="" aria-label={i18n.t("定时任务")} onMouseEnter={(event) => showSessionActionTooltip(event, "定时任务", undefined, "right")} onMouseLeave={() => setSessionActionTooltip(null)} onClick={() => { setSessionActionTooltip(null); navigateTo({ projectId: selectedProjectId, sessionId: selectedSessionId, nav: "scheduled" }); }}><Clock3 size={19} /></button>
          {railSettingsButton}
          <div className="rail-spacer" />
        </aside>

        {nav === "scheduled" ? <ScheduledTasksPage host={host} providers={snapshot.providers} projects={snapshot.projects} activeProjectId={selectedProjectId} sidebarWidth={sidebarWidth} sharedConversationMode onActiveTask={handleActiveScheduledTask} onOpenUrl={openMarkdownUrl} onClose={() => {
          navigateTo({ ...lastHomeLocationRef.current, nav: "home" });
        }} onShowTooltip={showSessionActionTooltip} onHideTooltip={() => setSessionActionTooltip(null)} /> : <>
          <WorkspaceSidebar model={{
            sidebarRef, projectsHeadingRef, recentHeadingRef, width: sidebarWidth, collapsed: sidebarCollapsed,
            projects: snapshot.projects, sessions: ordinarySessions, unpinnedProjects, pinnedProjects, pinnedSessions,
            unpinnedSessions: unpinnedProjectSessions,
            recentSessions: sidebarRecentSessions, pinnedSessionIds, pinnedProjectIds, sessionViewedAt,
            selectedProjectId, selectedSessionId, projectMenuId: projectMenu?.projectId, sessionMenuId: sessionMenu?.sessionId,
            draggingSessionId, dragTargetSessionId, draggingProjectId, dragTargetProjectId, expandedProjectSessions, collapsedProjects, creatingSession,
            groupMode, sortMode, projectsSectionCollapsed, recentSectionCollapsed, pinnedSectionCollapsed, importingSessions: sessionImportOpen,
            menuOpen, menuClosing, menuSource, menuTop, menuLeft, popupOpenVersion, popupEnteringVersion,
          }} actions={{
            onOpenSearch: () => { setSessionActionTooltip(null); setSearchOpen(true); }, onGoHome: () => { setSessionImportOpen(false); setNav("home"); },
            onToggleSidebarMenu: toggleSidebarMenu, onOpenSidebarSectionMenu: openSidebarSectionContextMenu,
            onCloseSidebarMenu: closeSidebarMenu, onHandleDismissContextMenu: handleSidebarMenuContextMenu,
            onSetGroupMode: (mode) => { setGroupMode(mode); closeSidebarMenu(); },
            onSetSortMode: (mode) => { setSortMode(mode); try { window.localStorage.setItem("vagus.sidebar.session-sort-mode.v1", mode); } catch { /* Keep the in-memory sort mode if storage is unavailable. */ } closeSidebarMenu(); },
            onToggleSection: (section) => {
              if (section === "projects") setProjectsSectionCollapsed((value) => !value);
              else if (section === "recent") setRecentSectionCollapsed((value) => !value);
              else setPinnedSectionCollapsed((value) => !value);
            },
            onToggleProject: (project) => setCollapsedProjects((current) => current.includes(project.id) ? current.filter((id) => id !== project.id) : [...current, project.id]),
            onToggleProjectSessions: (project) => setExpandedProjectSessions((current) => current.includes(project.id) ? current.filter((id) => id !== project.id) : [...current, project.id]),
            onOpenSession: (session) => void openSession(session), onSessionContextMenu: openSessionContextMenu,
            onProjectContextMenu: openProjectContextMenu, onOpenProjectMenu: openProjectMenu,
            onCreateSession: (projectId) => startNewChat(projectId), onImportSessions: () => { captureHomePagePosition(); closeSidebarMenu(); closeProjectMenu(); closeSessionMenu(); clearHoverCards(); setSearchOpen(false); setSessionImportOpen(true); }, onAddProject: startProjectCreate,
            onShowSessionHover: showSessionHoverCard,
            onShowProjectHover: showProjectHoverCard,
            onHoverLeave: closeSessionHoverCardSoon, onShowTooltip: showSessionActionTooltip,
            onClearTooltip: () => setSessionActionTooltip(null), onToggleSessionPin: toggleSessionPin,
            onArchiveSession: (session) => void archiveSession(session), onSessionPointerDown: beginSessionPointerDrag,
            onSessionPointerMove: moveSessionPointerDrag, onSessionPointerUp: endSessionPointerDrag, onSessionClickCapture: captureSessionClick,
            onProjectPointerDown: beginProjectPointerDrag, onProjectPointerMove: moveProjectPointerDrag,
            onProjectPointerUp: endProjectPointerDrag, onProjectPointerCancel: cancelProjectPointerDrag, onProjectClickCapture: captureProjectClick,
          }} />    {!sidebarCollapsed && <div className="resize-handle" onMouseDown={resizeStart} />}
        </>}
        <div ref={workspacePagesRef} inert={settingsOpen} className={`workspace-pages${workspaceViews.state.fullView && !sessionImportOpen ? " is-full-view" : ""}`}>
          {sessionImportOpen ? <SessionImportPage providers={snapshot.providers} onClose={() => setSessionImportOpen(false)} onScan={scanImportableSessions} onImport={importProviderSession} onImported={async (imported, complete) => {
            const next = await refresh();
            if (!complete || !imported[0]) return;
            const created = next.sessions.find((session) => session.id === imported[0]!.id) ?? imported[0];
            await openSession(created);
          }} /> : nav === "scheduled" && !activeScheduledTask?.sessionId ? <div className="scheduled-no-selection"><CalendarClock size={25} /><strong>{i18n.t(activeScheduledTask ? "正在准备任务会话…" : "选择一个定时任务")}</strong><p>{i18n.t("每个定时任务都有自己的会话与运行记录。")}</p></div> : <>
            {workspaceViews.state.fullView && selectedSession && <WorkspaceViewBar title={selectedSession.title} activeTab={workspaceViews.state.activeTab} items={workspaceViews.items} hasPicker={workspaceViews.state.sideTab === "picker"} onSelectTab={workspaceViews.selectTab} onCloseTab={closeWorkspaceTab} onNewTab={openTabPicker} onExitFullView={workspaceViews.exitFullView} onShowTooltip={showSessionActionTooltip} onHideTooltip={() => setSessionActionTooltip(null)} />}
            <div ref={workspaceViewBodyRef} className={`workspace-view-body${workspaceViews.state.fullView ? " is-full-view" : ""}${workspacePanelRatio === null ? "" : " has-custom-panel-width"}${workspaceViews.viewCount > 1 || (workspaceViews.state.sideTab && !workspaceViews.state.panelHidden) ? " has-wide-view-actions" : ""}`} style={workspacePanelRatio === null ? undefined : { "--workspace-panel-width": `${workspacePanelRatio * 100}%` } as CSSProperties}>
              {!workspaceViews.state.fullView && selectedSession && <ConversationViewActions
                items={workspaceViews.items}
                panelVisible={Boolean(workspaceViews.state.sideTab && !workspaceViews.state.panelHidden)}
                hiddenTabsOpen={hiddenWorkspaceTabsOpen}
                onEnterFullView={workspaceViews.enterFullView}
                onNewTab={openTabPicker}
                onHidePanel={workspaceViews.hideSidePanel}
                onRestoreTabs={() => { setHiddenWorkspaceTabsOpen(false); workspaceViews.showSidePanel(); }}
                onShowHiddenTabs={setHiddenWorkspaceTabsOpen}
                onShowTab={(tab) => { setHiddenWorkspaceTabsOpen(false); workspaceViews.selectTab(tab); }}
                onShowTooltip={showSessionActionTooltip}
                onHideTooltip={() => setSessionActionTooltip(null)}
              />}
              <main id="workspace-chat-panel" className={`main-pane${workspaceViews.state.fullView && workspaceViews.state.activeTab !== "chat" ? " is-background-view" : ""}`} role={workspaceViews.state.fullView ? "tabpanel" : undefined} aria-labelledby={workspaceViews.state.fullView ? "workspace-chat-tab" : undefined} aria-hidden={workspaceViews.state.fullView && workspaceViews.state.activeTab !== "chat" ? true : undefined} inert={workspaceViews.state.fullView && workspaceViews.state.activeTab !== "chat"}>
                <header className={`conversation-header${selectedSession && !workspaceViews.state.fullView && (!workspaceViews.state.sideTab || workspaceViews.state.panelHidden) ? " has-workspace-view-actions" : ""}`}>
                  <div className="current-project"><span className="header-workspace-trigger" role="img" aria-label={headerWorkspaceName} onMouseEnter={(event) => showSessionActionTooltip(event, headerWorkspaceName, undefined, "above")} onMouseLeave={() => setSessionActionTooltip(null)}><Folder size={17} /></span>{selectedSession && <span className="header-session">{truncateSessionTitle(selectedSession.title)}</span>}{nav === "scheduled" && activeScheduledTask && <span className="scheduled-session-label"><Clock3 size={12} aria-hidden="true" />{i18n.t("定时任务")}</span>}{selectedSession && busyState && <span className="session-working-chip" role="status" aria-live="polite"><LoaderCircle size={12} aria-hidden="true" /><span>{i18n.t("工作中")}</span></span>}</div>
                  <div className="conversation-tools">{selectedSession && <button title="" aria-label={i18n.t("更多会话操作")} onMouseEnter={() => setSessionActionTooltip(null)} onClick={(event) => openSessionMenuFromHeader(event, selectedSession)}><Ellipsis size={17} /></button>}</div>
                </header>
                {goal && (goal.status === "active" || goal.status === "paused") && <div className={`goal-status-bar${goal.status === "paused" ? " is-paused" : ""}`} role="status">
                  <Target size={15} aria-hidden="true" />
                  <span className="goal-status-label">{i18n.t(goal.status === "paused" ? "目标已暂停" : "目标进行中")}</span>
                  <span className="goal-status-objective" title={goal.objective}>{goal.objective}</span>
                  <button type="button" className="goal-status-delete" disabled={goalActionBusy || sessionRunning} onClick={() => { setGoalDeleteError(null); setGoalDeleteOpen(true); }} aria-label={i18n.t("删除目标")} title={sessionRunning ? i18n.t("请先暂停当前任务再删除目标") : i18n.t("删除目标")}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                  <button type="button" disabled={goalActionBusy} onClick={() => void changeGoalStatus(goal.status === "paused" ? "resume" : "pause")} aria-label={i18n.t(goal.status === "paused" ? "恢复目标" : "暂停目标")} title={i18n.t(goal.status === "paused" ? "恢复目标" : "暂停目标")}>
                    {goalActionBusy ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : goal.status === "paused" ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
                    <span>{i18n.t(goal.status === "paused" ? "恢复目标" : "暂停目标")}</span>
                  </button>
                </div>}
                <div className="conversation-timeline">
                  <section className={`conversation-body${visibleConversationRows.length > 80 ? " is-virtualized" : ""}${timelineReady ? "" : " is-preparing"}`} aria-busy={!timelineReady} inert={!timelineReady} ref={scrollRef} onClickCapture={preserveTimelineDisclosureAnchor} onScroll={(event) => {
                    if (suppressNextTimelineScrollRef.current) { suppressNextTimelineScrollRef.current = false; return; }
                    const element = event.currentTarget;
                    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
                    if (element.scrollTop < 160 && !followTimelineRef.current && historyHasMore && !historyLoading) void loadOlderHistory();
                    if (userQueryMessages.length > 1) {
                      let activeId = distanceToBottom <= TIMELINE_BOTTOM_THRESHOLD ? userQueryMessages.at(-1)?.id ?? null : userQueryMessages[0]?.id ?? null;
                      if (distanceToBottom > TIMELINE_BOTTOM_THRESHOLD) {
                        const index = virtualConversationRef.current?.getFirstVisibleIndex();
                        const order = index !== null && index !== undefined ? conversationEntries[index]?.order ?? 0 : 0;
                        let low = 0;
                        let high = userQueryMessages.length;
                        while (low < high) { const middle = (low + high) >>> 1; if (userQueryMessages[middle]!.order <= order) low = middle + 1; else high = middle; }
                        activeId = userQueryMessages[Math.max(0, low - 1)]?.id ?? null;
                      }
                      setActiveQueryMessageId((current) => current === activeId ? current : activeId);
                    }
                    if (manualTimelineScrollLockRef.current) {
                      followTimelineRef.current = false;
                      const showJumpButton = conversationEntries.length > 0 && distanceToBottom > TIMELINE_BOTTOM_THRESHOLD;
                      setShowNewActivity((current) => current === showJumpButton ? current : showJumpButton);
                      return;
                    }
                    // Layout and programmatic scrolling also emit scroll events. Only explicit
                    // user navigation ends following; a growing stream must not turn it off.
                    if (followTimelineRef.current) {
                      setShowNewActivity(false);
                      return;
                    }
                    followTimelineRef.current = distanceToBottom <= TIMELINE_BOTTOM_THRESHOLD;
                    const showJumpButton = conversationEntries.length > 0 && distanceToBottom > TIMELINE_BOTTOM_THRESHOLD;
                    setShowNewActivity((current) => current === showJumpButton ? current : showJumpButton);
                  }} tabIndex={0} aria-label={i18n.t("对话历史")} onKeyDownCapture={(event) => {
                    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
                    if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select, [contenteditable="true"], [role="application"]')) return;
                    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) holdTimelineForManualScroll();
                  }} onTouchMoveCapture={holdTimelineForManualScroll} onWheelCapture={(event) => { if (!event.ctrlKey) holdTimelineForManualScroll(); }} onPointerDownCapture={(event) => {
                    if (event.button !== 0) return;
                    const viewport = event.currentTarget;
                    const rect = viewport.getBoundingClientRect();
                    const scrollbarWidth = viewport.offsetWidth - viewport.clientWidth;
                    if (scrollbarWidth > 0 && event.clientX >= rect.right - scrollbarWidth) holdTimelineForManualScroll();
                  }} onPointerMoveCapture={(event) => {
                    if (manualTimelineScrollLockRef.current && event.buttons !== 0) holdTimelineForManualScroll();
                  }} onPointerUpCapture={(event) => {
                    if (manualTimelineScrollLockRef.current && event.button === 0) holdTimelineForManualScroll();
                  }}>
                    {!selectedSessionId && conversationEntries.length === 0 ? <div className="welcome-state new-chat-prompt">
                      <div className={`welcome-mark welcome-mark-logo ${welcomeLogoAnimating ? "is-animating" : ""}`} onMouseEnter={startWelcomeLogoAnimation} onAnimationEnd={finishWelcomeLogoAnimation}><img src="/vagus-logo.png" alt="Vagus" draggable={false} /></div>
                      {selectedProject ? <h1><Trans i18nKey="你想让我们在 <project>{{name}}</project> 中构建什么？" values={{ name: selectedProject.name }} components={{ project: <button className="workspace-name-trigger" aria-haspopup="listbox" aria-expanded={workspacePickerOpen && workspacePickerPlacement === "welcome"} onClick={() => toggleWorkspacePicker("welcome")} /> }} /></h1>
                        : projectlessDraft ? <h1>{i18n.t("你想让我们构建什么？")}</h1>
                          : <><h1>{i18n.t("先添加一个项目文件夹")}</h1><button className="welcome-action" onClick={startProjectCreate}><FolderPlus size={17} />{i18n.t("添加项目文件夹")}</button><button className="workspace-empty-choice" onClick={startProjectlessChat}>{i18n.t("不在项目中工作")}</button></>}
                      {workspacePickerOpen && workspacePickerPlacement === "welcome" && <WorkspacePicker placement="welcome" projects={snapshot.projects} selectedProjectId={projectlessDraft ? null : selectedProjectId} onSelect={(project) => startNewChat(project.id)} onCreateProject={() => { setWorkspacePickerOpen(false); startProjectCreate(); }} onSelectNoProject={startProjectlessChat} onClose={() => setWorkspacePickerOpen(false)} />}
                    </div> : conversationEntries.length === 0 ? historyLoading ? <div className="welcome-state compact-welcome" role="status"><LoaderCircle size={18} /><p>{i18n.t("正在加载会话…")}</p></div> : <div className="welcome-state compact-welcome"><div className="welcome-mark"><MessageSquare size={21} /></div><h1>{i18n.t("有什么可以一起完成？")}</h1><p><Trans i18nKey="Agent 将在 <directory>{{path}}</directory> 中工作。" values={{ path: selectedProject?.root ?? (selectedSession?.projectId === null ? i18n.t("用户主目录") : i18n.t("当前项目文件夹")) }} components={{ directory: <span /> }} /></p></div> : <div className={`conversation-flow-layout${userQueryMessages.length > 1 ? " has-query-nav" : ""}`}>
                      <div className="message-flow">
                        {historyHasMore && <div className="history-loading-row"><button type="button" disabled={historyLoading} onClick={() => { followTimelineRef.current = false; void loadOlderHistory(); }}>{historyLoading ? i18n.t("正在加载…") : i18n.t("加载更早的消息")}</button></div>}
                        <VirtualConversation key={selectedSessionId ?? "draft"} ref={virtualConversationRef} scrollRef={scrollRef} rows={visibleConversationRows} layoutKey={`${selectedSessionId}-${historyHasMore}`} renderRow={(index) => {
                          const entry = conversationEntries[index]!;
                          if (entry.kind === "duration") {
                            const label = formatTurnDuration(entry.startedAt, entry.completedAt, durationNow, entry.active);
                            const expanded = (entry.active ? collapsedActiveTurnId !== entry.turnId : expandedTurnIds.has(entry.turnId)) && turnTransitions[entry.turnId] !== "collapsing";
                            return label ? <div className={`turn-duration${entry.active ? " is-active" : ""}`} key={`duration-${entry.turnId}`} role="status" aria-live={entry.active ? "polite" : undefined}><button type="button" aria-expanded={expanded} onClick={() => toggleTurnExpansion(entry.turnId)}><span>{label}</span>{expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}</button></div> : null;
                          }
                          const duration = entry.value.turnId ? turnDurations.get(entry.value.turnId) : undefined;
                          const turnExpanded = duration && (duration.active ? collapsedActiveTurnId !== duration.turnId : expandedTurnIds.has(duration.turnId));
                          const turnCollapsing = duration && turnTransitions[duration.turnId] === "collapsing";
                          if (duration && !turnExpanded && !turnCollapsing && entry.order > duration.userOrder && !(entry.kind === "message" && entry.value.id === duration.finalAssistantMessageId)) return null;
                          if (entry.kind === "interaction") return decorateTurnProcessEntry(entry, <InteractionCard key={entry.value.id} item={entry.value} connected={connected} busy={interactionBusyId === entry.value.id} onRespond={(value) => void respondInteraction(entry.value.id, value)} />);
                          if (entry.kind === "notice") return decorateTurnProcessEntry(entry, <article key={entry.value.id} className={`conversation-notice is-${entry.value.level}`} role={entry.value.level === "error" ? "alert" : "status"}><span className="conversation-notice-mark"><AlertCircle size={15} /></span><p>{entry.value.message}</p></article>);
                          if (entry.kind === "plan") return decorateTurnProcessEntry(entry, <PlanActivityLine key={entry.value.id} plan={entry.value} />);
                          if (entry.kind === "turnDiff") return duration && !duration.active ? null : decorateTurnProcessEntry(entry, <TurnDiffActivityLine key={entry.value.id} diff={entry.value} active={Boolean(duration?.active)} />);
                          const lastInSequence = !isConversationActivity(conversationEntries[index + 1]);
                          if (entry.kind === "status") return decorateTurnProcessEntry(entry, entry.value.subagentSessionId
                            ? <SubagentActivityLine key={entry.value.id} status={entry.value} lastInSequence={lastInSequence} onCancel={cancelSubagent} />
                            : <ThinkingMarker key={entry.value.id} status={entry.value} active={activeStatusId === entry.value.id} lastInSequence={lastInSequence} />);
                          if (entry.kind === "tool") return decorateTurnProcessEntry(entry, <ToolActivityLine key={entry.value.id} activity={entry.value} lastInSequence={lastInSequence} expanded={expandedActivityIds.has(entry.value.id)} onLoadDeferred={loadDeferredTool} onToggle={() => setExpandedActivityIds((current) => { const next = new Set(current); if (next.has(entry.value.id)) next.delete(entry.value.id); else next.add(entry.value.id); return next; })} />);
                          const message = entry.value;
                          const editing = editingUserMessage?.id === message.id;
                          const canEdit = message.role === "user" && message.id === latestUserMessageId && message.complete && !busyState;
                          const isFinalTurnAnswer = message.role === "assistant" && duration?.finalAssistantMessageId === message.id;
                          const turnDiff = isFinalTurnAnswer ? turnDiffs.find((item) => item.turnId === duration.turnId) : undefined;
                          return <>{decorateTurnProcessEntry(entry, <article data-user-query-id={message.role === "user" ? message.id : undefined} className={`message ${message.role}${editing ? " is-editing" : ""}`} key={message.id}><>
                            {editing ? <div className="user-message-editor">
                              {editingUserMessage.attachments.length > 0 && <div className="user-message-edit-attachments">{editingUserMessage.attachments.map((attachment) => attachment.mimeType.startsWith("image/") ? <img key={attachment.id} src={attachment.dataUrl} alt={attachment.name} title={attachment.name} /> : <span className="user-message-edit-file" key={attachment.id} title={attachment.name}><FileText size={15} />{attachment.name}</span>)}</div>}
                              <textarea ref={editTextareaRef} aria-label={i18n.t("编辑用户消息")} value={editingUserMessage.text} rows={Math.min(6, Math.max(2, editingUserMessage.text.split("\n").length))} disabled={busyState} onChange={(event) => setEditingUserMessage((current) => current ? { ...current, text: event.target.value } : null)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void resendEditedMessage(); } if (event.key === "Escape") setEditingUserMessage(null); }} />
                              <div className="user-message-edit-actions"><button className="user-message-edit-cancel" disabled={busyState} onClick={() => setEditingUserMessage(null)}>{i18n.t("取消")}</button><button className="user-message-edit-send" disabled={busyState || (!editingUserMessage.text.trim() && editingUserMessage.attachments.length === 0 && !editingUserMessage.browserElements?.length)} onClick={() => void resendEditedMessage()}>{busyState ? i18n.t("发送中") : i18n.t("发送")}</button></div>
                            </div> : <MessageContent message={message} onLoadDeferred={loadDeferredMessage} onOpenUrl={openMarkdownUrl} />}
                            {message.role === "user" && !editing && <div className="user-message-meta">{message.occurredAt && <time dateTime={message.occurredAt}>{formatMessageTime(message.occurredAt, relativeTimeNow)}</time>}<button className={copiedMessageId === message.id ? "is-copied" : undefined} aria-label={copiedMessageId === message.id ? i18n.t("消息已复制") : i18n.t("复制用户消息")} onMouseEnter={(event) => showSessionActionTooltip(event, "复制消息", undefined, "above")} onMouseLeave={() => setSessionActionTooltip(null)} onClick={() => { setSessionActionTooltip(null); void writeClipboardText(message.text).then(() => { setCopiedMessageId(message.id); if (copyFeedbackTimerRef.current !== undefined) window.clearTimeout(copyFeedbackTimerRef.current); copyFeedbackTimerRef.current = window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1200); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : i18n.t("复制消息失败"))); }} aria-live="polite">{copiedMessageId === message.id ? <Check size={14} /> : <Copy size={14} />}</button>{canEdit && <button aria-label={i18n.t("编辑并重新发送消息")} onMouseEnter={(event) => showSessionActionTooltip(event, "编辑消息", undefined, "above")} onMouseLeave={() => setSessionActionTooltip(null)} onClick={(event) => { setSessionActionTooltip(null); const messageElement = event.currentTarget.closest<HTMLElement>(".message"); const viewport = scrollRef.current; followTimelineRef.current = false; setShowNewActivity(false); if (messageElement && viewport) pendingEditAnchorRef.current = { viewport, message: messageElement, top: messageElement.getBoundingClientRect().top }; setEditingUserMessage({ id: message.id, text: message.text, attachments: message.attachments ?? [], browserElements: message.browserElements }); }}><Pencil size={14} /></button>}</div>}
                            {message.role === "assistant" && isFinalTurnAnswer && !editing && message.complete && !(busyState && activeTurnId && message.turnId === activeTurnId) && <div className="assistant-message-meta"><button className={copiedMessageId === message.id ? "is-copied" : undefined} aria-label={copiedMessageId === message.id ? i18n.t("消息已复制") : i18n.t("复制助手消息")} onMouseEnter={(event) => showSessionActionTooltip(event, "复制消息", undefined, "above")} onMouseLeave={() => setSessionActionTooltip(null)} onClick={() => { setSessionActionTooltip(null); void writeClipboardText(message.text).then(() => { setCopiedMessageId(message.id); if (copyFeedbackTimerRef.current !== undefined) window.clearTimeout(copyFeedbackTimerRef.current); copyFeedbackTimerRef.current = window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1200); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : i18n.t("复制消息失败"))); }} aria-live="polite">{copiedMessageId === message.id ? <Check size={14} /> : <Copy size={14} />}</button>{selectedSessionSupportsFork && (selectedSessionProvider?.id !== "opencode" || openCodeBranchMessageId === message.id) && <button aria-label={i18n.t("分支到新聊天")} disabled={busyState || branchingMessageId !== null} onMouseEnter={(event) => showSessionActionTooltip(event, "分支到新聊天", undefined, "above")} onMouseLeave={() => setSessionActionTooltip(null)} onClick={() => void branchFromAssistantMessage(message)}>{branchingMessageId === message.id ? <LoaderCircle size={14} /> : <GitBranch size={14} />}</button>}</div>}
                          </></article>)}{isFinalTurnAnswer && duration && <TurnChangesCard key={`turn-changes-${duration.turnId}`} turnId={duration.turnId} diff={turnDiff} activities={activities} onOpenDiff={(files, selectedPath) => openWorkspaceTab("turn-diff", { turnId: duration.turnId, files, selectedPath, truncated: turnDiff?.truncated })} />}</>;
                        }} />
                      </div>
                    </div>}
                  </section>
                  {timelineReady && selectedSessionId && userQueryMessages.length > 1 && <MessageNavigation messages={userQueryMessages} activeId={activeQueryMessageId} onJump={(id) => void jumpToUserQuery(id)} />}
                  {timelineReady && showNewActivity && <button className={`timeline-latest-button${busyState ? " is-working" : ""}`} aria-label={i18n.t("回到对话底部")} onClick={beginTimelineFollow}><ArrowDown className="timeline-jump-arrow" size={18} aria-hidden="true" /><Ellipsis className="timeline-jump-dots" size={22} aria-hidden="true" /></button>}
                  {!timelineReady && <div className="conversation-switch-mask" role="status" aria-live="polite" aria-label={i18n.t("正在载入会话")}><LoaderCircle size={18} aria-hidden="true" /></div>}
                </div>
                {error && <div className="error-banner"><AlertCircle size={16} /><span>{error}</span><button onClick={() => setError(null)}><X size={15} /></button></div>}
                {status && !busyState && <div className="status-strip"><span className="status-indicator" />{status}</div>}
                <div className="composer-wrap">
                  <ExtensionWidgets key={`extensions-${selectedSessionId}`} widgets={extensionUi?.widgets ?? []} stale={!connected} activation={customUiActivation?.sessionId === selectedSessionId ? customUiActivation : null} onInput={(widgetKey, input) => {
                    if (!selectedSessionId) return;
                    void host.request("sessions.ui-input", { sessionId: selectedSessionId, widgetKey, input })
                      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : i18n.t("扩展组件交互失败")));
                  }} />
                  {selectedSession && selectedSessionSupportsQueue && ((selectedSession.queue?.steering.length ?? 0) + (selectedSession.queue?.followUp.length ?? 0) > 0) && <div className="session-queue-panel" aria-label={i18n.t("待处理消息")}>
                    <div className="session-queue-heading"><strong>{i18n.t("待处理消息")}</strong><span>{(selectedSession.queue?.steering.length ?? 0) + (selectedSession.queue?.followUp.length ?? 0)}</span><button type="button" onClick={() => void clearSessionQueue()}>{i18n.t("清空")}</button></div>
                    {(selectedSession.queue?.steering ?? []).map((text, index) => <div className="session-queue-item is-steering" key={`steer-${index}`}><span>{i18n.t("转向")}</span><p>{text}</p></div>)}
                    {(selectedSession.queue?.followUp ?? []).map((text, index) => <div className="session-queue-item" key={`follow-${index}`}><span>{i18n.t("后续")}</span><p>{text}</p></div>)}
                  </div>}
                  {!selectedSessionId && <div className="composer-workspace-row">
                    <div className="composer-workspace-control">
                      <button className="composer-workspace-button" aria-haspopup="listbox" aria-expanded={workspacePickerOpen && workspacePickerPlacement === "composer"} onMouseEnter={(event) => showSessionActionTooltip(event, selectedProject ? i18n.t("更改此聊天的项目") : i18n.t("选择一个项目来运行聊天"), undefined, "above")} onMouseLeave={() => setSessionActionTooltip(null)} onClick={() => toggleWorkspacePicker("composer")}><Folder size={16} /><span>{selectedProject?.name ?? i18n.t("选择项目")}</span><ChevronDown size={14} /></button>
                      {workspacePickerOpen && workspacePickerPlacement === "composer" && <WorkspacePicker placement="composer" projects={snapshot.projects} selectedProjectId={projectlessDraft ? null : selectedProjectId} onSelect={(project) => startNewChat(project.id)} onCreateProject={() => { setWorkspacePickerOpen(false); startProjectCreate(); }} onSelectNoProject={startProjectlessChat} onClose={() => setWorkspacePickerOpen(false)} />}
                    </div>
                    <div className="composer-workspace-divider" />
                    <div className="agent-picker-control" ref={agentPickerRef}>
                      <button className="composer-agent-button" aria-haspopup="listbox" aria-expanded={agentPickerOpen} aria-description={selectedDraftProvider ? i18n.t("选择 Agent 框架") : i18n.t("没有已启用且健康的 Agent")} disabled={!selectedDraftProvider} onClick={() => { setWorkspacePickerOpen(false); setAgentPickerOpen((open) => !open); }}>
                        {selectedDraftProvider?.id === "pi" ? <PiIcon size={17} /> : selectedDraftProvider?.id === "claude" ? <ClaudeIcon size={17} /> : selectedDraftProvider?.id === "codex" ? <CodexIcon size={17} /> : selectedDraftProvider?.id === "opencode" ? <OpenCodeIcon size={17} /> : selectedDraftProvider?.id === "qoder" ? <QoderIcon size={17} /> : selectedDraftProvider?.id === "zcode" ? <ZCodeIcon size={17} /> : <span className="provider-mark">AI</span>}
                        <span>{selectedDraftProvider?.displayName ?? i18n.t("暂无可用 Agent")}</span>
                        <ChevronDown size={13} />
                      </button>
                      {agentPickerOpen && <div className="agent-picker-menu" role="listbox" aria-label={i18n.t("选择 Agent 框架")}>
                        {availableProviders.map((provider) => <button key={provider.id} role="option" aria-selected={selectedDraftProvider?.id === provider.id} className={selectedDraftProvider?.id === provider.id ? "is-selected" : ""} onClick={() => { setSelectedProviderId(provider.id); setAgentPickerOpen(false); }}>
                          {provider.id === "pi" ? <PiIcon size={16} /> : provider.id === "claude" ? <ClaudeIcon size={16} /> : provider.id === "codex" ? <CodexIcon size={16} /> : provider.id === "opencode" ? <OpenCodeIcon size={16} /> : provider.id === "qoder" ? <QoderIcon size={16} /> : provider.id === "zcode" ? <ZCodeIcon size={16} /> : <span className="provider-mark">AI</span>}
                          <span>{provider.displayName}</span>
                          {selectedDraftProvider?.id === provider.id && <Check size={14} />}
                        </button>)}
                      </div>}
                    </div>
                  </div>}
                  <div className="composer">
                    <ExtensionDraftBar suggestion={extensionDraft.suggestion} canUndo={extensionDraft.canUndo} onAccept={(mode) => { extensionDraft.accept(mode); composerRef.current?.focus(); }} onDiscard={extensionDraft.discard} onUndo={() => { extensionDraft.undo(); composerRef.current?.focus(); }} />
                    {composerBrowserElements.length > 0 && <div className="composer-browser-elements"><BrowserElementChip elements={composerBrowserElements} removable onRemove={() => setComposerBrowserElements([])} /></div>}
                    {composerAttachments.length > 0 && <div className="composer-attachments">{composerAttachments.map((attachment) => <div className="composer-attachment" key={attachment.id}>{attachment.mimeType.startsWith("image/") ? <img src={attachment.dataUrl} alt="" /> : <FileText size={19} aria-hidden="true" />}<span>{attachment.name}</span><button aria-label={i18n.t("移除 {{name}}", { name: attachment.name })} onClick={() => setComposerAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={13} /></button></div>)}</div>}
                    {slashMenuVisible && <div ref={slashMenuRef} id={slashMenuId} className="slash-command-menu" role="listbox" aria-label={i18n.t("Agent 命令建议")}>
                      {matchingSlashCommands.length === 0 && <div className="slash-command-loading">{i18n.t("正在读取可用命令…")}</div>}
                      {matchingSlashCommands.map((command, index) => <button id={`${slashMenuId}-option-${index}`} type="button" role="option" aria-selected={index === activeSlashCommandIndex} className={index === activeSlashCommandIndex ? "is-selected" : ""} tabIndex={-1} key={`${command.source}:${command.name}`} onMouseEnter={() => setSlashCommandIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => insertSlashCommand(command)}>
                        <span className="slash-command-name">/{command.name}</span><span className="slash-command-source">{command.source === "extension" ? i18n.t("扩展") : command.source === "prompt" ? i18n.t("提示模板") : command.source === "skill" ? i18n.t("技能") : command.source === "builtin" ? i18n.t("系统指令") : i18n.t("命令")}</span>{command.description && <small>{i18n.t(command.description)}</small>}{command.inputHint && <small>{i18n.t(command.inputHint)}</small>}
                      </button>)}
                    </div>}
                    <textarea ref={composerRef} value={composer} aria-autocomplete="list" aria-controls={slashMenuVisible ? slashMenuId : undefined} aria-activedescendant={activeSlashCommandId} onChange={(event) => updateComposerText(event.target.value)} onPaste={handleComposerPaste} onBlur={() => setSlashMenuOpen(false)} placeholder={selectedSessionCompacting ? i18n.t("正在压缩上下文，完成后即可发送") : hasActiveCustomUi ? i18n.t("请先关闭当前扩展操作面板") : selectedSessionId ? i18n.t("给 {{name}} 发消息…", { name: selectedSessionProvider?.displayName ?? "Agent" }) : selectedProject || projectlessDraft ? i18n.t("随心输入") : i18n.t("先添加一个项目文件夹")} disabled={!connected || selectedSessionCompacting || hasActiveCustomUi || (!selectedProject && !snapshot.projects.length && !projectlessDraft)} rows={Math.min(6, Math.max(1, composer.split("\n").length))} onKeyDown={handleComposerKeyDown} />
                    <input ref={attachmentInputRef} className="visually-hidden-input" type="file" accept={activeProviderSupportsFileAttachments ? undefined : "image/png,image/jpeg,image/webp,image/gif"} multiple onChange={(event) => {
                      const files = Array.from(event.currentTarget.files ?? []);
                      event.currentTarget.value = "";
                      addComposerAttachments(files);
                    }} />
                    <div className="composer-footer"><div className="composer-left"><button aria-label={i18n.t("添加附件")} disabled={selectedSessionCompacting || !activeProviderSupportsAttachments} onClick={() => attachmentInputRef.current?.click()}><Plus size={18} /></button>{selectedSessionId && selectedSessionProvider && <span className="provider-pill">{selectedSessionProvider.id === "pi" ? <PiIcon size={17} /> : selectedSessionProvider.id === "claude" ? <ClaudeIcon size={17} /> : selectedSessionProvider.id === "codex" ? <CodexIcon size={17} /> : selectedSessionProvider.id === "opencode" ? <OpenCodeIcon size={17} /> : selectedSessionProvider.id === "qoder" ? <QoderIcon size={17} /> : selectedSessionProvider.id === "zcode" ? <ZCodeIcon size={17} /> : <span className="provider-mark">AI</span>}{selectedSessionProvider.displayName}</span>}{selectedSession && <AgentModeControl session={selectedSession} supported={hostCapabilities.sessionModelSelection} onSettings={(settings, state) => setSnapshot((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === selectedSession.id ? { ...item, runtimeSettings: settings, ...(state ? { state } : {}) } : item) }))} onError={(message) => setError(message)} />}<ExtensionStatusRail key={`status-${selectedSessionId}`} statuses={extensionUi?.statuses ?? []} stale={!connected} /></div><div className="composer-right">{status && !sessionRunning && !selectedSessionCompacting && <span className="composer-status">{status}</span>}{sessionRunning && selectedSessionSupportsQueue && <div className="queue-delivery-control" ref={queueDeliveryControlRef}><button type="button" className="queue-delivery-trigger" aria-haspopup="true" aria-expanded={queueDeliveryMenuOpen} aria-label={i18n.t("工作中消息的处理方式")} title={queuedDeliveryMode === "follow-up" ? i18n.t("完成当前回复后再处理新消息") : i18n.t("让 Agent 调整当前任务方向")} onClick={() => setQueueDeliveryMenuOpen((open) => !open)}><span>{queuedDeliveryMode === "follow-up" ? i18n.t("完成后发送") : i18n.t("转向当前任务")}</span><ChevronDown size={13} aria-hidden="true" /></button>{queueDeliveryMenuOpen && <div className="queue-delivery-menu" role="group" aria-label={i18n.t("工作中消息的处理方式")}><button type="button" className={queuedDeliveryMode === "follow-up" ? "is-selected" : ""} aria-pressed={queuedDeliveryMode === "follow-up"} onClick={() => { setQueuedDeliveryMode("follow-up"); setQueueDeliveryMenuOpen(false); }}><span><strong>{i18n.t("完成后发送")}</strong><small>{i18n.t("等当前回复结束，再处理这条消息")}</small></span>{queuedDeliveryMode === "follow-up" && <Check size={14} aria-hidden="true" />}</button><button type="button" className={queuedDeliveryMode === "steer" ? "is-selected" : ""} aria-pressed={queuedDeliveryMode === "steer"} onClick={() => { setQueuedDeliveryMode("steer"); setQueueDeliveryMenuOpen(false); }}><span><strong>{i18n.t("转向当前任务")}</strong><small>{i18n.t("让 Agent 改变方向，不会强停正在运行的工具")}</small></span>{queuedDeliveryMode === "steer" && <Check size={14} aria-hidden="true" />}</button></div>}</div>}{selectedSession && <AgentSessionControls session={selectedSession} supported={hostCapabilities.sessionModelSelection} onSettings={(settings, state) => setSnapshot((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === selectedSession.id ? { ...item, runtimeSettings: settings, ...(state ? { state } : {}) } : item) }))} onError={(message) => setError(message)} />}{!selectedSession && selectedDraftProvider && <DraftSessionControls host={host} providerId={selectedDraftProvider.id} supported={hostCapabilities.sessionModelSelection} onChange={setDraftSessionSelection} />}{selectedSession && hostCapabilities.sessionUsage && <SessionUsageControl session={selectedSession} contextSupported={selectedSessionSupportsContext} sessionBusy={sessionRunning || selectedSessionCompacting} onSettings={(settings) => setSnapshot((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === selectedSession.id ? { ...item, runtimeSettings: settings } : item) }))} onError={(message) => setError(message)} onUsage={(usage) => setSnapshot((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === selectedSession.id ? { ...item, usage } : item) }))} />}{selectedSessionId && selectedSessionCompacting ? <span className="send-button send-state-indicator is-compacting" role="status" aria-label={i18n.t("正在压缩上下文")} title={i18n.t("正在压缩上下文")}><LoaderCircle size={17} /></span> : selectedSessionId && sessionRunning ? <button className="send-button is-stop" onClick={() => void cancelRun()} aria-label={pauseGoalInput ? i18n.t("暂停 Goal") : i18n.t("停止当前 Agent")} title={pauseGoalInput ? i18n.t("暂停 Goal") : i18n.t("停止当前 Agent")}>{pauseGoalInput ? <Pause size={17} /> : <LoaderCircle size={17} />}</button> : <button className="send-button" onClick={() => void sendMessage()} disabled={(!composer.trim() && composerAttachments.length === 0 && composerBrowserElements.length === 0) || !connected || selectedSessionSendPending || selectedSessionCompacting || hasActiveCustomUi || (!selectedSessionId && !selectedDraftProvider)} aria-label={sessionRunning ? (queuedDeliveryMode === "steer" ? i18n.t("发送并转向当前任务") : i18n.t("排队发送")) : i18n.t("发送消息")}><Send size={16} /></button>}</div></div>
                  </div>
                </div>
                {projectArchiveNotice && <div className={`archive-toast ${projectArchiveNotice.kind === "undone" || (projectArchiveNotice.kind === "archived" && projectArchiveNotice.scope === "project") ? "is-success" : projectArchiveNotice.kind === "archived" ? "is-archived" : "is-pending"} ${projectArchiveNotice.closing ? "is-exiting" : ""}`} role="status" aria-live="polite">
                  {projectArchiveNotice.kind === "archived" ? <><CheckCircle2 size={17} /><span>{projectArchiveNotice.scope === "project" ? i18n.t("已归档 {{count}} 个任务", { count: projectArchiveNotice.count }) : i18n.t("已归档的聊天")}</span>{projectArchiveNotice.scope !== "project" && <><button className="archive-toast-view" onClick={() => { clearProjectArchiveNotice(); openSettingsView(); }}>{i18n.t("查看")}</button><button className="archive-toast-undo" onClick={() => void undoProjectArchive()}>{i18n.t("撤销")}</button></>}<button className="archive-toast-close" aria-label={i18n.t("关闭")} title={i18n.t("关闭")} onClick={clearProjectArchiveNotice}><X size={15} /></button></> : projectArchiveNotice.kind === "undoing" ? <><LoaderCircle className="archive-toast-spinner" size={17} /><span>{i18n.t("正在取消聊天归档…")}</span></> : <><CheckCircle2 size={17} /><span>{i18n.t("聊天已恢复")}</span><button className="archive-toast-close" aria-label={i18n.t("关闭")} title={i18n.t("关闭")} onClick={clearProjectArchiveNotice}><X size={15} /></button></>}
                </div>}
                {notice && <div className="toast-notice">{notice}</div>}
                {deleteSuccessNotice && <div className="archive-toast" role="status" aria-live="polite"><Trash2 size={17} aria-hidden="true" /><span>{i18n.t("聊天已永久删除")}</span><button type="button" className="archive-toast-close" title={i18n.t("关闭")} aria-label={i18n.t("关闭")} onClick={dismissDeleteSuccessNotice}><X size={15} aria-hidden="true" /></button></div>}
                {extensionNotices.some((item) => item.sessionId === selectedSessionId) && <div className="extension-toast-stack" aria-live="polite" aria-relevant="additions">
                  {extensionNotices.filter((item) => item.sessionId === selectedSessionId).map((item) => <ExtensionNoticeToast key={item.id} message={item.message} onDismiss={() => setExtensionNotices((current) => current.filter((notice) => notice.id !== item.id))} />)}
                </div>}
              </main>

              {workspaceViews.state.sideTab && <WorkspacePanelResizer width={workspaceSidePanelWidth} hidden={workspaceViews.state.panelHidden || workspaceViews.state.fullView} onResize={resizeWorkspaceSidePanel} onEnterFullView={workspaceViews.enterFullView} onExitFullView={workspaceViews.exitFullView} />}
              <WorkspaceTabHost key={selectedSessionId ?? "no-session"} state={workspaceViews.state} items={workspaceViews.items} context={workspaceTabContext} onSelectTab={workspaceViews.selectTab} onCloseTab={closeWorkspaceTab} onRenameTab={workspaceViews.renameTab} onUpdateTabTitle={workspaceViews.updateTabTitle} onUpdateTabFavicon={workspaceViews.updateTabFavicon} onNewTab={openTabPicker} onOpenTab={openWorkspaceTab} onClosePicker={closeTabPicker} onShowTooltip={showSessionActionTooltip} onHideTooltip={() => setSessionActionTooltip(null)} />
            </div>
          </>}
        </div>
      </>

      {sessionHoverCard && hoverSessionData && createPortal(<div className={`session-hover-card ${sessionHoverCardClosing || popupSwitching || projectMenu || sessionMenu || menuOpen ? "is-closing" : ""}`} role="tooltip" style={{ left: sessionHoverCard.left, top: sessionHoverCard.top }} onMouseEnter={keepSessionHoverCardOpen} onMouseLeave={closeSessionHoverCardImmediately}>
        <div className="session-hover-card-heading"><SessionHoverCardTitle title={hoverSessionData.title} /><time>{formatSessionUpdatedAt(lastUserMessageAt(hoverSessionData), relativeTimeNow)}</time></div>
        <div className="session-hover-card-project"><Folder size={16} /><span>{hoverSessionProject?.name ?? i18n.t("此计算机")}</span></div>
      </div>, document.body)}
      {projectHoverCard && hoverProjectData && createPortal(<div className={`project-hover-card ${projectHoverCardClosing || popupSwitching || projectMenu || sessionMenu || menuOpen ? "is-closing" : ""}`} role="tooltip" style={{ left: projectHoverCard.left, top: projectHoverCard.top }} onMouseEnter={keepSessionHoverCardOpen} onMouseLeave={closeSessionHoverCardImmediately}>
        <div className="project-hover-card-heading"><FolderOpen size={18} /><strong>{hoverProjectData.name}</strong><button className={`project-hover-card-pin ${pinnedProjectIds.includes(hoverProjectData.id) ? "is-pinned" : ""}`} title="" aria-label={pinnedProjectIds.includes(hoverProjectData.id) ? i18n.t("取消置顶项目：{{name}}", { name: hoverProjectData.name }) : i18n.t("置顶项目：{{name}}", { name: hoverProjectData.name })} aria-pressed={pinnedProjectIds.includes(hoverProjectData.id)} onClick={() => toggleProjectPin(hoverProjectData)}>{pinnedProjectIds.includes(hoverProjectData.id) ? <PinOff size={16} /> : <Pin size={16} />}</button></div>
        <div className="project-hover-card-stats"><MessageSquare size={17} /><span>{i18n.t("{{count}} 个任务", { count: hoverProjectSessions.length })}</span>{hoverProjectRunningCount > 0 && <><i>·</i><span>{i18n.t("{{count}} 个已开启", { count: hoverProjectRunningCount })}</span></>}{hoverProjectUnreadCount > 0 && <><i>·</i><span>{i18n.t("{{count}} 条未读", { count: hoverProjectUnreadCount })}</span></>}</div>
        {(hoverProjectData.roots?.length ? hoverProjectData.roots : [hoverProjectData.root]).map((path, index) => <div className="project-hover-card-path" key={`${path}-${index}`}><Folder size={16} /><span title={path}>{path}</span></div>)}
        <button className="project-hover-card-edit" onClick={() => startProjectEdit(hoverProjectData)}><Settings2 size={16} /><span>{i18n.t("编辑项目")}</span></button>
      </div>, document.body)}
      {projectMenu && projectMenuData && createPortal(<>
        <button className="project-menu-dismiss" aria-label={i18n.t("关闭项目菜单")} onClick={closeProjectMenu} onContextMenu={handlePopupDismissContextMenu} />
        <div key={popupOpenVersion} className={`project-context-menu ${popupEnteringVersion === popupOpenVersion ? "is-opening" : ""} ${projectMenuClosing ? "is-closing" : ""}`} role="menu" aria-label={i18n.t("{{name}} 项目菜单", { name: projectMenuData.name })} style={{ left: projectMenu.left, top: projectMenu.top }}>
          <button role="menuitem" onClick={() => toggleProjectPin(projectMenuData)}>{pinnedProjectIds.includes(projectMenuData.id) ? <PinOff size={17} /> : <Pin size={17} />}<span>{pinnedProjectIds.includes(projectMenuData.id) ? i18n.t("取消置顶") : i18n.t("置顶")}</span></button>
          <button role="menuitem" onClick={() => startProjectEdit(projectMenuData)}><Settings2 size={17} /><span>{i18n.t("编辑")}</span></button>
          <div className="project-context-menu-separator" />
          {projectMenuRoots.length === 1 && <button role="menuitem" onClick={() => { closeProjectMenu(); runWindowAction(() => invoke("open_in_file_manager", { path: projectMenuRoots[0]! })); }}><Folder size={17} /><span>{i18n.t("在资源管理器中打开")}</span></button>}
          {projectMenuRoots.length === 1 && <div className="project-context-menu-separator" />}
          <button role="menuitem" onClick={() => { closeProjectMenu(); requestProjectArchive(projectMenuData); }}><Archive size={17} /><span>{i18n.t("归档聊天")}</span></button>
          <div className="project-context-menu-separator" />
          <button role="menuitem" className="is-destructive" onClick={() => { closeProjectMenu(); setError(null); setRemoveProjectConfirmId(projectMenuData.id); }}><X size={17} /><span>{i18n.t("移除项目")}</span></button>
        </div>
      </>, document.body)}

      {sessionMenu && sessionMenuData && createPortal(<>
        <button className="project-menu-dismiss" aria-label={i18n.t("关闭会话菜单")} onClick={closeSessionMenu} onContextMenu={handlePopupDismissContextMenu} />
        <div key={popupOpenVersion} className={`project-context-menu session-context-menu${sessionMenuSubmenuOpensLeft ? " submenus-open-left" : ""} ${popupEnteringVersion === popupOpenVersion ? "is-opening" : ""} ${sessionMenuClosing ? "is-closing" : ""}`} role="menu" aria-label={i18n.t("{{title}} 会话菜单", { title: sessionMenuData.title })} style={{ left: sessionMenu.left, top: sessionMenu.top }}>
          <button role="menuitem" onClick={() => { closeSessionMenu(); setSessionRenameTarget(sessionMenuData); setSessionRenameTitle(sessionMenuData.title); setSessionRenameError(null); }}><SquarePen size={17} /><span>{i18n.t("重命名")}</span></button>
          <button role="menuitem" onClick={() => { closeSessionMenu(); toggleSessionPin(sessionMenuData); }}>{pinnedSessionIds.includes(sessionMenuData.id) ? <PinOff size={17} /> : <Pin size={17} />}<span>{pinnedSessionIds.includes(sessionMenuData.id) ? i18n.t("取消置顶") : i18n.t("置顶")}</span></button>
          <button role="menuitem" onClick={() => { closeSessionMenu(); toggleSessionRead(sessionMenuData); }}>{hasUnreadAssistantReply(sessionMenuData, sessionViewedAt) ? <MailOpen size={17} /> : <Mail size={17} />}<span>{hasUnreadAssistantReply(sessionMenuData, sessionViewedAt) ? i18n.t("标记为已读") : i18n.t("标记为未读")}</span></button>
          <div className="project-context-menu-separator" />
          {sessionMenuSupportsFork && <><div className="menu-item menu-parent" role="none"><GitBranch size={17} /><span>{i18n.t("分叉")}</span><ChevronRight size={14} /><div className="submenu" role="menu" aria-label={i18n.t("会话分叉")}><button role="menuitem" onClick={() => { closeSessionMenu(); void branchSession(sessionMenuData.id); }}><Laptop size={16} /><span>{i18n.t("创建聊天分支")}</span></button></div></div><div className="project-context-menu-separator" /></>}
          <div className="menu-item menu-parent" role="none"><Copy size={17} /><span>{i18n.t("复制")}</span><ChevronRight size={14} /><div className="submenu" role="menu" aria-label={i18n.t("复制会话内容")}>
            <button role="menuitem" onClick={() => copySessionMarkdown(sessionMenuData)}><Copy size={16} /><span>{i18n.t("复制为 Markdown")}</span></button>
            <button role="menuitem" onClick={() => copySessionWorkingDirectory(sessionMenuData)}><Folder size={16} /><span>{i18n.t("复制工作目录")}</span></button>
          </div></div>
          <div className="project-context-menu-separator" />
          <button role="menuitem" onClick={() => { closeSessionMenu(); runWindowAction(() => invoke("open_session_window", { sessionId: sessionMenuData.id })); }}><Laptop size={17} /><span>{i18n.t("在新窗口中打开")}</span></button>
          <div className="project-context-menu-separator" />
          <button role="menuitem" onClick={() => { closeSessionMenu(); void archiveSession(sessionMenuData); }}><Archive size={17} /><span>{i18n.t("归档聊天")}</span></button>
          <div className="project-context-menu-separator" />
          <button role="menuitem" className="is-destructive" onClick={() => { closeSessionMenu(); setPermanentDeleteSessionError(null); setPermanentDeleteSessionTarget(sessionMenuData); }}><Trash2 size={17} /><span>{i18n.t("永久删除聊天")}</span></button>
        </div>
      </>, document.body)}

      {searchOpen && <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}><section className="search-dialog"><div className="search-input-wrap"><Search size={18} /><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={i18n.t("搜索会话")} onKeyDown={(event) => { if (event.key === "Escape") setSearchOpen(false); if (event.key === "Enter") { const matchingAction = searchQuery.trim() ? filteredSearchActions[0] : undefined; if (matchingAction) matchingAction.run(); else if (searchedSessions[0]) void openSession(searchedSessions[0]); } }} /><kbd>ESC</kbd></div><div className="search-results">{(!searchQuery.trim() || filteredSearchActions.length > 0) && <><div className="search-label">{i18n.t("快捷操作")}</div>{filteredSearchActions.map((action) => <button key={action.id} onClick={action.run}>{action.icon}<span>{action.label}</span>{action.id === "new-chat" && shortcuts["new-chat"] && <kbd>{shortcutLabel(shortcuts["new-chat"])}</kbd>}</button>)}</>}<div className="search-label quick-label">{i18n.t("会话")}</div>{searchResults.loading ? <div className="search-empty">{i18n.t("搜索中…")}</div> : searchedSessions.length === 0 ? <div className="search-empty">{i18n.t("没有找到匹配的会话")}</div> : searchedSessions.map((session) => <button key={session.id} onClick={() => void openSession(session)}><MessageSquare size={16} /><span>{session.title}</span><small>{snapshot.projects.find((project) => project.id === session.projectId)?.name}</small></button>)}{searchResults.hasMore && <button className="search-load-more" disabled={searchResults.loadingMore} onClick={searchResults.loadMore}>{i18n.t(searchResults.loadingMore ? "正在加载…" : "加载更多结果")}</button>}</div></section></div>}

      {projectDialogOpen && <div className="overlay modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setProjectDialogOpen(false); }}><section className="project-dialog project-create-dialog" style={{ transform: `translateX(${((sidebarCollapsed ? 0 : sidebarWidth) + 48) / 2}px)`, width: `min(520px, calc(100vw - ${(sidebarCollapsed ? 0 : sidebarWidth) + 48 + 40}px))` }}>
        <header><h2>{projectEditId ? i18n.t("编辑项目") : i18n.t("创建项目")}</h2><button title={i18n.t("关闭")} onClick={() => setProjectDialogOpen(false)}><X size={19} /></button></header>
        <label className="project-name-field"><Folder size={17} /><input autoFocus={!projectEditId} value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder={i18n.t("项目名称")} onKeyDown={(event) => { if (event.key === "Enter") void saveProject(); }} /></label>
        <div className="folder-label">{i18n.t("源文件夹")}</div>
        {projectFolders.length === 0 ? <button className="folder-picker" onClick={() => void chooseFolders()}><span className="folder-picker-title">{i18n.t("在此电脑上添加文件夹")}<ChevronDown size={16} /></span><span className="folder-picker-cta"><FolderPlus size={16} />{i18n.t("添加")}</span></button> : <div className="project-folder-list">
          {projectFolders.map((path, index) => <div className="project-folder-row" key={`${path}-${index}`}><Folder size={18} /><span title={path}>{path.split(/[\\/]/).filter(Boolean).at(-1) ?? path}</span><button title={i18n.t("移除文件夹")} aria-label={i18n.t("移除文件夹 {{path}}", { path })} onClick={() => setProjectFolders((current) => current.filter((_, folderIndex) => folderIndex !== index))}><X size={16} /></button></div>)}
          <button className="add-folder-row" onClick={() => void chooseFolders()}><FolderPlus size={18} /><span>{i18n.t("添加文件夹")}</span></button>
        </div>}
        {error && <div className="dialog-error"><AlertCircle size={15} />{error}</div>}
        <footer>{projectEditId && <button className="remove-project-button" disabled={projectBusy} onClick={() => { setError(null); setRemoveProjectConfirmId(projectEditId); }}>{i18n.t("移除本地项目")}</button>}<span className="project-dialog-spacer" /><button className="cancel-button" onClick={() => setProjectDialogOpen(false)}>{i18n.t("取消")}</button><button className="primary-button" disabled={!projectName.trim() || projectFolders.length === 0 || projectBusy} onClick={() => void saveProject()}>{projectBusy ? i18n.t("正在保存…") : projectEditId ? i18n.t("保存") : i18n.t("创建项目")}</button></footer>
      </section></div>}

      {sessionRenameTarget && <div className="overlay archive-confirm-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !sessionRenameBusy) setSessionRenameTarget(null); }}><section className="project-dialog session-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="session-rename-title">
        <header><h2 id="session-rename-title">{i18n.t("重命名聊天")}</h2><button title={i18n.t("关闭")} aria-label={i18n.t("关闭")} disabled={sessionRenameBusy} onClick={() => setSessionRenameTarget(null)}><X size={18} /></button></header>
        <label className="project-name-field"><SquarePen size={17} /><input autoFocus value={sessionRenameTitle} onChange={(event) => setSessionRenameTitle(event.target.value)} placeholder={i18n.t("聊天名称")} onKeyDown={(event) => { if (event.key === "Enter") void renameSession(); }} /></label>
        {sessionRenameError && <div className="dialog-error"><AlertCircle size={15} />{sessionRenameError}</div>}
        <footer><span className="project-dialog-spacer" /><button className="cancel-button" disabled={sessionRenameBusy} onClick={() => setSessionRenameTarget(null)}>{i18n.t("取消")}</button><button className="primary-button" disabled={!sessionRenameTitle.trim() || sessionRenameBusy} onClick={() => void renameSession()}>{sessionRenameBusy ? i18n.t("正在保存…") : i18n.t("保存")}</button></footer>
      </section></div>}

      {permanentDeleteSessionTarget && <div className="overlay archive-confirm-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !permanentDeleteSessionBusy) setPermanentDeleteSessionTarget(null); }}><section className="archive-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="session-delete-title" aria-describedby="session-delete-description">
        <header><h2 id="session-delete-title">{i18n.t("永久删除“{{title}}”？", { title: permanentDeleteSessionTarget.title })}</h2><button title={i18n.t("关闭")} aria-label={i18n.t("关闭")} disabled={permanentDeleteSessionBusy} onClick={() => setPermanentDeleteSessionTarget(null)}><X size={18} /></button></header>
        <p id="session-delete-description">{i18n.t("这会永久删除 Vagus 聊天记录及对应的 {{provider}} 原生会话数据，无法撤销。项目文件不会被删除。", { provider: snapshot.providers.find((provider) => provider.id === (permanentDeleteSessionTarget.providerId ?? "pi"))?.displayName ?? "Agent" })}</p>
        {permanentDeleteSessionError && <div className="dialog-error"><AlertCircle size={15} />{permanentDeleteSessionError}</div>}
        <footer><button className="cancel-button" disabled={permanentDeleteSessionBusy} onClick={() => setPermanentDeleteSessionTarget(null)}>{i18n.t("取消")}</button><button className="archive-delete-confirm" disabled={permanentDeleteSessionBusy} onClick={() => void permanentlyDeleteSession()}>{permanentDeleteSessionBusy ? i18n.t("正在删除…") : i18n.t("永久删除")}</button></footer>
      </section></div>}

      {goalDeleteOpen && <div className="overlay archive-confirm-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !goalDeleteBusy) setGoalDeleteOpen(false); }}><section className="archive-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="goal-delete-title" aria-describedby="goal-delete-description">
        <header><h2 id="goal-delete-title">{i18n.t("删除当前目标？")}</h2><button title={i18n.t("关闭")} aria-label={i18n.t("关闭")} disabled={goalDeleteBusy} onClick={() => setGoalDeleteOpen(false)}><X size={18} /></button></header>
        <p id="goal-delete-description">{i18n.t("这只会清除当前会话的目标记录，不会删除聊天内容或项目文件。")}</p>
        {goalDeleteError && <div className="dialog-error"><AlertCircle size={15} />{goalDeleteError}</div>}
        <footer><button className="cancel-button" disabled={goalDeleteBusy} onClick={() => setGoalDeleteOpen(false)}>{i18n.t("取消")}</button><button className="archive-delete-confirm" disabled={goalDeleteBusy} onClick={() => void deleteGoal()}>{goalDeleteBusy ? i18n.t("正在删除…") : i18n.t("删除目标")}</button></footer>
      </section></div>}

      {removeProjectConfirmId && <div className="overlay remove-project-confirm-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !projectBusy) setRemoveProjectConfirmId(null); }}><section className="remove-project-confirm" role="alertdialog" aria-modal="true" aria-labelledby="remove-project-confirm-title" aria-describedby="remove-project-confirm-description">
        <header><h2 id="remove-project-confirm-title">{i18n.t("移除“{{name}}”？", { name: snapshot.projects.find((item) => item.id === removeProjectConfirmId)?.name ?? i18n.t("项目") })}</h2><button title={i18n.t("关闭")} aria-label={i18n.t("关闭")} disabled={projectBusy} onClick={() => setRemoveProjectConfirmId(null)}><X size={18} /></button></header>
        <p id="remove-project-confirm-description">{i18n.t("这会从应用中移除该项目及其会话记录。你电脑上的文件和 Pi 原生会话记录不会被删除。")}</p>
        {error && <div className="dialog-error"><AlertCircle size={15} />{error}</div>}
        <footer><button className="cancel-button" disabled={projectBusy} onClick={() => setRemoveProjectConfirmId(null)}>{i18n.t("取消")}</button><button className="confirm-remove-project-button" disabled={projectBusy} onClick={() => void removeProject()}>{projectBusy ? i18n.t("正在移除…") : i18n.t("移除项目")}</button></footer>
      </section></div>}

      {archiveProjectTarget && <div className="overlay archive-confirm-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !archiveProjectBusy) setArchiveProjectTarget(null); }}><section className="archive-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="archive-project-title" aria-describedby="archive-project-description">
        <header><h2 id="archive-project-title">{i18n.t("归档 {{count}} 个聊天？", { count: snapshot.sessions.filter((session) => session.projectId === archiveProjectTarget.id && !session.archivedAt && !session.scheduledTaskId).length })}</h2><button title={i18n.t("关闭")} aria-label={i18n.t("关闭")} disabled={archiveProjectBusy} onClick={() => setArchiveProjectTarget(null)}><X size={18} /></button></header>
        <p id="archive-project-description">{i18n.t("这会将“{{name}}”中的聊天归档。之后你可以在已归档的聊天中找到它们。", { name: archiveProjectTarget.name })}</p>
        {archiveProjectError && <div className="dialog-error"><AlertCircle size={15} />{archiveProjectError}</div>}
        <footer><button className="cancel-button" disabled={archiveProjectBusy} onClick={() => setArchiveProjectTarget(null)}>{i18n.t("取消")}</button><button className="archive-delete-confirm" disabled={archiveProjectBusy} onClick={() => void archiveProjectChats()}>{archiveProjectBusy ? i18n.t("正在归档…") : i18n.t("全部归档")}</button></footer>
      </section></div>}

    </div>
    {sessionActionTooltip && createPortal(<div className={`session-action-tooltip ${sessionActionTooltip.placement}`} role="tooltip" style={{ left: sessionActionTooltip.left, top: sessionActionTooltip.top }}><span>{sessionActionTooltip.label}</span>{sessionActionTooltip.shortcut && <kbd>{sessionActionTooltip.shortcut}</kbd>}</div>, document.body)}
  </div>;
}
