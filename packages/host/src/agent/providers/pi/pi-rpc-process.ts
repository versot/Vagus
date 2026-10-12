import spawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { providerEnvironment } from "../../provider-environment.js";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

type RpcRecord = Record<string, unknown>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is RpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Owns one Pi RPC child process and its LF-framed JSONL connection. */
export class PiRpcProcess {
  private readonly child: ChildProcess;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<(record: RpcRecord) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private frameBuffer = "";
  private nextRequestId = 0;
  private exitError: Error | null = null;
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;
  get available() { return this.exitError === null; }

  constructor(options: { command: string; cwd: string; args?: string[] }) {
    this.exited = new Promise<void>((resolve) => {
      this.resolveExited = resolve;
    });
    this.child = spawn(options.command, ["--mode", "rpc", ...(options.args ?? [])], {
      cwd: options.cwd,
      env: providerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.readChunk(chunk));
    this.child.stdout?.on("end", () => {
      this.frameBuffer += this.decoder.end();
    });
    // Pi writes diagnostics to stderr. Never interpret them as protocol records.
    this.child.stderr?.resume();
    this.child.stdin?.on("error", (error: Error) => this.fail(error));
    this.child.stdout?.on("error", (error: Error) => this.fail(error));
    this.child.stderr?.on("error", (error: Error) => this.fail(error));
    this.child.once("error", (error: Error) => this.fail(error));
    this.child.once("exit", (code, signal) => {
      this.fail(new Error(`Pi RPC exited (code ${code ?? "none"}, signal ${signal ?? "none"})`));
    });
  }

  onEvent(listener: (record: RpcRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    if (this.exitError) listener(this.exitError);
    return () => this.exitListeners.delete(listener);
  }

  async request(type: string, fields: RpcRecord = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.exitError) throw this.exitError;
    const id = `vagus-${++this.nextRequestId}`;
    const response = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Pi RPC command timed out: ${type}`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
    });
    try {
      await this.send({ ...fields, id, type });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return response;
  }

  async send(record: RpcRecord): Promise<void> {
    if (this.exitError) throw this.exitError;
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw new Error("Pi RPC stdin is unavailable");
    const frame = `${JSON.stringify(record)}\n`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(frame, (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.exitError) return;
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill(), 2_000);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private readChunk(chunk: Buffer): void {
    if (this.exitError) return;
    this.frameBuffer += this.decoder.write(chunk);
    while (true) {
      const newline = this.frameBuffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.frameBuffer.slice(0, newline);
      this.frameBuffer = this.frameBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        this.fail(new Error("Pi RPC frame exceeded the size limit"));
        this.child.kill();
        return;
      }
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.fail(new Error("Pi RPC emitted malformed JSON"));
        this.child.kill();
        return;
      }
      if (!isRecord(parsed) || typeof parsed.type !== "string") {
        this.fail(new Error("Pi RPC emitted an invalid record"));
        this.child.kill();
        return;
      }
      this.handleRecord(parsed);
    }
    if (Buffer.byteLength(this.frameBuffer, "utf8") > MAX_FRAME_BYTES) {
      this.fail(new Error("Pi RPC frame exceeded the size limit"));
      this.child.kill();
    }
  }

  private handleRecord(record: RpcRecord): void {
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(record.id);
      if (record.success === true) pending.resolve(record.data);
      else pending.reject(new Error(typeof record.error === "string" ? record.error : "Pi RPC command failed"));
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // One consumer must not stop the RPC stream or other consumers.
      }
    }
  }

  private fail(error: Error): void {
    if (this.exitError) return;
    this.exitError = error;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.exitListeners) { try { listener(error); } catch { /* Preserve pending-request and shutdown cleanup. */ } }
    this.resolveExited();
  }
}
