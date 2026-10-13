/** Provider-neutral events and shared wire types for Host and clients. */

export const PROTOCOL_VERSION = 1 as const;
/** Maximum serialized history-page size, excluding RPC framing. A single oversized entry may exceed it. */
export const SESSION_HISTORY_PAGE_BYTE_BUDGET = 1024 * 1024;
/** History pages inline small messages; larger payloads are fetched by entry ID when rendered. */
export const SESSION_HISTORY_ENTRY_INLINE_BUDGET = 64 * 1024;
/** @deprecated Use PROTOCOL_VERSION. Retained for source compatibility with early clients. */
export const PROTOCOL_DRAFT_VERSION = PROTOCOL_VERSION;
export * from "./rpc.js";
export * from "./workspace.js";
export type { GitReviewScope, GitReview, ReviewFile, ReviewPatch, TurnReviewSnapshot } from "./workspace-review.js";

export type SessionId = string;
export type MessageId = string;
export type ToolCallId = string;
export type TurnId = string;

export type SessionUiWidgetContent =
  | { type: "text"; title?: string; lines: string[] }
  | { type: "tui"; title?: string; lines: string[]; interactive?: boolean };

/** Runtime UI state, separate from conversation history. Rebuilt by a live Agent. */
export interface SessionUiState {
  statuses: Array<{ key: string; text: string }>;
  widgets: Array<{ key: string; content: SessionUiWidgetContent; placement: "aboveEditor" | "belowEditor" }>;
  editorText?: { requestId: string; text: string };
}

export type SessionUiEvent =
  | {
      type: "ui.status";
      sessionId: SessionId;
      key: string;
      text: string | null;
      subagentSessionId?: string;
      subagentCancellable?: boolean;
      subagentState?:
        "running" | "idle" | "requires_action" | "unknown" | "completed" | "failed" | "cancelled" | "disconnected";
    }
  | {
      type: "ui.widget";
      sessionId: SessionId;
      key: string;
      content: SessionUiWidgetContent | null;
      placement: "aboveEditor" | "belowEditor";
    }
  | { type: "ui.editorText"; sessionId: SessionId; requestId: string; text: string }
  | { type: "ui.editorText.dismissed"; sessionId: SessionId; requestId: string }
  | { type: "ui.reset"; sessionId: SessionId };

export function applySessionUiEvent(state: SessionUiState | undefined, event: SessionUiEvent): SessionUiState {
  const current = state ?? { statuses: [], widgets: [] };
  if (event.type === "ui.reset") return { statuses: [], widgets: [] };
  if (event.type === "ui.status") {
    // Subagent activity belongs in the conversation timeline, not the
    // extension status rail. Keep legacy Claude keys readable while providers
    // migrate to the shared subagent namespace.
    const isSubagent = event.key.startsWith("subagent:") || event.key.startsWith("claude-subagent:");
    const statuses = current.statuses.filter(
      (item) => item.key !== event.key && !item.key.startsWith("claude-subagent:") && !item.key.startsWith("subagent:"),
    );
    if (event.key === "agent-activity" || isSubagent) return { ...current, statuses };
    if (event.text) {
      const index = current.statuses.findIndex((item) => item.key === event.key);
      statuses.splice(index < 0 ? statuses.length : index, 0, { key: event.key, text: event.text });
    }
    return { ...current, statuses };
  }
  if (event.type === "ui.widget") {
    const widgets = current.widgets.filter((item) => item.key !== event.key);
    if (event.content && event.content.lines.length > 0) {
      const index = current.widgets.findIndex((item) => item.key === event.key);
      widgets.splice(index < 0 ? widgets.length : index, 0, {
        key: event.key,
        content: event.content,
        placement: event.placement,
      });
    }
    return { ...current, widgets };
  }
  if (event.type === "ui.editorText")
    return { ...current, editorText: { requestId: event.requestId, text: event.text } };
  if (current.editorText?.requestId !== event.requestId) return current;
  const { editorText: _draft, ...rest } = current;
  return rest;
}

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Data URL retained in the session snapshot so image messages survive restart. */
  dataUrl: string;
}

/** A browser element explicitly selected by the user for Agent context. */
export interface BrowserElementReference {
  id: string;
  url: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
  note?: string;
}

export interface SessionEventMetadata {
  /** Monotonic sequence within one Vagus session. */
  sequence?: number;
  /** The user turn that caused this event, when it belongs to a turn. */
  turnId?: TurnId;
  occurredAt?: string;
}

