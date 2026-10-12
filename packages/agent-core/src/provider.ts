import type { AgentCommandInfo, AgentEvent, AgentRuntimeSettings, AgentUsage, BrowserElementReference, InteractionResponse, ProviderImportCandidate, ProviderModelCatalog, ProviderExtensionCatalog, ProviderMcpCatalog, ProviderMcpServer, ProviderPluginCatalog, ProviderPluginInstallResult, ProviderPluginMutationResult, ProviderPluginScope, ProviderPackageInstallResult, SessionId, SessionQueueState, SessionTimelineEntry } from "@vagus/protocol";
import type { MessageAttachment } from "@vagus/protocol";

export type CapabilityStatus = "implemented" | "partial" | "unsupported";

export interface ProviderCapability {
  /** Stable Vagus capability identifier, not a provider-specific command name. */
  id: string;
  status: CapabilityStatus;
  /** Human-readable limitation when status is partial or unsupported. */
  note?: string;
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  version?: string;
  capabilities: ProviderCapability[];
}

export interface StartSessionOptions {
  sessionId?: SessionId;
  workingDirectory: string;
  /** Additional project roots, when the provider supports them. */
  additionalDirectories?: string[];
  /** Opaque Provider-owned handle returned by an earlier session. */
  resumeReference?: SessionStorageReference;
}

/** Provider-owned, JSON-serializable handle for a persisted native session. */
export type SessionStorageReference = Readonly<Record<string, string>>;

export interface ImportedProviderSession {
  candidate: ProviderImportCandidate;
  storageReference: SessionStorageReference;
  timeline: SessionTimelineEntry[];
}

export interface AgentSendResult {
  /** Whether input created a message, entered a queue, or was handled as an operation. */
  disposition: "submitted" | "queued" | "handled";
}

export interface AgentSession {
  readonly id: SessionId;
  /** False once its native process is unavailable; Host must restore a new instance. */
  readonly available?: boolean;
  readonly storageReference?: SessionStorageReference;
  sendText(text: string, attachments?: MessageAttachment[], deliveryMode?: "immediate" | "steer" | "follow-up", clientMessageId?: string, browserElements?: BrowserElementReference[]): Promise<AgentSendResult | void>;
  respond(response: InteractionResponse): Promise<void>;
  /** Sends input to an active Provider-owned custom UI component, when supported. */
  sendUiInput?(widgetKey: string, input: string): Promise<void>;
  cancel(): Promise<void>;
  /** Cancels an announced child session only when its Provider granted that capability. */
  cancelSubagent?(subagentSessionId: string): Promise<void>;
  /** Releases an idle native process while preserving the resumable conversation. */
  suspend?(): Promise<void>;
  dispose(): Promise<void>;
  getRuntimeSettings?(): Promise<AgentRuntimeSettings>;
  /** Reads the Provider's latest persisted transcript after the native session is resumed. */
  readHistory?(knownEntryIds?: readonly string[]): Promise<SessionTimelineEntry[]>;
  setModel?(modelId: string): Promise<AgentRuntimeSettings>;
  setThinkingLevel?(level: string): Promise<AgentRuntimeSettings>;
  setMode?(modeId: string): Promise<AgentRuntimeSettings>;
  getUsage?(): Promise<AgentUsage | null>;
  getCommands?(): Promise<AgentCommandInfo[]>;
  /** Execute a discovered native command using its provider-owned operation. */
  executeCommand?(action: Exclude<NonNullable<AgentCommandInfo["action"]>, "compact">, input: string): Promise<void>;
  clearQueue?(): Promise<SessionQueueState>;
  compact?(instructions?: string): Promise<void>;
  setAutoCompaction?(enabled: boolean): Promise<AgentRuntimeSettings>;
  /** Forks a persisted native conversation after a selected assistant message. */
  forkAfterAssistantMessage?(text: string, occurrence: number, messageId?: string): Promise<SessionStorageReference>;
}

export interface AgentProvider {
  readonly descriptor: ProviderDescriptor;
  /** Discovers models through the Provider's local runtime/configuration. */
  listModels?(): Promise<ProviderModelCatalog>;
  /** Reads installed global extension resources without loading or modifying them. */
  listExtensions?(): Promise<ProviderExtensionCatalog>;
  /** Reads the native plugin and marketplace inventory. */
  listPlugins?(): Promise<ProviderPluginCatalog>;
  installPlugin?(pluginId: string, scope: ProviderPluginScope, acceptCommandSha256?: string): Promise<ProviderPluginInstallResult>;
  managePlugin?(pluginId: string, action: "enable" | "disable" | "uninstall", scope?: ProviderPluginScope): Promise<ProviderPluginMutationResult>;
  managePluginMarketplace?(action: "add" | "update" | "remove", options: { source?: string; name?: string; scope?: ProviderPluginScope }): Promise<ProviderPluginMutationResult>;
  /** Reads the sanitized MCP server inventory reported by the native CLI. */
  listMcpServers?(): Promise<ProviderMcpCatalog>;
  getMcpServer?(serverName: string): Promise<ProviderMcpServer>;
  /** Installs and persists one package in the Provider's global configuration. */
  installPackage?(source: string): Promise<ProviderPackageInstallResult>;
  /** Lists local native sessions without exposing Provider-owned storage paths. */
  listImportableSessions?(): Promise<ProviderImportCandidate[]>;
  /** Compares a scanned opaque source ID with persisted Provider references without exposing those references to the client. */
  isImportSourceImported?(sourceId: string, references: readonly SessionStorageReference[]): boolean;
  /** Converts one native session into Vagus's canonical timeline without mutating the source. */
  importSession?(sourceId: string): Promise<ImportedProviderSession>;
  startSession(
    options: StartSessionOptions,
    emit: (event: AgentEvent) => void,
  ): Promise<AgentSession>;
  /** Permanently removes a native session using its opaque provider reference. */
  deleteSession?(reference: SessionStorageReference): Promise<void>;
}
