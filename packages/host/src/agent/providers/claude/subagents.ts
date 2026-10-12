import { methods, type ClientConnection } from "@agentclientprotocol/sdk";
import { Readable, Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isObject } from "./utils.js";

export function parentToolCallIdFromMeta(meta: unknown): string | undefined {
  if (!isObject(meta) || !isObject(meta.claudeCode)) return undefined;
  return typeof meta.claudeCode.parentToolUseId === "string" ? meta.claudeCode.parentToolUseId : undefined;
}

export function subagentState(value: unknown): "running" | "idle" | "requires_action" | "unknown" | "completed" | "failed" | "cancelled" | "disconnected" {
  return value === "running" || value === "idle" || value === "requires_action" || value === "unknown" || value === "completed" || value === "failed" || value === "cancelled" || value === "disconnected" ? value : "unknown";
}

export async function cancelClaudeSubagent(
  connection: Pick<ClientConnection, "agent"> | null,
  subagents: ReadonlyMap<string, { cancellable: boolean; state: string }>,
  subagentSessionId: string,
  disposed = false,
): Promise<void> {
  const child = subagents.get(subagentSessionId);
  if (!child || child.state !== "running") throw new Error("子代理不存在或当前没有运行");
  if (!child.cancellable) throw new Error("Claude Code 未授权单独取消此子代理");
  if (disposed || !connection) throw new Error("Claude ACP session is unavailable");
  await connection.agent.notify(methods.agent.session.cancel, { sessionId: subagentSessionId });
}

export function normalizeClaudeSubagentNotificationLine(line: string): string {
  if (!line.trim()) return line;
  try {
    const message: unknown = JSON.parse(line);
    if (!isObject(message) || message.method !== methods.client.session.update || !isObject(message.params) || !isObject(message.params.update)) return line;
    const update = message.params.update;
    if (update.sessionUpdate === "subagent_spawned" && typeof update.subagentSessionId === "string") {
      const capabilities = isObject(update.capabilities) && (update.capabilities.cancel === true || isObject(update.capabilities.cancel)) ? { cancel: {} } : undefined;
      message.params.update = {
        sessionUpdate: "subagent_update",
        sessionId: update.subagentSessionId,
        ...(typeof update.name === "string" ? { title: update.name } : {}),
        ...(typeof update.task === "string" ? { description: update.task } : {}),
        ...(capabilities ? { capabilities } : {}),
        state: { state: "running" },
        ...(isObject(update._meta) ? { _meta: update._meta } : {}),
      };
      return JSON.stringify(message);
    }
    if (update.sessionUpdate === "subagent_state_update" && typeof update.subagentSessionId === "string" && typeof update.state === "string") {
      message.params.update = {
        sessionUpdate: "subagent_update",
        sessionId: update.subagentSessionId,
        state: { state: update.state },
        ...(isObject(update._meta) ? { _meta: update._meta } : {}),
      };
      return JSON.stringify(message);
    }
  } catch {
    // Preserve malformed or non-JSON lines; the ACP decoder remains the source
    // of protocol errors and diagnostics.
  }
  return line;
}

export function readClaudeTerminalOutput(update: Record<string, unknown>): {
  terminalId: string;
  data: string;
  delta: boolean;
  exitCode?: number | null;
} | undefined {
  if (!isObject(update._meta)) return undefined;
  const meta = update._meta;
  const delta = isObject(meta.terminal_output_delta) ? meta.terminal_output_delta : undefined;
  const snapshot = isObject(meta.terminal_output) ? meta.terminal_output : undefined;
  const output = delta ?? snapshot;
  if (!output || typeof output.terminal_id !== "string" || typeof output.data !== "string") return undefined;
  const exit = isObject(meta.terminal_exit) && meta.terminal_exit.terminal_id === output.terminal_id ? meta.terminal_exit : undefined;
  return { terminalId: output.terminal_id, data: output.data, delta: Boolean(delta), ...(exit && (typeof exit.exit_code === "number" || exit.exit_code === null) ? { exitCode: exit.exit_code } : {}) };
}

export function readClaudeTerminalExit(update: Record<string, unknown>): { terminalId: string; exitCode: number | null } | undefined {
  if (!isObject(update._meta) || !isObject(update._meta.terminal_exit)) return undefined;
  const exit = update._meta.terminal_exit;
  if (typeof exit.terminal_id !== "string" || (typeof exit.exit_code !== "number" && exit.exit_code !== null)) return undefined;
  return { terminalId: exit.terminal_id, exitCode: exit.exit_code };
}

export function normalizeClaudeSubagentStream(source: Readable): Readable {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += decoder.write(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) this.push(`${normalizeClaudeSubagentNotificationLine(line.replace(/\r$/u, ""))}\n`);
      callback();
    },
    flush(callback) {
      pending += decoder.end();
      if (pending) this.push(normalizeClaudeSubagentNotificationLine(pending));
      callback();
    },
  });
  source.pipe(transform);
  return transform;
}
