import spawn from "cross-spawn";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { providerEnvironmentWithSearchPath } from "../../provider-environment.js";
import { resolveProviderExecutable, type ResolvedProviderExecutable } from "../../provider-executable.js";
import {
  CodexStartupError,
  codexConfigurationHint,
  codexStartupHint,
  nativeArm64CodexBinaries,
  probeCodexVersion,
  terminateCodexProcess,
} from "./executable.js";
import { type PendingRpc, type RpcId } from "./types.js";
import { isRecord, safeError } from "./utils.js";

export interface CodexStartupOptions {
  automaticDiscovery?: boolean;
  environment?: NodeJS.ProcessEnv;
  versionTimeoutMs?: number;
  startupTimeoutMs?: number;
  discoveryTimeoutMs?: number;
}

export async function resolveCodexExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return (await resolveCodexExecutableDetails(environment)).path;
}

export async function resolveCodexExecutableDetails(
  environment: NodeJS.ProcessEnv = process.env,
  validate?: (candidate: ResolvedProviderExecutable) => Promise<ResolvedProviderExecutable | undefined>,
) {
  const candidatePaths: string[] = [];
  if (process.platform === "win32" && environment.LOCALAPPDATA) {
    const installRoot = join(environment.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    const { readdir } = await import("node:fs/promises");
    try {
      for (const version of (await readdir(installRoot)).sort().reverse())
        candidatePaths.push(join(installRoot, version, "codex.exe"));
    } catch {
      /* optional versioned desktop install */
    }
  }
  return resolveProviderExecutable({
    displayName: "Codex CLI",
    commandNames: process.platform === "win32" ? ["codex.exe", "codex"] : ["codex"],
    environmentVariables: ["VAGUS_CODEX_EXECUTABLE"],
    candidatePaths,
    environment,
    strictConfigured: true,
    validate: async (resolved) => {
      const native = await nativeArm64CodexBinaries(resolved.path, environment);
      const candidates = [
        ...native.map((path) => ({ path, source: `${resolved.source}; native ARM64 Codex package` })),
        resolved,
      ];
      if (!validate) return candidates[0];
      for (const candidate of candidates) {
        const accepted = await validate(candidate);
        if (accepted) return accepted;
      }
      return undefined;
    },
  });
}

export function codexAppServerArgs(platform = process.platform): string[] {
  // MXC is Codex's recommended Windows sandbox and does not rely on the
  // elevated legacy setup helper. That helper can fail when a configured MCP
  // runtime is already open (Windows sharing violation while refreshing ACLs).
  return [...(platform === "win32" ? ["-c", "windows.sandbox=mxc"] : []), "app-server", "--listen", "stdio://"];
}

export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder = new StringDecoder("utf8");
  private buffered = "";
  private nextId = 1;
  private pending = new Map<RpcId, PendingRpc>();
  private onNotification: (method: string, params: unknown) => void = () => {};
  private onServerRequest: (id: RpcId, method: string, params: unknown) => void = () => {};
  private onExit: (error: Error) => void = () => {};
  private closed = false;
  private ready = false;
  private closing: Promise<void> | undefined;
  private stderr = "";
  private stopped = false;
  private readonly startupAbort = new AbortController();

  constructor(
    private executable: string,
    private readonly cwd: string,
    public executableSource = "configured executable",
    private readonly startupOptions: CodexStartupOptions = {},
  ) {}

  get executablePath(): string {
    return this.executable;
  }

  setHandlers(handlers: {
    notification: (method: string, params: unknown) => void;
    serverRequest: (id: RpcId, method: string, params: unknown) => void;
    exit: (error: Error) => void;
  }): void {
    this.onNotification = handlers.notification;
    this.onServerRequest = handlers.serverRequest;
    this.onExit = handlers.exit;
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.stopped) throw new Error("Codex app-server startup was cancelled.");
    const deadline = Date.now() + (this.startupOptions.discoveryTimeoutMs ?? 30_000);
    const environment = await providerEnvironmentWithSearchPath(this.startupOptions.environment);
    const tried = new Set<string>();
    const failures: Error[] = [];
    let configurationError: CodexStartupError | undefined;
    const validate = async (candidate: ResolvedProviderExecutable) => {
      const path = await realpath(candidate.path).catch(() => candidate.path);
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      if (this.stopped || configurationError || tried.has(key) || tried.size >= 8 || Date.now() >= deadline)
        return undefined;
      tried.add(key);
      try {
        await probeCodexVersion(
          candidate.path,
          environment,
          Math.min(this.startupOptions.versionTimeoutMs ?? 3_000, Math.max(1, deadline - Date.now())),
          this.startupAbort.signal,
        );
        if (this.stopped) throw new Error("Codex app-server startup was cancelled.");
        this.executable = candidate.path;
        this.executableSource = candidate.source;
        await this.startCandidate(
          environment,
          Math.min(this.startupOptions.startupTimeoutMs ?? 10_000, Math.max(1, deadline - Date.now())),
        );
        return candidate;
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
        if (error instanceof CodexStartupError && error.kind === "configuration") configurationError = error;
        return undefined;
      }
    };
    // All consumers, including model refresh and session startup, validate the
    // initially resolved executable and use this same fallback search.
    if (await validate({ path: this.executable, source: this.executableSource })) return;
    if (this.stopped) throw new Error("Codex app-server startup was cancelled.");
    if (configurationError) throw configurationError;
    if (this.startupOptions.automaticDiscovery && !environment.VAGUS_CODEX_EXECUTABLE?.trim()) {
      try {
        if (await resolveCodexExecutableDetails(environment, validate)) return;
      } catch (error) {
        if (!failures.length) throw error;
      }
    }
    if (this.stopped) throw new Error("Codex app-server startup was cancelled.");
    if (configurationError) throw configurationError;
    const details = failures
      .map((error) => error.message)
      .join("; ")
      .slice(0, 1_200);
    throw new Error(
      `No usable Codex CLI was found. ${details || "Executable discovery timed out."} Install or update Codex CLI, or set VAGUS_CODEX_EXECUTABLE to a working CLI.`,
    );
  }

  private async startCandidate(environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
    this.closed = false;
    this.ready = false;
    this.closing = undefined;
    this.decoder = new StringDecoder("utf8");
    this.buffered = "";
    this.stderr = "";
    const child = spawn(this.executable, codexAppServerArgs(), {
      cwd: this.cwd,
      env: environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    const fail = (error: Error) => {
      if (this.child === child) this.fail(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child === child) this.consume(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Keep a bounded buffer for known startup error classification. Raw CLI
      // output may contain credentials, so it is never exposed to the UI.
      if (this.child === child && !this.ready) this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4_096);
    });
    child.stdin.on("error", (error) => fail(safeError(error)));
    child.stdout.on("error", (error) => fail(safeError(error)));
    child.stderr.on("error", (error) => fail(safeError(error)));
    child.once("error", (error: NodeJS.ErrnoException) =>
      fail(new CodexStartupError("launch", this.executable, error.code ?? "Process could not be launched.")),
    );
    child.once("exit", (code, signal) =>
      fail(
        new CodexStartupError(
          "exit",
          this.executable,
          codexStartupHint(this.stderr) || `app-server exited (${signal ?? code ?? "unknown"}).`,
        ),
      ),
    );
    try {
      const initialized = await this.request<unknown>(
        "initialize",
        {
          clientInfo: { name: "vagus", title: "Vagus", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
        timeoutMs,
      );
      if (!isRecord(initialized) || typeof initialized.userAgent !== "string")
        throw new CodexStartupError(
          "protocol",
          this.executable,
          "app-server returned an invalid initialization response. Update Codex CLI.",
        );
      this.notify("initialized", {});
      if (this.closed) throw new CodexStartupError("exit", this.executable, "app-server closed during initialization.");
      this.ready = true;
      this.stderr = "";
    } catch (error) {
      const configuration =
        codexConfigurationHint(this.stderr) ||
        codexConfigurationHint(error instanceof Error ? error.message : String(error));
      const failure = configuration
        ? new CodexStartupError("configuration", this.executable, configuration)
        : error instanceof CodexStartupError
          ? error
          : new CodexStartupError(
              "protocol",
              this.executable,
              codexStartupHint(this.stderr) ||
                "app-server initialization failed. Update Codex CLI and check its configuration.",
            );
      await this.closeCandidate();
      throw failure;
    }
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (!this.child || this.closed) return Promise.reject(new Error("Codex app-server is unavailable"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          method === "initialize"
            ? new CodexStartupError(
                "timeout",
                this.executable,
                `app-server initialization timed out after ${timeoutMs} ms.`,
              )
            : new Error(`Codex 请求超时：${method}`),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  reply(id: RpcId, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  reject(id: RpcId, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  close(): Promise<void> {
    this.stopped = true;
    this.startupAbort.abort();
    return this.closeCandidate();
  }

  private closeCandidate(): Promise<void> {
    if (this.closing) return this.closing;
    const child = this.child;
    this.closed = true;
    this.ready = false;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server 已关闭"));
      this.pending.delete(id);
    }
    this.child = null;
    this.closing = child ? terminateCodexProcess(child) : Promise.resolve();
    return this.closing;
  }

  private write(value: unknown): void {
    if (!this.child || this.closed || this.child.stdin.destroyed) throw new Error("Codex app-server is unavailable");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private consume(chunk: Buffer): void {
    this.buffered += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffered.indexOf("\n")) >= 0) {
      const line = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(message)) continue;
      if ((typeof message.id === "string" || typeof message.id === "number") && typeof message.method === "string") {
        this.onServerRequest(message.id, message.method, message.params);
      } else if (typeof message.method === "string") {
        this.onNotification(message.method, message.params);
      } else if (
        (typeof message.id === "string" || typeof message.id === "number") &&
        ("result" in message || "error" in message)
      ) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (isRecord(message.error))
          pending.reject(
            new Error(typeof message.error.message === "string" ? message.error.message : "Codex RPC failed"),
          );
        else pending.resolve(message.result);
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    const wasReady = this.ready;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (wasReady) {
      void this.close().catch(() => undefined);
      this.onExit(error);
    }
  }
}