export type SessionTimelineEntry =
  | {
      kind: "turnDiff";
      id: string;
      sequence: number;
      turnId: TurnId;
      occurredAt: string;
      diff: string;
      truncated?: boolean;
    }
  | {
      kind: "plan";
      id: string;
      sequence: number;
      turnId?: TurnId;
      occurredAt: string;
      explanation?: string;
      steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>;
    }
  | {
      kind: "message";
      id: MessageId;
      sequence: number;
      turnId?: TurnId;
      occurredAt: string;
      completedAt?: string;
      role: "user" | "assistant";
      text: string;
      complete: boolean;
      /** True only for a bounded history-page preview; fetch the full entry before rendering it. */
      contentDeferred?: true;
      attachments?: MessageAttachment[];
      browserElements?: BrowserElementReference[];
    }
  | {
      kind: "tool";
      id: ToolCallId;
      sequence: number;
      turnId?: TurnId;
      occurredAt: string;
      name: string;
      title?: string;
      toolKind?: string;
      state: "running" | "done" | "error";
      /** Parent Agent/Task tool call when this is work performed by a Claude subagent. */
      parentToolCallId?: ToolCallId;
      input?: unknown;
      content?: unknown;
      locations?: unknown;
      output?: unknown;
      /** Exit status reported by provider-specific terminal integrations. */
      terminalExitCode?: number | null;
      /** True when large tool details were omitted from a bounded history page. */
      contentDeferred?: true;
    }
  | {
      kind: "status";
      id: string;
      sequence: number;
      turnId?: TurnId;
      occurredAt: string;
      key: string;
      text: string;
      subagentSessionId?: string;
      subagentCancellable?: boolean;
      subagentState?:
        "running" | "idle" | "requires_action" | "unknown" | "completed" | "failed" | "cancelled" | "disconnected";
    }
  | {
      kind: "interaction";
      id: string;
      sequence: number;
      turnId?: TurnId;
      occurredAt: string;
      interaction: UserInteraction;
      state: "pending" | "responded" | "cancelled";
      response?: string | boolean | null;
      reason?: "timeout" | "interrupted";
    }
  | {
      kind: "notice";
      id: string;
      sequence: number;
      turnId?: TurnId;
      occurredAt: string;
      level: "info" | "warning" | "error";
      message: string;
    };

export interface SessionQueryMarker {
  id: MessageId;
  sequence: number;
  text: string;
  occurredAt?: string;
}

export interface SessionSearchPage {
  ids: string[];
  nextOffset: number;
  hasMore: boolean;
}

export interface SessionHistoryPage {
  entries: SessionTimelineEntry[];
  /** UTF-8 size of the serialized entries array; bounded by SESSION_HISTORY_PAGE_BYTE_BUDGET. */
  byteLength: number;
  beforeSequence: number | null;
  hasMore: boolean;
  eventSequence: number;
}

/** Provider-neutral projection of a model discovered from a local Agent runtime. */
export interface ProviderModelInfo {
  /** Stable model reference understood by its Provider, e.g. `anthropic/sonnet`. */
  id: string;
  /** User-facing model name supplied by the Provider. */
  name: string;
  /** Upstream model source/provider, such as `anthropic` or `openai`. */
  source: string;
  /** Thinking levels supported by this model when the Provider exposes them. */
  thinkingLevels?: string[];
}

/** A live model catalog returned by a Provider adapter. */
export interface ProviderModelCatalog {
  providerId: string;
  models: ProviderModelInfo[];
  /** Model currently selected by the Provider's own local configuration. */
  currentModelId: string | null;
  /** Current default thinking level in the Provider's local runtime. */
  currentThinkingLevel?: string | null;
  /** Current mode exposed by a temporary/live Provider session, when supported. */
  currentModeId?: string | null;
  /** Modes exposed by the Provider for a new session, when supported. */
  availableModes?: Array<{ id: string; name: string; description?: string }>;
  /** Resolved local CLI path used by this catalog refresh, when available. */
  executablePath?: string;
  /** Discovery source for the resolved CLI path, such as PATH or a system index. */
  executableSource?: string;
  fetchedAt: string;
  status: "loading" | "ready" | "error";
  stale: boolean;
  error?: string;
}

