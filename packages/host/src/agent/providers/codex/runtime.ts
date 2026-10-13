import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { providerEnvironmentWithSearchPath } from "../../provider-environment.js";
import { resolveProviderExecutable } from "../../provider-executable.js";
import { type PendingRpc, type RpcId } from "./types.js";
import { isRecord, safeError } from "./utils.js";

export async function resolveCodexExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return (await resolveCodexExecutableDetails(environment)).path;
}

export async function resolveCodexExecutableDetails(environment: NodeJS.ProcessEnv = process.env) {
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

  constructor(
    private readonly executable: string,
    private readonly cwd: string,
    readonly executableSource = "configured executable",
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
    this.child = spawn(this.executable, codexAppServerArgs(), {
      cwd: this.cwd,
      env: await providerEnvironmentWithSearchPath(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", () => {
      /* CLI diagnostics may contain local paths or sensitive configuration. */
    });
    this.child.stdin.on("error", (error) => this.fail(safeError(error)));
    this.child.stdout.on("error", (error) => this.fail(safeError(error)));
    this.child.stderr.on("error", (error) => this.fail(safeError(error)));
    this.child.once("error", (error) => this.fail(safeError(error)));
    this.child.once("exit", (code, signal) =>
      this.fail(new Error(`Codex app-server 已退出（${signal ?? code ?? "unknown"}）`)),
    );
    await this.request("initialize", {
      clientInfo: { name: "vagus", title: "Vagus", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized", {});
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (!this.child || this.closed) return Promise.reject(new Error("Codex app-server is unavailable"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
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

  async close(): Promise<void> {
    if (this.closed) return;
    const child = this.child;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server 已关闭"));
      this.pending.delete(id);
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
    this.child = null;
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
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child = null;
    this.onExit(error);
  }
}
