import type {
  AgentRuntimeSettings,
  AgentUsage,
  BrowserElementReference,
  MessageAttachment,
  ProviderExtensionCatalog,
  ProviderModelCatalog,
  ProviderPluginCatalog,
  ProviderMcpCatalog,
  ProviderMcpServer,
  SessionQueryMarker,
  SessionQueueState,
  SessionTimelineEntry,
  SessionUiState,
} from "./index.js";

export interface Project {
  id: string;
  name: string;
  root: string;
  roots?: string[];
  createdAt: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  complete: boolean;
  sequence?: number;
  turnId?: string;
  occurredAt?: string;
  completedAt?: string;
  attachments?: MessageAttachment[];
  browserElements?: BrowserElementReference[];
}

/** Client-visible session state. Provider-native storage references are host-private. */
export interface WorkspaceSession {
  id: string;
  projectId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastAssistantAt?: string;
  lastUserAt?: string;
  hasAssistantReply?: boolean;
  archivedAt?: string;
  state: "starting" | "idle" | "running" | "ended" | string;
  messages?: Message[];
  timeline?: SessionTimelineEntry[];
  history?: { beforeSequence: number | null; hasMore: boolean };
  queryMarkers?: SessionQueryMarker[];
  eventSequence?: number;
  providerId?: string;
  /** Set only for the dedicated conversation owned by a local scheduled task. */
  scheduledTaskId?: string;
  runtimeSettings?: AgentRuntimeSettings;
  usage?: AgentUsage;
  queue?: SessionQueueState;
  ui?: SessionUiState;
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  enabled: boolean;
  health: "checking" | "healthy" | "unavailable";
  capabilities: Array<{ id: string; status: "implemented" | "partial" | "unsupported"; note?: string }>;
}

export type ScheduledTaskFrequency = "once" | "daily" | "weekdays" | "weekly";
export type ScheduledTaskRunStatus = "running" | "success" | "error" | "interrupted" | null;
export interface ScheduledTask {
  id: string;
  title: string;
  sessionId: string | null;
  projectId: string | null;
  prompt: string;
  providerId: string;
  modelId: string | null;
  thinkingLevel: string | null;
  modeId?: string | null;
  frequency: ScheduledTaskFrequency;
  weekday: number | null;
  time: string;
  timeZone: string;
  enabled: boolean;
  createdAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: ScheduledTaskRunStatus;
  lastRunError?: string;
  lastSessionId?: string;
}

export interface WorkspaceSnapshot {
  projects: Project[];
  sessions: WorkspaceSession[];
  providers: ProviderInfo[];
}

/** Provider-neutral summary of a locally discoverable native session. */
export interface ProviderImportCandidate {
  /** Short-lived opaque ID; native file paths remain inside the Host. */
  sourceId: string;
  providerId: string;
  title: string;
  workingDirectory: string;
  /** Additional ACP workspace roots, when the native agent reports them. */
  additionalDirectories?: string[];
  createdAt: string;
  updatedAt: string;
  /** Omitted when the native agent does not expose a count in its session index. */
  messageCount?: number;
  preview: string;
  alreadyImported?: boolean;
}

export interface HostCapabilities {
  sessionModelSelection: boolean;
  sessionUsage: boolean;
  sessionQueue: boolean;
  sessionContext: boolean;
  sessionCommands: boolean;
}

export interface SessionOpenResult extends WorkspaceSession {
  messages: Message[];
  timeline: SessionTimelineEntry[];
  history?: { beforeSequence: number | null; hasMore: boolean };
  queryMarkers?: SessionQueryMarker[];
  eventSequence: number;
}

export interface HostPerformanceSnapshot {
  requests: Record<string, { count: number; totalMs: number; maxMs: number }>;
  storage: unknown;
  eventLoop: { meanMs: number | null; p95Ms: number; maxMs: number };
  memory: Record<string, number>;
  loadedHistories: number;
}