/** Globally installed extension resources grouped by a package or local entrypoint. */
export interface ProviderExtensionInfo {
  id: string;
  name: string;
  source: string;
  sourceType: "npm" | "git" | "local";
  version?: string;
  description?: string;
  paths: string[];
  /** Configuration only; does not imply that any session loaded the extension. */
  configuration: "enabled" | "disabled" | "mixed";
}

/** Read-only, globally installed extension resources, grouped by their package. */
export interface ProviderExtensionCatalog {
  providerId: string;
  extensions: ProviderExtensionInfo[];
  fetchedAt: string;
  warnings: string[];
}

/** Claude Code plugin inventory as reported by its own CLI. Paths remain local metadata. */
export interface ProviderPluginCatalog {
  providerId: string;
  installed: Array<{
    id: string;
    version?: string;
    scope?: string;
    enabled: boolean;
    installPath?: string;
    installedAt?: string;
    lastUpdated?: string;
    projectEnabled?: boolean;
    canToggle?: boolean;
    canUninstall?: boolean;
  }>;
  available: Array<{ id: string; name: string; description?: string; marketplace: string; source?: string }>;
  marketplaces: Array<{
    name: string;
    source?: string;
    path?: string;
    installLocation?: string;
    canManage?: boolean;
    canUpdate?: boolean;
  }>;
  fetchedAt: string;
  warnings?: string[];
}
export type ProviderPluginScope = "user" | "project" | "local";
export interface ProviderPluginInstallResult {
  providerId: string;
  pluginId: string;
  status: "installed" | "confirmation-required";
  /** Codex may report companion apps that still need the user's authorization. */
  appsNeedingAuth?: string[];
  /** Exact marketplace-declared command to show the user before accepting it. */
  command?: string;
  commandSha256?: string;
}
export interface ProviderPluginMutationResult {
  providerId: string;
  target: string;
  action: string;
  completed: true;
}

/** Sanitized MCP inventory reported by the Provider's native CLI. Secrets and raw connection arguments are never returned. */
export interface ProviderMcpCatalog {
  providerId: string;
  servers: ProviderMcpServer[];
  fetchedAt: string;
}
export interface ProviderMcpServer {
  name: string;
  scope: "local" | "project" | "user" | "managed" | "unknown";
  transport: "stdio" | "http" | "sse" | "websocket" | "unknown";
  status:
    | "connected"
    | "disconnected"
    | "pending"
    | "needs-authentication"
    | "disabled"
    | "rejected"
    | "cached"
    | "not-configured"
    | "error"
    | "unknown";
}
/** A completed global package installation; loaded sessions are unchanged. */
export interface ProviderPackageInstallResult {
  providerId: string;
  source: string;
  installedAt: string;
}

/** A discoverable input command, dispatched by the Provider or a canonical session action. */
export interface AgentCommandInfo {
  name: string;
  description?: string;
  /** Provider hint for the free-form text that follows this command. */
  inputHint?: string;
  source: "extension" | "prompt" | "skill" | "builtin" | "other";
  /** Built-in commands with this action use a native session operation instead of a chat prompt. */
  action?: "compact" | "fork" | "goal" | "review" | "mcp-status" | "fast-mode" | "feedback";
}

/** Runtime controls exposed by a live provider session. */
export interface AgentRuntimeSettings {
  providerId: string;
  modelId: string | null;
  thinkingLevel: string | null;
  thinkingLevels: string[];
  /** Optional native service tier, for example Codex fast mode. */
  serviceTier?: string | null;
  /** Current native operating mode, when the provider exposes one. */
  currentModeId?: string | null;
  /** Modes the user can switch to in the current session. */
  availableModes?: Array<{ id: string; name: string; description?: string }>;
  /** Whether the Provider will compact context automatically as it fills. */
  autoCompactionEnabled?: boolean;
  /** Current native Codex goal, when the provider exposes one. */
  goal?: { objective: string; status: "active" | "paused" | "blocked" | "complete" | string } | null;
}

export interface SessionQueueState {
  steering: string[];
  followUp: string[];
}

/** Token and cost values exposed by a provider's live session. */
export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export type SessionState = "starting" | "idle" | "running" | "ended";

