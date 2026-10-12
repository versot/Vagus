import type { HostClient, Project, ProviderInfo, ScheduledTask, ScheduledTaskFrequency } from "@vagus/client";
import type { AgentEvent, AgentRuntimeSettings, SessionOpenResult, SessionTimelineEntry } from "@vagus/protocol";
import { AlertCircle, CalendarClock, Check, ChevronDown, ChevronRight, Clock3, Ellipsis, Folder, LoaderCircle, MessageSquare, Pause, Pencil, Play, Plus, Send, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import i18n from "../../locales/i18n.js";
import { PlanActivityLine, SubagentActivityLine, ThinkingMarker, ToolActivityLine, TurnDiffActivityLine } from "../conversation/components/conversation-activity.js";
import { InteractionCard } from "../conversation/components/interaction-card.js";
import { MessageContent } from "../conversation/components/message-content.js";
import { VirtualConversation, type ConversationRow } from "../conversation/components/virtual-conversation.js";
import { isConversationActivity } from "../conversation/conversation-presentation.js";
import { ConversationProjection } from "../conversation/conversation-projection.js";
import type { ChatInteraction, ChatMessage, ChatNotice, ChatPlan, ChatStatus, ChatTurnDiff, ToolActivity } from "../conversation/types.js";
import { DraftSessionControls, defaultSessionModeId, type DraftSessionSelection } from "../providers/draft-session-controls.js";
import { saveProviderSessionPreference } from "../providers/provider-session-preferences.js";
import { SettingSelect } from "../settings/setting-select.js";
import "./scheduled-tasks-page.css";
import { TimeZonePicker, timeZoneCityLabel, timeZoneOffsetLabel } from "./time-zone-picker.js";

type Props = {
  host: HostClient;
  providers: ProviderInfo[];
  projects: Project[];
  activeProjectId: string | null;
  onClose(): void;
  onShowTooltip(event: MouseEvent<HTMLElement>, label: string): void;
  onHideTooltip(): void;
  sidebarWidth?: number;
  sharedConversationMode?: boolean;
  onActiveTask?(task: ScheduledTask | null): void;
  onOpenUrl?(url: string): void;
};
const frequencyLabels: Record<ScheduledTaskFrequency, string> = { once: "仅一次", daily: "每天", weekdays: "每个工作日", weekly: "每周" };
const runStatusLabels: Record<Exclude<NonNullable<ScheduledTask["lastRunStatus"]>, "running">, string> = { success: "上次运行已提交", error: "上次运行失败", interrupted: "运行已中断" };
const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const translatedHostErrors = new Set([
  "任务关联的工作空间已不存在", "任务所选 Agent 当前不可用", "任务没有关联模型，请重新创建任务",
  "任务所选模型已不可用，请重新创建任务", "所选模型不支持这个思考程度", "任务专属会话不存在，请重新创建任务",
  "任务会话正在运行，请等待当前回复完成", "当前 Agent 不支持选择模型", "当前 Agent 暂不支持为新会话设置思考程度",
  "Agent 在创建任务会话时退出，请稍后重试", "当前 Agent 不支持此模型", "请选择当前已启用且健康的 Agent",
  "找不到这个项目", "找不到这个定时任务", "任务正在更新，请稍后再试", "任务正在运行，请等待本次执行完成",
  "这个任务已经在运行", "任务在执行期间已被删除", "任务正在提交到 Agent，请稍后再编辑", "请填写任务内容",
  "请选择每周运行的日期", "请选择有效的时区", "任务会话正在运行，请等待回复完成后再编辑",
  "任务正在提交到 Agent，暂时无法删除", "任务会话归属校验失败，为避免误删，任务和会话都未删除",
  "任务会话正在运行，请等待回复完成后再删除", "Vagus 在任务运行完成前关闭。",
  "所选模型不在 Agent 当前目录中，请刷新后重试",
]);
function scheduledTaskErrorMessage(reason: unknown, fallbackKey: string) {
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  if (!message) return i18n.t(fallbackKey);
  const timeZoneError = message.match(/^无法在时区 (.+) 中解析计划时间$/);
  if (timeZoneError) return i18n.t("无法在时区 {{timeZone}} 中解析计划时间", { timeZone: timeZoneError[1] });
  return translatedHostErrors.has(message) ? i18n.t(message) : message;
}
function localScheduleDate(value: string | null, timeZone?: string) {
  if (!value) return "未安排";
  const locale = i18n.resolvedLanguage || i18n.language;
  try { return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(new Date(value)); }
  catch { return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
}
function formatTaskDuration(startedAt: string, completedAt: string | undefined, now: number, active: boolean): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const seconds = Math.floor((end - start) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  const duration = minutes > 0 ? i18n.t("{{count}} 分钟 {{seconds}} 秒", { count: minutes, seconds: remainder }) : i18n.t("{{seconds}} 秒", { seconds: remainder });
  return `${i18n.t(active ? "已处理" : "用时")} ${duration}`;
}

function nextTimelineSequence(entries: SessionTimelineEntry[], sequence?: number) {
  return sequence ?? Math.max(0, ...entries.map((entry) => entry.sequence)) + 1;
}

function upsertTimelineEntry(entries: SessionTimelineEntry[], entry: SessionTimelineEntry) {
  return [...entries.filter((current) => current.id !== entry.id), entry].sort((a, b) => a.sequence - b.sequence);
}

function ScheduledSessionModeControl({ host, sessionId, providerId, disabled, onError }: { host: HostClient; sessionId: string; providerId: string; disabled: boolean; onError(message: string): void }) {
  const [settings, setSettings] = useState<AgentRuntimeSettings | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const controlRef = useRef<HTMLDivElement>(null);
  const modes = settings?.availableModes ?? [];
  const currentMode = modes.find((mode) => mode.id === settings?.currentModeId);
  const modeLabel = currentMode ? i18n.t(currentMode.name) : settings?.currentModeId ?? "";

  useEffect(() => {
    let active = true;
    setSettings(null);
    void host.request("sessions.get-settings", { sessionId }).then(({ settings: next }) => {
      if (active) setSettings(next);
    }).catch((reason: unknown) => {
      if (active) onError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [host, sessionId]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => { if (!controlRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [menuOpen]);

  const chooseMode = async (modeId: string) => {
    setSaving(true);
    try {
      setSettings(await host.request("sessions.set-mode", { sessionId, modeId }));
      saveProviderSessionPreference(providerId, { modeId });
      setMenuOpen(false);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  if (!modes.length) return null;
  const unavailable = disabled || saving;
  return <div className="session-mode-control" ref={controlRef}>
    <button type="button" className="session-mode-trigger" aria-label={`${i18n.t("工作模式")}: ${modeLabel}`} title={`${i18n.t("工作模式")}: ${modeLabel}`} aria-haspopup="dialog" aria-expanded={menuOpen} disabled={unavailable} onClick={() => setMenuOpen((open) => !open)}>
      <span className="session-mode-trigger-value">{modeLabel}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {menuOpen && <div className="session-preferences-menu session-mode-menu" role="dialog" aria-label={i18n.t("工作模式")}>
      <div className="session-preferences-model-heading"><strong>{i18n.t("选择模式")}</strong><span>{modeLabel}</span></div>
      <div className="session-model-results" role="listbox" aria-label={i18n.t("工作模式")}>
        {modes.map((mode) => <button type="button" key={mode.id} role="option" aria-selected={settings?.currentModeId === mode.id} className="session-model-option" disabled={unavailable} onClick={() => void chooseMode(mode.id)}>
          <span className="session-model-option-copy"><strong>{i18n.t(mode.name)}</strong>{mode.description && <small>{mode.description}</small>}</span>
          {settings?.currentModeId === mode.id && <Check size={15} />}
        </button>)}
      </div>
    </div>}
  </div>;
}

export function ScheduledTasksPage({ host, providers, projects, activeProjectId, onClose, onShowTooltip, onHideTooltip, sidebarWidth, sharedConversationMode = false, onActiveTask, onOpenUrl }: Props) {
  // Subscribe to language changes so this route rerenders when persisted UI settings load.
  useTranslation();
  const availableProviders = useMemo(() => providers.filter((provider) => provider.enabled && provider.health === "healthy"), [providers]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskContextMenu, setTaskContextMenu] = useState<{ taskId: string; left: number; top: number } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [runNowTaskId, setRunNowTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<SessionTimelineEntry[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionRunning, setSessionRunning] = useState(false);
  const [interactionBusyId, setInteractionBusyId] = useState<string | null>(null);
  const [expandedTurnIds, setExpandedTurnIds] = useState<Set<string>>(() => new Set());
  const [collapsedActiveTurnId, setCollapsedActiveTurnId] = useState<string | null>(null);
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(() => new Set());
  const [durationNow, setDurationNow] = useState(Date.now);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState<string | null>(activeProjectId);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(null);
  const [modeId, setModeId] = useState<string | null>(null);
  const [availableModes, setAvailableModes] = useState<Array<{ id: string; name: string; description?: string }>>([]);
  const [frequency, setFrequency] = useState<ScheduledTaskFrequency>("daily");
  const [weekday, setWeekday] = useState(1);
  const [time, setTime] = useState("09:00");
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [timeZone, setTimeZone] = useState(localTimeZone);
  const timelineRef = useRef<HTMLDivElement>(null);
  const projectionRef = useRef(new ConversationProjection());
  const modalRef = useRef<HTMLElement>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const isEditingTask = editingTaskId !== null;
  const editingTask = editingTaskId ? tasks.find((task) => task.id === editingTaskId) ?? null : null;
  const latestMessageText = [...timeline].reverse().find((entry) => entry.kind === "message")?.text ?? "";
  const activeProject = projects.find((project) => project.id === projectId);
  const [scheduleHour, scheduleMinute] = time.split(":");

  const conversationEntries = useMemo(() => {
    const messages: ChatMessage[] = [];
    const activities: ToolActivity[] = [];
    const statuses: ChatStatus[] = [];
    const interactions: ChatInteraction[] = [];
    const notices: ChatNotice[] = [];
    const plans: ChatPlan[] = [];
    const turnDiffs: ChatTurnDiff[] = [];
    for (const entry of timeline) {
      if (entry.kind === "message") messages.push({ id: entry.id, role: entry.role, text: entry.text, complete: entry.complete, order: entry.sequence, occurredAt: entry.occurredAt, completedAt: entry.completedAt, ...(entry.turnId ? { turnId: entry.turnId } : {}), ...(entry.attachments?.length ? { attachments: entry.attachments } : {}), ...(entry.browserElements?.length ? { browserElements: entry.browserElements } : {}), ...(entry.contentDeferred ? { contentDeferred: true } : {}) });
      else if (entry.kind === "tool") activities.push({ id: entry.id, name: entry.name, state: entry.state, order: entry.sequence, ...(entry.turnId ? { turnId: entry.turnId } : {}), ...(entry.parentToolCallId ? { parentToolCallId: entry.parentToolCallId } : {}), ...(entry.input !== undefined ? { input: entry.input } : {}), ...(entry.output !== undefined ? { output: entry.output } : {}) });
      else if (entry.kind === "status" && (entry.key === "agent-activity" || entry.key.startsWith("claude-subagent:"))) statuses.push({ id: entry.id, order: entry.sequence, ...(entry.turnId ? { turnId: entry.turnId } : {}), key: entry.key, text: entry.text, ...(entry.subagentSessionId ? { subagentSessionId: entry.subagentSessionId } : {}), ...(entry.subagentCancellable !== undefined ? { subagentCancellable: entry.subagentCancellable } : {}), ...(entry.subagentState ? { subagentState: entry.subagentState } : {}) });
      else if (entry.kind === "interaction") interactions.push({ id: entry.id, order: entry.sequence, ...(entry.turnId ? { turnId: entry.turnId } : {}), interaction: entry.interaction, state: entry.state, ...(entry.response !== undefined ? { response: entry.response } : {}), ...(entry.reason ? { reason: entry.reason } : {}) });
      else if (entry.kind === "notice") notices.push({ id: entry.id, order: entry.sequence, ...(entry.turnId ? { turnId: entry.turnId } : {}), level: entry.level, message: entry.message });
      else if (entry.kind === "plan") plans.push({ id: entry.id, order: entry.sequence, ...(entry.turnId ? { turnId: entry.turnId } : {}), ...(entry.explanation ? { explanation: entry.explanation } : {}), steps: entry.steps });
      else if (entry.kind === "turnDiff") turnDiffs.push({ id: entry.id, order: entry.sequence, turnId: entry.turnId, diff: entry.diff, ...(entry.truncated ? { truncated: true } : {}) });
    }
    return projectionRef.current.update({ messages, displayMessages: messages, activities, statuses, interactions, notices, plans, turnDiffs, busy: sessionRunning });
  }, [timeline, sessionRunning]);
  const turnDurations = useMemo(() => new Map(projectionRef.current.getDurations().map((entry) => [entry.turnId, entry])), [conversationEntries]);
  const latestConversationEntry = [...conversationEntries].reverse().find((entry) => entry.kind !== "duration");
  const visibleConversationRows = useMemo<ConversationRow[]>(() => conversationEntries.flatMap((entry, index) => {
    if (entry.kind === "duration") return [{ key: `duration:${entry.turnId}`, index, estimate: 36 }];
    const duration = entry.value.turnId ? turnDurations.get(entry.value.turnId) : undefined;
    const expanded = duration && (duration.active ? collapsedActiveTurnId !== duration.turnId : expandedTurnIds.has(duration.turnId));
    if (duration && !expanded && entry.order > duration.userOrder && !(entry.kind === "message" && entry.value.id === duration.finalAssistantMessageId)) return [];
    const estimate = entry.kind === "message" ? Math.min(2000, 70 + Math.ceil(entry.value.text.length / 80) * 23) : entry.kind === "plan" ? Math.min(520, 58 + entry.value.steps.length * 26 + Math.ceil((entry.value.explanation?.length ?? 0) / 90) * 16) : entry.kind === "turnDiff" ? 48 : entry.kind === "interaction" ? 180 : entry.kind === "notice" ? 64 : 36;
    const pinned = (entry.kind === "interaction" && entry.value.state === "pending") || (entry.kind === "tool" && expandedActivityIds.has(entry.value.id));
    return [{ key: `${entry.kind}:${entry.value.id}`, index, estimate, pinned }];
  }), [conversationEntries, turnDurations, collapsedActiveTurnId, expandedTurnIds, expandedActivityIds]);

  const refreshTasks = useCallback(async () => {
    setLoading(true);
    try {
      const next = await host.request("scheduled-tasks.list", {});
      setTasks(next);
      setSelectedTaskId((current) => current && next.some((task) => task.id === current) ? current : next[0]?.id ?? null);
      setError(null);
    } catch (reason) { setError(scheduledTaskErrorMessage(reason, "读取定时任务失败")); }
    finally { setLoading(false); }
  }, [host]);

  const loadSession = useCallback(async (sessionId: string, beforeSequence?: number) => {
    if (beforeSequence !== undefined) {
      setHistoryLoading(true);
      try {
        const page = await host.request("sessions.history", { sessionId, limit: 100, beforeSequence });
        setTimeline((current) => [...page.entries, ...current]); setHistoryCursor(page.beforeSequence); setHistoryHasMore(page.hasMore);
      } catch (reason) { setError(scheduledTaskErrorMessage(reason, "读取更早的消息失败")); }
      finally { setHistoryLoading(false); }
      return;
    }
    setSessionLoading(true);
    try {
      await host.request("sessions.subscribe", { sessionId });
      const opened: SessionOpenResult = await host.request("sessions.open", { sessionId, historyLimit: 120 });
      setTimeline(opened.timeline); setHistoryCursor(opened.history?.beforeSequence ?? null); setHistoryHasMore(Boolean(opened.history?.hasMore));
      setSessionRunning(opened.state === "running" || opened.state === "starting"); setError(null);
    } catch (reason) { setError(scheduledTaskErrorMessage(reason, "读取任务会话失败")); setTimeline([]); }
    finally { setSessionLoading(false); }
  }, [host]);

  const ensureTaskSession = useCallback(async (taskId: string) => {
    setSessionLoading(true); setError(null);
    try {
      const next = await host.request("scheduled-tasks.list", {});
      setTasks(next);
      const task = next.find((item) => item.id === taskId);
      if (!task?.sessionId) throw new Error(i18n.t("这个任务的专属会话尚未就绪。请确认 Agent 已启用并连接，然后重试。"));
    } catch (reason) { setError(scheduledTaskErrorMessage(reason, "读取任务会话失败")); }
    finally { setSessionLoading(false); }
  }, [host]);

  useEffect(() => {
    void refreshTasks();
    const timer = window.setInterval(() => { void refreshTasks(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshTasks]);

  useEffect(() => {
    if (!taskContextMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setTaskContextMenu(null); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [taskContextMenu]);

  useEffect(() => {
    onActiveTask?.(selectedTask);
  }, [onActiveTask, selectedTask]);

  useEffect(() => {
    if (!selectedTask) { setTimeline([]); setHistoryCursor(null); setHistoryHasMore(false); return; }
    setExpandedTurnIds(new Set()); setCollapsedActiveTurnId(null); setExpandedActivityIds(new Set()); setInteractionBusyId(null);
    if (sharedConversationMode) {
      setTimeline([]); setHistoryCursor(null); setHistoryHasMore(false);
      if (!selectedTask.sessionId) void ensureTaskSession(selectedTask.id);
      return;
    }
    if (selectedTask.sessionId) { void loadSession(selectedTask.sessionId); return; }
    setTimeline([]); setHistoryCursor(null); setHistoryHasMore(false);
    void ensureTaskSession(selectedTask.id);
  }, [ensureTaskSession, loadSession, selectedTask?.id, selectedTask?.sessionId, sharedConversationMode]);

  useEffect(() => {
    if (sharedConversationMode) return;
    if (!selectedTask?.sessionId) return;
    const sessionId = selectedTask.sessionId;
    const handleEvent = (event: AgentEvent) => {
      if (!("sessionId" in event) || event.sessionId !== sessionId) return;
      if (event.type === "session.state") setSessionRunning(event.state === "running" || event.state === "starting");
      if (event.type === "message.started") {
        setTimeline((current) => {
          const existing = current.find((entry) => entry.kind === "message" && entry.id === event.messageId);
          if (existing) return current;
          const message: SessionTimelineEntry = { kind: "message", id: event.messageId, sequence: nextTimelineSequence(current, event.sequence), ...(event.turnId ? { turnId: event.turnId } : {}), occurredAt: event.occurredAt ?? new Date().toISOString(), role: event.role, text: "", complete: false, ...(event.attachments?.length ? { attachments: event.attachments } : {}), ...(event.browserElements?.length ? { browserElements: event.browserElements } : {}) };
          return upsertTimelineEntry(current, message);
        });
      } else if (event.type === "message.delta") {
        setTimeline((current) => current.map((entry) => entry.kind === "message" && entry.id === event.messageId ? { ...entry, text: entry.text + event.text } : entry));
      } else if (event.type === "message.completed") {
        setTimeline((current) => current.map((entry) => entry.kind === "message" && entry.id === event.messageId ? { ...entry, complete: true, completedAt: event.occurredAt ?? new Date().toISOString() } : entry));
        window.setTimeout(() => { void loadSession(sessionId); }, 250);
      } else if (event.type === "session.turn.diff.updated") {
        setTimeline((current) => {
          const id = `turn-diff-${encodeURIComponent(event.turnId)}`;
          const existing = current.find((entry) => entry.kind === "turnDiff" && entry.id === id);
          return upsertTimelineEntry(current, { kind: "turnDiff", id, sequence: existing?.sequence ?? nextTimelineSequence(current, event.sequence), turnId: event.turnId, occurredAt: existing?.kind === "turnDiff" ? existing.occurredAt : event.occurredAt ?? new Date().toISOString(), diff: event.diff, ...(event.truncated ? { truncated: true } : {}) });
        });
      } else if (event.type === "session.plan.updated") {
        setTimeline((current) => {
          const existing = current.find((entry) => entry.kind === "plan" && entry.id === event.planId);
          return upsertTimelineEntry(current, { kind: "plan", id: event.planId, sequence: existing?.sequence ?? nextTimelineSequence(current, event.sequence), ...(event.turnId ? { turnId: event.turnId } : existing?.kind === "plan" && existing.turnId ? { turnId: existing.turnId } : {}), occurredAt: existing?.kind === "plan" ? existing.occurredAt : event.occurredAt ?? new Date().toISOString(), ...(event.explanation ? { explanation: event.explanation } : {}), steps: event.steps });
        });
      } else if (event.type === "tool.started") {
        setTimeline((current) => upsertTimelineEntry(current, { kind: "tool", id: event.toolCallId, sequence: nextTimelineSequence(current, event.sequence), ...(event.turnId ? { turnId: event.turnId } : {}), occurredAt: event.occurredAt ?? new Date().toISOString(), name: event.title ?? event.name, state: "running", ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}), ...(event.input !== undefined ? { input: event.input } : {}) }));
      } else if (event.type === "tool.updated") {
        setTimeline((current) => current.map((entry) => entry.kind === "tool" && entry.id === event.toolCallId ? {
          ...entry,
          ...(event.parentToolCallId !== undefined ? { parentToolCallId: event.parentToolCallId } : {}),
          ...(event.input !== undefined ? { input: event.input } : {}),
          ...(event.output !== undefined ? { output: event.output } : {}),
          ...(event.outputDelta !== undefined ? { output: `${typeof entry.output === "string" ? entry.output : ""}${event.outputDelta}` } : {}),
          ...(event.terminalExitCode !== undefined ? { terminalExitCode: event.terminalExitCode } : {}),
        } : entry));
      } else if (event.type === "tool.completed") {
        setTimeline((current) => current.map((entry) => entry.kind === "tool" && entry.id === event.toolCallId ? { ...entry, state: event.isError ? "error" : "done", ...(event.output !== undefined ? { output: event.output } : {}), ...(event.terminalExitCode !== undefined ? { terminalExitCode: event.terminalExitCode } : {}) } : entry));
      } else if (event.type === "ui.status" && event.text && (event.key === "agent-activity" || event.key.startsWith("claude-subagent:"))) {
        setTimeline((current) => {
          const isSubagent = event.key.startsWith("claude-subagent:");
          const id = isSubagent ? `subagent-${encodeURIComponent(event.key)}` : `status-${event.sequence ?? nextTimelineSequence(current)}`;
          const existing = current.find((entry) => entry.kind === "status" && entry.id === id);
          return upsertTimelineEntry(current, { kind: "status", id, sequence: existing?.sequence ?? nextTimelineSequence(current, event.sequence), ...(event.turnId ? { turnId: event.turnId } : existing?.turnId ? { turnId: existing.turnId } : {}), occurredAt: existing?.occurredAt ?? event.occurredAt ?? new Date().toISOString(), key: event.key, text: event.text!, ...(event.subagentSessionId ? { subagentSessionId: event.subagentSessionId } : {}), ...(event.subagentCancellable !== undefined ? { subagentCancellable: event.subagentCancellable } : existing?.kind === "status" && existing.subagentCancellable !== undefined ? { subagentCancellable: existing.subagentCancellable } : {}), ...(event.subagentState ? { subagentState: event.subagentState } : {}) });
        });
      } else if (event.type === "interaction.requested") {
        setTimeline((current) => upsertTimelineEntry(current, { kind: "interaction", id: event.interactionId, sequence: nextTimelineSequence(current, event.sequence), ...(event.turnId ? { turnId: event.turnId } : {}), occurredAt: event.occurredAt ?? new Date().toISOString(), interaction: event.interaction, state: "pending" }));
      } else if (event.type === "interaction.responded") {
        setTimeline((current) => current.map((entry) => entry.kind === "interaction" && entry.id === event.interactionId ? { ...entry, state: event.value === null ? "cancelled" : "responded", response: event.value, ...(event.reason ? { reason: event.reason } : {}) } : entry));
      } else if (event.type === "provider.error" || (event.type === "notification" && event.level !== "info")) {
        setTimeline((current) => upsertTimelineEntry(current, { kind: "notice", id: `notice-${event.sequence ?? nextTimelineSequence(current)}`, sequence: nextTimelineSequence(current, event.sequence), ...(event.turnId ? { turnId: event.turnId } : {}), occurredAt: event.occurredAt ?? new Date().toISOString(), level: event.type === "notification" ? event.level : "error", message: event.message }));
      }
    };
    return host.onEvent(handleEvent);
  }, [host, loadSession, selectedTask?.sessionId, sharedConversationMode]);

  useEffect(() => {
    if (!sessionRunning) return;
    const timer = window.setInterval(() => setDurationNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sessionRunning]);

  useEffect(() => {
    const element = timelineRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [timeline.length, latestMessageText]);

  useEffect(() => {
    if (!formOpen) {
      const target = focusReturnRef.current;
      if (target?.isConnected) requestAnimationFrame(() => target.focus());
      return;
    }
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Let an open picker dismiss itself before closing the whole dialog.
        if (document.querySelector(".scheduled-time-zone-menu, .setting-select.is-open, .session-preferences-menu")) return;
        if (!saving) setFormOpen(false);
        return;
      }
      if (event.key !== "Tab" || document.querySelector(".scheduled-time-zone-menu")) return;
      const focusable = [...(modalRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])") ?? [])]
        .filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !modalRef.current?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !modalRef.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", handleDialogKeys);
    return () => document.removeEventListener("keydown", handleDialogKeys);
  }, [formOpen, saving]);

  function openCreateForm() {
    focusReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingTaskId(null); setPrompt(""); setProviderId(""); setThinkingLevel(null); setModelId(""); setModeId(null); setAvailableModes([]); setFrequency("daily"); setWeekday(1); setTime("09:00"); setTimeZone(localTimeZone);
    setProjectId(activeProjectId);
    setError(null);
    setFormOpen(true);
  }

  function openEditForm(task: ScheduledTask) {
    focusReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingTaskId(task.id); setPrompt(task.prompt); setProjectId(task.projectId); setProviderId(task.providerId); setModelId(task.modelId ?? "");
    setFrequency(task.frequency); setWeekday(task.weekday ?? 1); setTime(task.time); setTimeZone(task.timeZone || localTimeZone); setError(null);
    setFormOpen(true);
  }

  function chooseProvider(nextId: string) {
    setProviderId(nextId); setModelId(""); setThinkingLevel(null); setModeId(null); setAvailableModes([]); setError(null);
  }

  function chooseModel(selection: DraftSessionSelection) {
    setModelId(selection.modelId ?? ""); setThinkingLevel(selection.thinkingLevel);
    setModeId(selection.modeId); setAvailableModes(selection.availableModes);
  }

  async function saveTask() {
    if (!prompt.trim() || (!editingTaskId && !providerId)) return;
    setSaving(true); setError(null);
    try {
      if (editingTaskId) {
        const updated = await host.request("scheduled-tasks.update", { taskId: editingTaskId, prompt: prompt.trim(), frequency, weekday: frequency === "weekly" ? weekday : null, time, timeZone });
        setTasks((current) => current.map((item) => item.id === updated.id ? updated : item));
        setEditingTaskId(null); setFormOpen(false);
        return;
      }
      let selectedModelId = modelId;
      let selectedThinkingLevel = thinkingLevel;
      let selectedModeId = modeId;
      if (!selectedModelId) {
        const catalog = await host.request("providers.models", { providerId });
        const selectedModel = catalog.models.find((model) => model.id === catalog.currentModelId) ?? catalog.models[0];
        if (!selectedModel) throw new Error(i18n.t("当前框架没有可用模型，请刷新模型列表后重试。"));
        selectedModelId = selectedModel.id;
        selectedThinkingLevel = [selectedThinkingLevel, catalog.currentThinkingLevel, "medium"].find((level) => level != null && selectedModel.thinkingLevels?.includes(level)) ?? null;
        const modes = catalog.availableModes ?? [];
        selectedModeId = defaultSessionModeId(providerId, modes, catalog.currentModeId);
        setModelId(selectedModelId); setThinkingLevel(selectedThinkingLevel);
        setAvailableModes(modes); setModeId(selectedModeId);
      }
      const task = await host.request("scheduled-tasks.create", { projectId, prompt: prompt.trim(), providerId, modelId: selectedModelId, thinkingLevel: selectedThinkingLevel, modeId: selectedModeId, frequency, weekday: frequency === "weekly" ? weekday : null, time, timeZone, enabled: true });
      setTasks((current) => [task, ...current]); setSelectedTaskId(task.id);
      setEditingTaskId(null); setPrompt(""); setProviderId(""); setThinkingLevel(null); setModelId(""); setFrequency("daily"); setTime("09:00"); setTimeZone(localTimeZone); setFormOpen(false);
    } catch (reason) { setError(scheduledTaskErrorMessage(reason, "创建定时任务失败")); }
    finally { setSaving(false); }
  }

  async function toggleTask(task: ScheduledTask) {
    try {
      const updated = await host.request("scheduled-tasks.set-enabled", { taskId: task.id, enabled: !task.enabled });
      setTasks((current) => current.map((item) => item.id === task.id ? updated : item));
    } catch (reason) { setError(scheduledTaskErrorMessage(reason, "更新任务失败")); }
  }

  function openTaskContextMenu(event: MouseEvent<HTMLElement>, task: ScheduledTask, anchorToTarget = false) {
    event.preventDefault();
    onHideTooltip();
    const width = 238;
    const height = 166;
    const rect = event.currentTarget.getBoundingClientRect();
    const left = anchorToTarget ? rect.right - width : event.clientX;
    const top = anchorToTarget ? rect.bottom + 4 : event.clientY;
    setTaskContextMenu({ taskId: task.id, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - height - 8)) });
  }

  async function runTaskNow(task: ScheduledTask) {
    setTaskContextMenu(null); setError(null); setRunNowTaskId(task.id);
    try {
      const updated = await host.request("scheduled-tasks.run-now", { taskId: task.id });
      setTasks((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (updated.lastRunStatus === "error") setError(scheduledTaskErrorMessage(updated.lastRunError, "任务执行失败"));
    } catch (reason) { setError(scheduledTaskErrorMessage(reason, "立即执行任务失败")); }
    finally { setRunNowTaskId(null); }
  }

  function deleteTask(task: ScheduledTask) {
    setTaskContextMenu(null); setError(null); setDeleteError(null); setDeleteTarget(task);
  }

  async function confirmDeleteTask() {
    if (!deleteTarget || deleteBusy) return;
    const task = deleteTarget;
    setDeleteBusy(true); setDeleteError(null);
    try {
      await host.request("scheduled-tasks.delete", { taskId: task.id });
      setTasks((current) => current.filter((item) => item.id !== task.id));
      setSelectedTaskId((current) => current === task.id ? tasks.find((item) => item.id !== task.id)?.id ?? null : current);
      if (selectedTaskId === task.id) setTimeline([]);
      setDeleteTarget(null);
    } catch (reason) { setDeleteError(scheduledTaskErrorMessage(reason, "彻底删除任务失败")); }
    finally { setDeleteBusy(false); }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selectedTask?.sessionId || sending) return;
    setDraft(""); setSending(true); setError(null);
    try {
      await host.request("sessions.send", { sessionId: selectedTask.sessionId, text });
      setSessionRunning(true);
    } catch (reason) { setDraft(text); setError(scheduledTaskErrorMessage(reason, "发送消息失败")); }
    finally { setSending(false); }
  }

  async function cancelRun() {
    if (!selectedTask?.sessionId) return;
    try { await host.request("sessions.cancel", { sessionId: selectedTask.sessionId }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : i18n.t("停止当前 Agent")); }
  }

  async function respondInteraction(interactionId: string, value: string | boolean | null) {
    if (!selectedTask?.sessionId) return;
    setInteractionBusyId(interactionId);
    try { await host.request("interactions.respond", { sessionId: selectedTask.sessionId, interactionId, value }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : i18n.t("提交失败")); }
    finally { setInteractionBusyId(null); }
  }

  function toggleTurn(turnId: string) {
    const duration = turnDurations.get(turnId);
    if (duration?.active) setCollapsedActiveTurnId((current) => current === turnId ? null : turnId);
    else setExpandedTurnIds((current) => {
      const next = new Set(current);
      if (next.has(turnId)) next.delete(turnId); else next.add(turnId);
      return next;
    });
  }

  const loadDeferredMessage = useCallback(async (message: { id: string }) => {
    const sessionId = selectedTask?.sessionId;
    if (!sessionId) throw new Error(i18n.t("任务会话尚未就绪"));
    const full = await host.request("sessions.entry", { sessionId, entryId: message.id });
    if (full.kind !== "message") throw new Error(i18n.t("消息内容暂时无法读取"));
    setTimeline((current) => current.map((entry) => entry.kind === "message" && entry.id === full.id ? full : entry));
  }, [host, selectedTask?.sessionId]);

  function renderTimelineRow(index: number) {
    const entry = conversationEntries[index]!;
    if (entry.kind === "duration") {
      const label = formatTaskDuration(entry.startedAt, entry.completedAt, durationNow, entry.active);
      const expanded = entry.active ? collapsedActiveTurnId !== entry.turnId : expandedTurnIds.has(entry.turnId);
      return label ? <div className={`turn-duration${entry.active ? " is-active" : ""}`} role="status" aria-live={entry.active ? "polite" : undefined}><button type="button" aria-expanded={expanded} onClick={() => toggleTurn(entry.turnId)}><span>{label}</span>{expanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}</button></div> : null;
    }
    const lastInSequence = !isConversationActivity(conversationEntries[index + 1]);
    if (entry.kind === "interaction") return <InteractionCard item={entry.value} connected busy={interactionBusyId === entry.value.id} onRespond={(value) => void respondInteraction(entry.value.id, value)} />;
    if (entry.kind === "notice") return <article className={`conversation-notice is-${entry.value.level}`} role={entry.value.level === "error" ? "alert" : "status"}><span className="conversation-notice-mark"><AlertCircle size={15} /></span><p>{entry.value.message}</p></article>;
    if (entry.kind === "plan") return <PlanActivityLine plan={entry.value} />;
    if (entry.kind === "turnDiff") return <TurnDiffActivityLine diff={entry.value} active={Boolean(turnDurations.get(entry.value.turnId)?.active)} />;
    if (entry.kind === "status") return entry.value.subagentSessionId
      ? <SubagentActivityLine status={entry.value} lastInSequence={lastInSequence} onCancel={async (subagentSessionId) => {
        if (!selectedTask?.sessionId) return;
        try { await host.request("sessions.cancel-subagent", { sessionId: selectedTask.sessionId, subagentSessionId }); }
        catch (reason) { setError(scheduledTaskErrorMessage(reason, "停止当前 Agent")); }
      }} />
      : <ThinkingMarker status={entry.value} active={sessionRunning && latestConversationEntry?.kind === "status" && latestConversationEntry.value.id === entry.value.id} lastInSequence={lastInSequence} />;
    if (entry.kind === "tool") return <ToolActivityLine activity={entry.value} lastInSequence={lastInSequence} expanded={expandedActivityIds.has(entry.value.id)} onToggle={() => setExpandedActivityIds((current) => { const next = new Set(current); if (next.has(entry.value.id)) next.delete(entry.value.id); else next.add(entry.value.id); return next; })} />;
    const message = entry.value;
    return <article data-user-query-id={message.role === "user" ? message.id : undefined} className={`message ${message.role}`}><MessageContent message={message} onLoadDeferred={loadDeferredMessage} onOpenUrl={onOpenUrl} /></article>;
  }

  return <>
    <main className={`scheduled-workspace${sharedConversationMode ? " is-sidebar-only" : ""}`} style={sharedConversationMode && sidebarWidth ? { "--scheduled-sidebar-width": `${sidebarWidth}px` } as CSSProperties : undefined}>
      <aside className="scheduled-sidebar">
        <header className="scheduled-sidebar-header"><div className="scheduled-sidebar-title"><CalendarClock size={18} /><h1>{i18n.t("定时任务")}</h1></div><button type="button" className="scheduled-add-button" title={i18n.t("新建任务")} aria-label={i18n.t("新建任务")} onClick={openCreateForm}><Plus size={17} /></button></header>
        <p className="scheduled-sidebar-section-title"><span>{i18n.t("你的计划")}</span>{!loading && tasks.length > 0 && <span className="scheduled-sidebar-count">{tasks.length}</span>}</p>
        {loading && !tasks.length ? <div className="scheduled-sidebar-empty"><LoaderCircle size={16} className="scheduled-spinner" />{i18n.t("正在读取定时任务…")}</div> : tasks.length === 0 ? <div className="scheduled-sidebar-empty"><CalendarClock size={17} aria-hidden="true" /><span>{i18n.t("还没有定时任务")}</span><button type="button" onClick={openCreateForm}>{i18n.t("创建第一个任务")}</button></div> : <nav className="scheduled-task-nav" aria-label={i18n.t("定时任务")}>
          {tasks.map((task) => <div key={task.id} className={`scheduled-task-nav-item${task.id === selectedTask?.id ? " is-selected" : ""}`} onContextMenu={(event) => openTaskContextMenu(event, task)}>
            <button type="button" className="scheduled-task-nav-select" aria-current={task.id === selectedTask?.id ? "true" : undefined} onClick={() => setSelectedTaskId(task.id)}>
              <span className={`scheduled-task-dot${task.enabled ? " is-enabled" : ""}`} />
              <span className="scheduled-task-nav-copy"><strong>{task.title || task.prompt}</strong><small><Clock3 size={12} aria-hidden="true" />{i18n.t(frequencyLabels[task.frequency])}<i aria-hidden="true" />{task.time}<i aria-hidden="true" />{timeZoneCityLabel(task.timeZone)}</small></span>
            </button>
            <button type="button" className="scheduled-task-nav-more" title="" aria-label={i18n.t("更多操作：{{title}}", { title: task.title || task.prompt })} aria-haspopup="menu" aria-expanded={taskContextMenu?.taskId === task.id} onMouseEnter={(event) => onShowTooltip(event, i18n.t("更多操作"))} onMouseLeave={onHideTooltip} onClick={(event) => { event.stopPropagation(); onHideTooltip(); openTaskContextMenu(event, task, true); }}><Ellipsis size={17} /></button>
          </div>)}
        </nav>}
      </aside>

      {!sharedConversationMode && <section className="scheduled-conversation">
        {selectedTask ? <>
          <header className="conversation-header scheduled-conversation-header">
            <div className="scheduled-header-copy">
              <div className="scheduled-conversation-title">
                <h2 title={selectedTask.title || selectedTask.prompt}>{selectedTask.title || selectedTask.prompt}</h2>
                <span className={`scheduled-task-state${selectedTask.enabled ? " is-on" : ""}`}>{selectedTask.enabled ? i18n.t("已启用") : i18n.t("已暂停")}</span>
              </div>
              <div className="scheduled-header-meta" aria-live="polite">
                {selectedTask.lastRunStatus && <span className={`scheduled-task-run-badge is-${selectedTask.lastRunStatus}`}>
                  <span className="scheduled-status-dot" aria-hidden="true" />
                  {selectedTask.lastRunStatus === "running" ? i18n.t("运行中") : i18n.t(runStatusLabels[selectedTask.lastRunStatus])}
                </span>}
                <span className="scheduled-next-run" title={`${selectedTask.timeZone} · ${timeZoneOffsetLabel(selectedTask.timeZone)}`}>
                  <Clock3 size={13} aria-hidden="true" />
                  {i18n.t("下次运行：{{date}}", { date: localScheduleDate(selectedTask.nextRunAt, selectedTask.timeZone) })}
                </span>
              </div>
            </div>
            <div className="scheduled-conversation-actions" role="toolbar" aria-label={i18n.t("定时任务操作")}>
              <button type="button" title="" aria-label={i18n.t("编辑任务设置")} onMouseEnter={(event) => onShowTooltip(event, i18n.t("编辑任务设置"))} onMouseLeave={onHideTooltip} onClick={() => { onHideTooltip(); openEditForm(selectedTask); }}><Pencil size={15} /></button>
              <button type="button" title="" aria-label={selectedTask.enabled ? i18n.t("暂停") : i18n.t("启用")} onMouseEnter={(event) => onShowTooltip(event, selectedTask.enabled ? i18n.t("暂停") : i18n.t("启用"))} onMouseLeave={onHideTooltip} onClick={() => { onHideTooltip(); void toggleTask(selectedTask); }}>{selectedTask.enabled ? <Pause size={15} /> : <Play size={15} />}</button>
              <button type="button" className="is-danger" title="" aria-label={i18n.t("删除任务")} onMouseEnter={(event) => onShowTooltip(event, i18n.t("删除任务"))} onMouseLeave={onHideTooltip} onClick={() => { onHideTooltip(); void deleteTask(selectedTask); }}><Trash2 size={15} /></button>
              <span className="scheduled-actions-divider" aria-hidden="true" />
              <button type="button" title="" aria-label={i18n.t("返回聊天")} onMouseEnter={(event) => onShowTooltip(event, i18n.t("返回聊天"))} onMouseLeave={onHideTooltip} onClick={() => { onHideTooltip(); onClose(); }}><X size={17} /></button>
            </div>
          </header>
          {error && <div className="scheduled-error" role="alert"><span>{error}</span><button type="button" onClick={() => selectedTask && void ensureTaskSession(selectedTask.id)} aria-label={i18n.t("重试")}>{i18n.t("重试")}</button><button type="button" onClick={() => setError(null)} aria-label={i18n.t("关闭")}>×</button></div>}
          {(selectedTask.lastRunStatus === "error" || selectedTask.lastRunStatus === "interrupted") && <div className={`scheduled-run-alert is-${selectedTask.lastRunStatus}`} role="status"><div><strong>{i18n.t(runStatusLabels[selectedTask.lastRunStatus])}</strong>{selectedTask.lastRunAt && <small>{localScheduleDate(selectedTask.lastRunAt, selectedTask.timeZone)}</small>}</div><p>{scheduledTaskErrorMessage(selectedTask.lastRunError, "Vagus 关闭或 Agent 中断，任务没有完成提交。")}</p>{!selectedTask.enabled && <button type="button" onClick={() => void toggleTask(selectedTask)}>{i18n.t("启用")}</button>}</div>}
          <div className="scheduled-timeline conversation-body" ref={timelineRef}>
            <div className="scheduled-message-flow">
              {historyHasMore && <button type="button" className="scheduled-history-more" disabled={historyLoading || !historyCursor} onClick={() => historyCursor && selectedTask.sessionId && void loadSession(selectedTask.sessionId, historyCursor)}>{historyLoading ? i18n.t("正在加载…") : i18n.t("加载更早的消息")}</button>}
              {sessionLoading ? <div className="scheduled-session-empty"><LoaderCircle size={19} className="scheduled-spinner" /><span>{i18n.t("正在读取任务会话…")}</span></div> : visibleConversationRows.length ? <VirtualConversation rows={visibleConversationRows} scrollRef={timelineRef} layoutKey={selectedTask.id} renderRow={renderTimelineRow} /> : <div className="scheduled-session-empty"><span className="scheduled-session-mark"><MessageSquare size={20} /></span><strong>{i18n.t("这是任务专属会话")}</strong><p>{i18n.t("定时运行的内容和你在这里补充的消息，都会保存在同一段对话中。")}</p><small>{selectedTask.prompt}</small></div>}
            </div>
          </div>
          <div className="composer-wrap scheduled-composer-wrap"><div className="composer-workspace-row"><span className="scheduled-readonly-composer-item"><Folder size={15} /><span>{projects.find((item) => item.id === selectedTask.projectId)?.name ?? i18n.t("用户主目录")}</span></span><span className="composer-workspace-divider" /><span className="provider-pill">{providers.find((item) => item.id === selectedTask.providerId)?.displayName ?? selectedTask.providerId}</span></div><form className="composer scheduled-composer" onSubmit={(event) => void sendMessage(event)}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} disabled={!selectedTask.sessionId} placeholder={selectedTask.sessionId ? i18n.t("给这个定时任务的会话发送消息…") : i18n.t("正在准备任务会话…")} rows={Math.min(6, Math.max(1, draft.split("\n").length))} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><div className="composer-footer"><div className="composer-left"><span className="scheduled-composer-context">{sessionRunning ? i18n.t("Agent 正在运行") : selectedTask.modelId}</span>{selectedTask.sessionId && <ScheduledSessionModeControl host={host} sessionId={selectedTask.sessionId} providerId={selectedTask.providerId} disabled={sessionRunning} onError={setError} />}</div><div className="composer-right">{sessionRunning ? <button className="send-button is-stop" type="button" onClick={() => void cancelRun()} aria-label={i18n.t("停止当前 Agent")} title={i18n.t("停止当前 Agent")}><Square size={14} /></button> : <button className="send-button" type="submit" disabled={!selectedTask.sessionId || !draft.trim() || sending} aria-label={i18n.t("发送")} title={i18n.t("发送")}>{sending ? <LoaderCircle size={16} className="scheduled-spinner" /> : <Send size={16} />}</button>}</div></div></form></div>
        </> : <div className="scheduled-no-selection"><CalendarClock size={25} /><strong>{i18n.t("选择一个定时任务")}</strong><p>{i18n.t("每个定时任务都有自己的会话与运行记录。")}</p><button type="button" className="scheduled-primary-button" onClick={openCreateForm}><Plus size={15} />{i18n.t("新建任务")}</button></div>}
      </section>}

      {formOpen && <div className="scheduled-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setFormOpen(false); }}><section className="scheduled-modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="scheduled-form-title">
        <header className="scheduled-modal-header"><div><h2 id="scheduled-form-title">{i18n.t(isEditingTask ? "编辑定时任务" : "新建定时任务")}</h2><p>{i18n.t(isEditingTask ? "修改计划和后续运行内容，会继续使用这个任务原有的专属会话。" : "为任务设置独立会话和运行时间。")}</p></div><button type="button" className="scheduled-icon-button" aria-label={i18n.t("关闭")} disabled={saving} onClick={() => setFormOpen(false)}><X size={18} /></button></header>
        {error && <div className="scheduled-error" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label={i18n.t("关闭")}>×</button></div>}
        <label className="scheduled-field"><span>{i18n.t("任务内容")}</span><textarea autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={i18n.t("描述 Agent 应该定时完成的工作…")} rows={4} /></label>
        {editingTask ? <div className="scheduled-fixed-context"><span>{i18n.t("工作空间与框架")}</span><strong>{projects.find((project) => project.id === editingTask.projectId)?.name ?? i18n.t("用户主目录")}</strong><small>{providers.find((provider) => provider.id === editingTask.providerId)?.displayName ?? editingTask.providerId}</small><p>{i18n.t("工作空间和 Agent 框架在任务创建后保持不变；模型与思考程度请在任务会话输入框旁调整。")}</p></div> : isEditingTask ? <div className="scheduled-error" role="alert">{i18n.t("此任务已不存在，无法保存更改。")}</div> : <div className="scheduled-context-row"><span>{i18n.t("工作空间")}</span><SettingSelect className="scheduled-form-select" label={i18n.t("工作空间")} value={projectId ?? ""} onChange={(value) => setProjectId(value || null)} options={[{ value: "", label: i18n.t("用户主目录") }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} /><small>{activeProject?.root ?? i18n.t("任务将在用户主目录中运行")}</small></div>}
        <section className="scheduled-block" aria-label={i18n.t("运行时间")}>
          <div className="scheduled-row"><span>{i18n.t("重复")}</span><SettingSelect className="scheduled-row-select" label={i18n.t("重复")} value={frequency} onChange={(value) => setFrequency(value as ScheduledTaskFrequency)} options={Object.entries(frequencyLabels).map(([value, label]) => ({ value, label: i18n.t(label) }))} /></div>
          {frequency === "weekly" && <div className="scheduled-row"><span>{i18n.t("运行日")}</span><SettingSelect className="scheduled-row-select" label={i18n.t("运行日")} value={String(weekday)} onChange={(value) => setWeekday(Number(value))} options={weekdays.map((day, index) => ({ value: String(index), label: i18n.t(day) }))} /></div>}
          <div className="scheduled-row"><span>{i18n.t("时间")}</span><span className="scheduled-time-control"><SettingSelect className="scheduled-time-part" label={i18n.t("小时")} value={scheduleHour ?? "09"} onChange={(value) => setTime(`${value}:${scheduleMinute ?? "00"}`)} options={Array.from({ length: 24 }, (_, hour) => { const value = String(hour).padStart(2, "0"); return { value, label: value }; })} /><span className="scheduled-time-separator">:</span><SettingSelect className="scheduled-time-part" label={i18n.t("分钟")} value={scheduleMinute ?? "00"} onChange={(value) => setTime(`${scheduleHour ?? "09"}:${value}`)} options={Array.from({ length: 60 }, (_, minute) => { const value = String(minute).padStart(2, "0"); return { value, label: value }; })} /><TimeZonePicker value={timeZone} localTimeZone={localTimeZone} onChange={setTimeZone} /></span></div>
        </section>
        {!isEditingTask && <div className="scheduled-provider-model">
          <label className="scheduled-field"><span>{i18n.t("框架")}</span><SettingSelect className="scheduled-form-select" label={i18n.t("框架")} value={providerId} onChange={chooseProvider} options={[{ value: "", label: i18n.t("先选择 Agent 框架") }, ...availableProviders.map((provider) => ({ value: provider.id, label: provider.displayName }))]} /></label>
          <div className="scheduled-field"><span>{i18n.t("模型与思考程度")}</span><DraftSessionControls host={host} providerId={providerId} supported={Boolean(providerId)} disabled={saving} className="scheduled-model-controls" onChange={chooseModel} /></div>
        </div>}
        {!isEditingTask && availableModes.length > 0 && <label className="scheduled-field scheduled-mode-field"><span>{i18n.t("工作模式")}</span><SettingSelect className="scheduled-form-select" label={i18n.t("工作模式")} value={modeId ?? ""} onChange={(value) => { setModeId(value); saveProviderSessionPreference(providerId, { modeId: value }); }} options={availableModes.map((mode) => ({ value: mode.id, label: i18n.t(mode.name) }))} /></label>}

        <p className="scheduled-local-note">{i18n.t("Vagus 开启时在此电脑运行；每次定时执行和手动追问都会进入同一个任务会话。")}</p>
        <footer className="scheduled-modal-footer"><span>{i18n.t("计划时间：{{time}} · {{zone}}", { time: `${frequency === "weekly" ? `${i18n.t(weekdays[weekday]!)} ` : ""}${time}`, zone: `${timeZoneCityLabel(timeZone)} ${timeZoneOffsetLabel(timeZone)}` })}</span><div><button type="button" className="scheduled-secondary-button" disabled={saving} onClick={() => setFormOpen(false)}>{i18n.t("取消")}</button><button type="button" className="scheduled-primary-button" disabled={!prompt.trim() || (isEditingTask ? !editingTask : !providerId) || saving} onClick={() => void saveTask()}>{saving ? <LoaderCircle size={15} className="scheduled-spinner" /> : <Check size={15} />}{i18n.t(isEditingTask ? "保存更改" : "创建任务")}</button></div></footer>
      </section></div>}
    </main>
    {taskContextMenu && tasks.some((task) => task.id === taskContextMenu.taskId) && createPortal(<>
      <button className="project-menu-dismiss" aria-label={i18n.t("关闭菜单")} onClick={() => setTaskContextMenu(null)} />
      <div className="project-context-menu scheduled-task-context-menu" role="menu" aria-label={i18n.t("定时任务操作")} style={{ left: taskContextMenu.left, top: taskContextMenu.top }}>
        <button role="menuitem" disabled={tasks.find((task) => task.id === taskContextMenu.taskId)?.lastRunStatus === "running"} onClick={() => { const task = tasks.find((item) => item.id === taskContextMenu.taskId); setTaskContextMenu(null); if (task) void toggleTask(task); }}>{tasks.find((task) => task.id === taskContextMenu.taskId)?.enabled ? <Pause size={17} /> : <Play size={17} />}<span>{tasks.find((task) => task.id === taskContextMenu.taskId)?.enabled ? i18n.t("暂停") : i18n.t("启用")}</span></button>
        <button role="menuitem" disabled={tasks.find((task) => task.id === taskContextMenu.taskId)?.lastRunStatus === "running" || runNowTaskId === taskContextMenu.taskId} onClick={() => { const task = tasks.find((item) => item.id === taskContextMenu.taskId); if (task) void runTaskNow(task); }}><Play size={17} /><span>{runNowTaskId === taskContextMenu.taskId ? i18n.t("正在执行…") : i18n.t("立即执行")}</span></button>
        <button role="menuitem" onClick={() => { const task = tasks.find((item) => item.id === taskContextMenu.taskId); setTaskContextMenu(null); if (task) { setSelectedTaskId(task.id); openEditForm(task); } }}><Pencil size={17} /><span>{i18n.t("编辑")}</span></button>
        <div className="project-context-menu-separator" />
        <button role="menuitem" className="is-destructive" onClick={() => { const task = tasks.find((item) => item.id === taskContextMenu.taskId); if (task) deleteTask(task); }}><Trash2 size={17} /><span>{i18n.t("删除")}</span></button>
      </div>
    </>, document.body)}
    {deleteTarget && createPortal(<div className="overlay archive-confirm-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleteBusy) setDeleteTarget(null); }}><section className="archive-delete-dialog scheduled-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="scheduled-delete-title" aria-describedby="scheduled-delete-description">
      <header><h2 id="scheduled-delete-title">{i18n.t("永久删除定时任务“{{title}}”？", { title: deleteTarget.title || deleteTarget.prompt })}</h2><button title={i18n.t("关闭")} aria-label={i18n.t("关闭")} disabled={deleteBusy} onClick={() => setDeleteTarget(null)}><X size={18} /></button></header>
      <p id="scheduled-delete-description">{i18n.t("这会永久删除定时计划、对应的 Vagus 会话记录和 {{provider}} 原生会话数据，无法撤销。项目文件不会删除。", { provider: providers.find((item) => item.id === deleteTarget.providerId)?.displayName ?? deleteTarget.providerId })}</p>
      {deleteError && <div className="dialog-error"><AlertCircle size={15} />{deleteError}</div>}
      <footer><button className="cancel-button" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>{i18n.t("取消")}</button><button className="archive-delete-confirm" disabled={deleteBusy} onClick={() => void confirmDeleteTask()}>{deleteBusy ? i18n.t("正在删除…") : i18n.t("删除")}</button></footer>
    </section></div>, document.body)}
  </>;
}