export interface SessionSettingsResult { settings: AgentRuntimeSettings; state: string }
export interface SessionSendResult { accepted: boolean; disposition?: "submitted" | "queued" | "handled" }
export interface SessionCompactResult { compacted: true; usage: AgentUsage | null }
export interface SessionQueueResult { queue: SessionQueueState }
export interface ProjectArchiveResult { archived: number; sessionIds: string[] }
export interface DeleteResult { deleted: number }
export interface AcceptedResult { accepted: true }
export interface RemovedResult { removed: true }
export interface StoppingResult { stopping: true }

/** Publicly typed RPC contract. Runtime parsers and client generics are derived from this map. */
export interface RpcCommandMap {
  "host.authenticate": { input: { token: string; version: number }; output: { authenticated: true; version: number } };
  "host.capabilities": { input: {}; output: HostCapabilities };
  "host.performance": { input: { enabled?: boolean }; output: HostPerformanceSnapshot };
  "host.shutdown": { input: {}; output: StoppingResult };
  "workspace.snapshot": { input: {}; output: WorkspaceSnapshot };
  "workspace.git-review": { input: { projectId: string; scope: "staged" | "unstaged" }; output: import("./workspace-review.js").GitReview };
  "workspace.git-patch": { input: { projectId: string; scope: "staged" | "unstaged"; path: string }; output: import("./workspace-review.js").ReviewPatch };
  "providers.set-enabled": { input: { providerId: string; enabled: boolean }; output: ProviderInfo };
  "providers.models": { input: { providerId: string }; output: ProviderModelCatalog };
  "providers.models.refresh": { input: { providerId: string }; output: ProviderModelCatalog };
  "providers.extensions": { input: { providerId: string }; output: ProviderExtensionCatalog };
  "providers.plugins": { input: { providerId: string }; output: ProviderPluginCatalog };
  "providers.plugins.install": { input: { providerId: string; pluginId: string; scope?: import("./index.js").ProviderPluginScope; acceptCommandSha256?: string }; output: import("./index.js").ProviderPluginInstallResult };
  "providers.plugins.manage": { input: { providerId: string; pluginId: string; action: "enable" | "disable" | "uninstall"; scope?: import("./index.js").ProviderPluginScope }; output: import("./index.js").ProviderPluginMutationResult };
  "providers.plugins.marketplace": { input: { providerId: string; action: "add" | "update" | "remove"; source?: string; name?: string; scope?: import("./index.js").ProviderPluginScope }; output: import("./index.js").ProviderPluginMutationResult };
  "providers.mcp": { input: { providerId: string }; output: ProviderMcpCatalog };
  "providers.mcp.detail": { input: { providerId: string; serverName: string }; output: ProviderMcpServer };
  "providers.packages.install": { input: { providerId: string; source: string }; output: import("./index.js").ProviderPackageInstallResult };
  "providers.sessions.importable": { input: { providerId: string }; output: ProviderImportCandidate[] };
  "projects.create": { input: { name: string; root?: string; roots?: string[] }; output: Project };
  "projects.update": { input: { projectId: string; name: string; root?: string; roots?: string[] }; output: Project };
  "projects.remove": { input: { projectId: string }; output: RemovedResult };
  "sessions.create": { input: { projectId?: string | null; providerId?: string; modelId?: string | null; thinkingLevel?: string | null; modeId?: string | null }; output: WorkspaceSession };
  "scheduled-tasks.list": { input: {}; output: ScheduledTask[] };
  "scheduled-tasks.create": { input: { projectId: string | null; prompt: string; providerId: string; modelId: string; thinkingLevel?: string | null; modeId?: string | null; frequency: ScheduledTaskFrequency; weekday: number | null; time: string; timeZone: string; enabled: boolean }; output: ScheduledTask };
  "scheduled-tasks.update": { input: { taskId: string; prompt: string; frequency: ScheduledTaskFrequency; weekday: number | null; time: string; timeZone: string }; output: ScheduledTask };
  "scheduled-tasks.set-enabled": { input: { taskId: string; enabled: boolean }; output: ScheduledTask };
  "scheduled-tasks.run-now": { input: { taskId: string }; output: ScheduledTask };
  "scheduled-tasks.delete": { input: { taskId: string }; output: DeleteResult };
  "sessions.import": { input: { providerId: string; sourceId: string }; output: WorkspaceSession };
  "sessions.open": { input: { sessionId: string; historyLimit?: number }; output: SessionOpenResult };
  "sessions.history": { input: { sessionId: string; limit?: number; beforeSequence?: number }; output: import("./index.js").SessionHistoryPage };
  "sessions.entry": { input: { sessionId: string; entryId: string }; output: import("./index.js").SessionTimelineEntry };
  "sessions.subscribe": { input: { sessionId: string | null }; output: { subscribed: true } };
  "sessions.search": { input: { query?: string; archived?: boolean; limit?: number; offset?: number }; output: import("./index.js").SessionSearchPage };
  "sessions.branch": { input: { sessionId: string; messageId?: string }; output: WorkspaceSession };
  "sessions.archive": { input: { sessionId: string }; output: WorkspaceSession };
  "sessions.unarchive": { input: { sessionId: string }; output: WorkspaceSession };
  "sessions.rename": { input: { sessionId: string; title: string }; output: WorkspaceSession };
  "sessions.archive-in-project": { input: { projectId: string }; output: ProjectArchiveResult };
  "sessions.delete-archived": { input: { sessionId: string }; output: DeleteResult };
  "sessions.delete-permanent": { input: { sessionId: string }; output: DeleteResult };
  "sessions.delete-archived-in-project": { input: { projectId: string }; output: DeleteResult };
  "sessions.delete-archived-all": { input: {}; output: DeleteResult };
  "sessions.send": { input: { sessionId: string; text: string; clientMessageId?: string; deliveryMode?: "immediate" | "steer" | "follow-up"; attachments?: MessageAttachment[]; browserElements?: BrowserElementReference[] }; output: SessionSendResult };
  "sessions.clear-queue": { input: { sessionId: string }; output: SessionQueueResult };
  "sessions.cancel": { input: { sessionId: string }; output: { cancelled: true } };
  "sessions.cancel-subagent": { input: { sessionId: string; subagentSessionId: string }; output: { cancelled: true } };
  "sessions.get-settings": { input: { sessionId: string }; output: SessionSettingsResult };
  "sessions.get-commands": { input: { sessionId: string }; output: import("./index.js").AgentCommandInfo[] };
  "sessions.execute-command": { input: { sessionId: string; action: Exclude<NonNullable<import("./index.js").AgentCommandInfo["action"]>, "compact" | "fork">; input?: string }; output: { executed: true } };
  "sessions.get-usage": { input: { sessionId: string }; output: AgentUsage | null };
  "sessions.compact": { input: { sessionId: string; instructions?: string }; output: SessionCompactResult };
  "sessions.set-auto-compaction": { input: { sessionId: string; enabled: boolean }; output: AgentRuntimeSettings };
  "sessions.set-model": { input: { sessionId: string; modelId: string }; output: AgentRuntimeSettings };
  "sessions.set-thinking-level": { input: { sessionId: string; level: string }; output: AgentRuntimeSettings };
  "sessions.set-mode": { input: { sessionId: string; modeId: string }; output: AgentRuntimeSettings };
  "interactions.respond": { input: { sessionId: string; interactionId: string; value: string | boolean | null }; output: AcceptedResult };
  "sessions.ui-input": { input: { sessionId: string; widgetKey: string; input: string }; output: AcceptedResult };
  "sessions.editor-text.dismiss": { input: { sessionId: string; requestId: string }; output: AcceptedResult };
}

export type RpcCommand = keyof RpcCommandMap;
export type RpcInput<K extends RpcCommand> = RpcCommandMap[K]["input"];
export type RpcOutput<K extends RpcCommand> = RpcCommandMap[K]["output"];
export type RpcRequest = {
  [K in RpcCommand]: keyof RpcInput<K> extends never
    ? { id: string; type: K; payload?: RpcInput<K> }
    : { id: string; type: K; payload: RpcInput<K> }
}[RpcCommand];
