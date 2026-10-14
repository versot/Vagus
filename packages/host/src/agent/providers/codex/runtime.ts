import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { providerEnvironmentWithSearchPath } from "../../provider-environment.js";
import { resolveProviderExecutable } from "../../provider-executable.js";
import { type PendingRpc, type RpcId } from "./types.js";
import { isRecord, safeError } from "./utils.js";

const execFileAsync = promisify(execFile);

async function arm64CodexBinary(executable: string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (process.platform !== "darwin" || process.arch !== "x64" || environment.VAGUS_CODEX_EXECUTABLE?.trim())
    return undefined;

  try {
    const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], {
      timeout: 1_000,
      maxBuffer: 4_096,
    });
    if (stdout.trim() !== "1") return undefined;

    const entry = await realpath(executable);
    if (!(await readFile(entry, "utf8")).startsWith("#!/usr/bin/env node")) return undefined;
    const packageRoot = dirname(dirname(entry));
    const rootPackage = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (rootPackage.name !== "@openai/codex" || typeof rootPackage.version !== "string") return undefined;

    const require = createRequire(entry);
    const arm64PackagePath = require.resolve("@openai/codex-darwin-arm64/package.json");
    const arm64Package = JSON.parse(await readFile(arm64PackagePath, "utf8")) as { version?: unknown };
    if (arm64Package.version !== `${rootPackage.version}-darwin-arm64`) return undefined;

    const binary = join(dirname(arm64PackagePath), "vendor", "aarch64-apple-darwin", "bin", "codex");
    await access(binary, constants.X_OK);
    return binary;
  } catch {
    // Keep the configured CLI path when native ARM64 Codex is not installed.
    return undefined;
  }
}

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
  const resolved = await resolveProviderExecutable({
    displayName: "Codex CLI",
    commandNames: process.platform === "win32" ? ["codex.exe", "codex"] : ["codex"],
    environmentVariables: ["VAGUS_CODEX_EXECUTABLE"],
    candidatePaths,
    environment,
  });
  const nativeArm64 = await arm64CodexBinary(resolved.path, environment);
  return nativeArm64 ? { path: nativeArm64, source: `${resolved.source}; native ARM64 Codex package` } : resolved;
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