export type AgentEvent = (
  | { type: "session.turn.diff.updated"; sessionId: SessionId; turnId: TurnId; diff: string; truncated?: boolean }
  | {
      type: "session.plan.updated";
      sessionId: SessionId;
      planId: string;
      explanation?: string;
      steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>;
    }
  | { type: "workspace.changed" }
  | { type: "session.history.updated"; sessionId: SessionId }
  | { type: "provider.models.updated"; catalog: ProviderModelCatalog }
  | { type: "provider.enabled.updated"; providerId: string; enabled: boolean }
  | { type: "session.commands.updated"; sessionId: SessionId; commands: AgentCommandInfo[] }
  | { type: "session.settings.updated"; sessionId: SessionId; settings: AgentRuntimeSettings }
  | { type: "session.usage.updated"; sessionId: SessionId; usage: AgentUsage }
  | { type: "session.queue.updated"; sessionId: SessionId; queue: SessionQueueState }
  | { type: "session.compaction"; sessionId: SessionId; state: "started" | "completed"; reason?: string }
  | {
      type: "session.state";
      sessionId: SessionId;
      state: SessionState;
    }
  | {
      type: "message.started";
      sessionId: SessionId;
      messageId: MessageId;
      role: "user" | "assistant";
      /** The provider is replaying a persisted native transcript, not starting a new reply. */
      replay?: true;
      /** Correlates a local send preview; never replaces the canonical message ID. */
      clientMessageId?: string;
      attachments?: MessageAttachment[];
      browserElements?: BrowserElementReference[];
    }
  | {
      type: "message.delta";
      sessionId: SessionId;
      messageId: MessageId;
      text: string;
    }
  | {
      type: "message.completed";
      sessionId: SessionId;
      messageId: MessageId;
    }
  | {
      type: "tool.started";
      sessionId: SessionId;
      toolCallId: ToolCallId;
      name: string;
      title?: string;
      /** Parent Agent/Task tool call when this tool belongs to a Claude subagent. */
      parentToolCallId?: ToolCallId;
      toolKind?: string;
      input?: unknown;
      content?: unknown;
      locations?: unknown;
    }
  | {
      type: "tool.updated";
      sessionId: SessionId;
      toolCallId: ToolCallId;
      parentToolCallId?: ToolCallId;
      name?: string;
      title?: string;
      toolKind?: string;
      input?: unknown;
      content?: unknown;
      locations?: unknown;
      output?: unknown;
      /** Append-only live command output when a provider streams terminal chunks. */
      outputDelta?: string;
      /** Exit status reported alongside provider-specific terminal output. */
      terminalExitCode?: number | null;
    }
  | {
      type: "tool.completed";
      sessionId: SessionId;
      toolCallId: ToolCallId;
      isError: boolean;
      output?: unknown;
      /** Exit status reported alongside provider-specific terminal output. */
      terminalExitCode?: number | null;
    }
  | {
      type: "interaction.requested";
      sessionId: SessionId;
      interactionId: string;
      interaction: UserInteraction;
    }
  | {
      type: "interaction.responded";
      sessionId: SessionId;
      interactionId: string;
      value: string | boolean | null;
      reason?: "timeout" | "interrupted";
    }
  | {
      type: "notification";
      sessionId: SessionId;
      level: "info" | "warning" | "error";
      message: string;
    }
  | SessionUiEvent
  | { type: "ui.title"; sessionId: SessionId; title: string }
  | {
      type: "provider.error";
      sessionId?: SessionId;
      code: string;
      message: string;
      recoverable: boolean;
    }
) &
  SessionEventMetadata;

export type UserInteraction = (
  | { kind: "text-input"; title?: string; message?: string; placeholder?: string }
  | {
      kind: "choice";
      title?: string;
      message?: string;
      options: string[];
      /** Optional localized semantic hints aligned with options. */ optionHints?: string[];
    }
  | { kind: "confirm"; title?: string; message: string }
  | { kind: "text-editor"; title?: string; message?: string; initialValue?: string }
  | {
      kind: "form";
      title?: string;
      message?: string;
      fields: Array<{
        id: string;
        label: string;
        description?: string;
        type: "text" | "number" | "boolean" | "choice" | "multi-choice";
        required?: boolean;
        defaultValue?: string | number | boolean | string[];
        options?: Array<{ value: string; label: string; description?: string; preview?: string }>;
        minLength?: number;
        maxLength?: number;
        minimum?: number;
        maximum?: number;
        integer?: boolean;
        pattern?: string;
        minItems?: number;
        maxItems?: number;
        format?: string;
      }>;
    }
  | { kind: "url-consent"; title?: string; message?: string; url: string; host: string }
) & { expiresAt?: string };

export interface InteractionResponse {
  interactionId: string;
  value: string | boolean | null;
}
