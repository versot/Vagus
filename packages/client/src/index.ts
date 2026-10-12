import type { AgentEvent, RpcCommand, RpcErrorCode, RpcInput, RpcOutput, AgentRuntimeSettings, AgentUsage, ProviderModelCatalog, ProviderExtensionCatalog, ProviderMcpCatalog, ProviderMcpServer, ProviderPluginCatalog, ProviderPluginInstallResult, ProviderPluginMutationResult, ProviderPluginScope, ProviderPackageInstallResult } from "@vagus/protocol";
import { isRecord, PROTOCOL_VERSION } from "@vagus/protocol";
export type { Project, Message, ProviderImportCandidate, WorkspaceSession, ProviderInfo, WorkspaceSnapshot, ScheduledTask, ScheduledTaskFrequency } from "@vagus/protocol";
export type { AgentRuntimeSettings, AgentUsage, ProviderModelCatalog, ProviderExtensionCatalog, ProviderMcpCatalog, ProviderMcpServer, ProviderPluginCatalog, ProviderPluginInstallResult, ProviderPluginMutationResult, ProviderPluginScope, ProviderPackageInstallResult };
export interface HostConnection { url: string; token: string }
export interface HostClientOptions { token?: string; getConnection?(): Promise<HostConnection>; autoReconnect?: boolean; retryDelays?: readonly number[] }
export interface RpcRequestOptions { timeoutMs?: number; signal?: AbortSignal }
type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
};

export class HostRpcError extends Error {
  constructor(message: string, readonly code?: RpcErrorCode) { super(message); this.name = "HostRpcError"; }
}

export class HostClient {
  private socket: WebSocket | null = null;
  private authenticated = false;
  private wanted = false;
  private generation = 0;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private retry = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private connectionListeners = new Set<(connected: boolean) => void>();

  constructor(private readonly url = "ws://127.0.0.1:4317/rpc", private readonly options: HostClientOptions = {}) {}

  connect(): Promise<void> {
    this.wanted = true;
    if (this.authenticated) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const generation = this.generation;
    const connecting = this.open(generation).finally(() => { if (this.connecting === connecting) this.connecting = null; });
    this.connecting = connecting;
    return connecting;
  }

  /** Force a fresh credential lookup and socket after the managed Host restarts. */
  reconnect(): Promise<void> {
    if (!this.wanted) return Promise.resolve();
    this.generation++;
    this.connecting = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.retry = 0;
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.rejectPending();
    this.notify(false);
    socket?.close();
    return this.connect();
  }

  private async open(generation: number): Promise<void> {
    let connection: HostConnection;
    try {
      connection = this.options.getConnection ? await this.options.getConnection() : { url: this.url, token: this.options.token ?? "" };
      if (!connection.token) throw new Error("Host authentication credential is required");
    } catch (error) { if (generation === this.generation) this.scheduleReconnect(); throw error; }
    if (!this.wanted || generation !== this.generation) throw new Error("Host connection cancelled");
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(connection.url);
      this.socket = socket;
      const authId = crypto.randomUUID();
      let settled = false, fatal = false;
      const current = () => this.wanted && this.generation === generation && this.socket === socket;
      const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { fail(new Error("连接 Vagus Host 超时")); socket.close(); }, 8_000);
      socket.addEventListener("open", () => {
        if (!current()) { socket.close(); return; }
        socket.send(JSON.stringify({ id: authId, type: "host.authenticate", payload: { token: connection.token, version: PROTOCOL_VERSION } }));
      }, { once: true });
      socket.addEventListener("error", () => {
        fail(new Error("无法连接本机 Host"));
      }, { once: true });
      socket.addEventListener("close", () => {
        fail(new Error("Host 连接已断开"));
        if (!current()) return;
        this.socket = null;
        this.authenticated = false;
        this.notify(false);
        this.rejectPending();
        if (!fatal) this.scheduleReconnect();
      });
      socket.addEventListener("message", (message) => {
        if (!current()) return;
        let response: unknown;
        try { response = JSON.parse(String(message.data)); } catch { return; }
        if (!isRecord(response)) return;
        if (!settled && response.id === authId) {
          if (response.ok !== true || !isRecord(response.data) || response.data.authenticated !== true || response.data.version !== PROTOCOL_VERSION) {
            // Desktop credentials can rotate between bootstrap and authentication.
            // Fetch them again within the same bounded reconnect budget.
            fatal = !this.options.getConnection || response.code === "INCOMPATIBLE_PROTOCOL";
            fail(new Error(typeof response.error === "string" ? response.error : "Host authentication failed")); socket.close(); return;
          }
          settled = true; clearTimeout(timer); this.authenticated = true; this.retry = 0;
          this.notify(true); resolve(); return;
        }
        if (!this.authenticated) return;
        if (response.type === "event" && isRecord(response.event) && typeof response.event.type === "string") {
          for (const listener of this.listeners) { try { listener(response.event as unknown as AgentEvent); } catch { /* Isolate consumer failures. */ } }
          return;
        }
        if (typeof response.id === "string") {
          const item = this.pending.get(response.id);
          if (!item) return;
          this.clearPending(response.id, item);
          if (response.ok) item.resolve(response.data);
          else item.reject(new HostRpcError(typeof response.error === "string" ? response.error : "Host 请求失败", isRpcErrorCode(response.code) ? response.code : undefined));
        }
      });
    });
  }

  private notify(connected: boolean) { for (const listener of this.connectionListeners) { try { listener(connected); } catch { /* Other windows/listeners must still be notified. */ } } }
  private rejectPending() {
    for (const [id, item] of this.pending) { this.clearPending(id, item); item.reject(new Error("Host 连接已断开，操作结果未确认；请检查状态后重试")); }
    this.pending.clear();
  }
  private clearPending(id: string, item: PendingRequest) {
    if (item.timer) clearTimeout(item.timer);
    if (item.signal && item.abortListener) item.signal.removeEventListener("abort", item.abortListener);
    this.pending.delete(id);
  }
  private scheduleReconnect() {
    const delays = this.options.retryDelays ?? [250, 500, 1000, 2000, 4000, 8000, 8000, 8000];
    if (!this.wanted || !this.options.autoReconnect || this.reconnectTimer) return;
    // Keep retrying at the capped delay. A desktop lifecycle notification can
    // be missed while a webview is loading; a finite retry budget would then
    // leave the app disconnected until another explicit reconnect event.
    const delay = delays[Math.min(this.retry, Math.max(0, delays.length - 1))] ?? 8000;
    this.retry = Math.min(this.retry + 1, Math.max(0, delays.length - 1));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; if (this.wanted) void this.connect().catch(() => {}); }, delay);
  }

  onEvent(listener: (event: AgentEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    // Consumers may subscribe after the socket has already authenticated
    // (for example after a React/Vite remount). Report the current state as
    // well as future transitions so their local state cannot remain stale.
    listener(this.authenticated && this.socket?.readyState === WebSocket.OPEN);
    return () => this.connectionListeners.delete(listener);
  }

  request<K extends RpcCommand>(
    type: K,
    ...args: keyof RpcInput<K> extends never
      ? [payload?: RpcInput<K>, timeoutOrOptions?: number | RpcRequestOptions]
      : [payload: RpcInput<K>, timeoutOrOptions?: number | RpcRequestOptions]
  ): Promise<RpcOutput<K>> {
    const [payload, timeoutOrOptions = 30_000] = args;
    const timeoutMs = typeof timeoutOrOptions === "number" ? timeoutOrOptions : timeoutOrOptions.timeoutMs ?? 30_000;
    const signal = typeof timeoutOrOptions === "number" ? undefined : timeoutOrOptions.signal;
    const socket = this.socket;
    if (!this.authenticated || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Vagus Host 尚未连接"));
    if (signal?.aborted) return Promise.reject(new Error("Host 请求已取消，操作未发送"));
    const id = crypto.randomUUID();
    return new Promise<RpcOutput<K>>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (data) => resolve(data as RpcOutput<K>),
        reject,
      };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => { this.clearPending(id, pending); reject(new Error("Host 请求超时，操作结果未确认；请检查状态后重试")); }, timeoutMs);
      }
      if (signal) {
        pending.signal = signal;
        pending.abortListener = () => { this.clearPending(id, pending); reject(new Error("Host 请求已取消，操作结果未确认；请检查状态后重试")); };
        signal.addEventListener("abort", pending.abortListener, { once: true });
        if (signal.aborted) { pending.abortListener(); return; }
      }
      this.pending.set(id, pending);
      const message = { id, type, ...(payload ? { payload } : {}) };
      try { socket.send(JSON.stringify(message)); }
      catch (error) { this.clearPending(id, pending); reject(error); }
    });
  }

  close(): void {
    this.wanted = false; this.generation++; this.connecting = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined; this.retry = 0;
    const socket = this.socket; this.socket = null; this.authenticated = false;
    this.rejectPending(); this.notify(false); socket?.close();
  }
}

function isRpcErrorCode(value: unknown): value is RpcErrorCode {
  return value === "INVALID_REQUEST" || value === "UNKNOWN_COMMAND" || value === "UNAUTHORIZED" || value === "INCOMPATIBLE_PROTOCOL" || value === "OVERLOADED" || value === "INTERNAL_ERROR";
}
