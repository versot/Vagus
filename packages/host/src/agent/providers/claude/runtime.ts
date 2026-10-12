import type { AcpSessionNotification } from "@agentclientprotocol/claude-agent-acp/dist/acp-subagents.js";
import { client, CreateElicitationRequest, methods, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type CreateElicitationRequest as CreateElicitationRequestType, type CreateElicitationResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { providerEnvironment } from "../../provider-environment.js";
import { normalizeClaudeSubagentStream } from "./subagents.js";
import { claudeSdkModelDiagnostic, isObject, withTimeout } from "./utils.js";

export const execFileAsync = promisify(execFile);

export function resolveClaudeExecutable(): string {
  const configured = process.env.CLAUDE_CODE_EXECUTABLE || process.env.VAGUS_CLAUDE_CODE_EXECUTABLE;
  if (configured) return configured;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"]) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("找不到本机 Claude Code。请先安装 Claude Code，并确保 claude 命令在 PATH 中，或设置 CLAUDE_CODE_EXECUTABLE。");
}

export function acpEntryPath(): string {
  return fileURLToPath(import.meta.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"));
}

export async function openAcpConnection(
  onPermission: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  onUpdate?: (notification: AcpSessionNotification) => void,
  onElicitation?: (params: CreateElicitationRequestType) => Promise<CreateElicitationResponse>,
  onElicitationComplete?: (elicitationId: string) => void,
  onDiagnostic?: (message: string) => void,
): Promise<{ child: ChildProcessWithoutNullStreams; connection: ClientConnection; steeringSupported: boolean; sessionDeleteSupported: boolean }> {
  const executable = resolveClaudeExecutable();
  const child = spawn(process.execPath, [acpEntryPath()], {
    cwd: process.cwd(),
    env: { ...providerEnvironment(), CLAUDE_CODE_EXECUTABLE: executable, CLAUDE_AGENT_SDK_CLIENT_APP: "Vagus" },
    stdio: "pipe",
    windowsHide: true,
  });
  let stderrPending = "";
  let sdkModelDiagnosticReported = false;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrPending += chunk.toString("utf8");
    const lines = stderrPending.split(/\r?\n/u);
    stderrPending = lines.pop() ?? "";
    if (stderrPending.length > 8192) stderrPending = stderrPending.slice(-8192);
    if (sdkModelDiagnosticReported || !onDiagnostic) return;
    for (const line of lines) {
      const message = claudeSdkModelDiagnostic(line);
      if (!message) continue;
      sdkModelDiagnosticReported = true;
      onDiagnostic(message);
      break;
    }
  });
  const app = client({ name: "Vagus" });
  app.onRequest(methods.client.session.requestPermission, async ({ params }: { params: RequestPermissionRequest }) => onPermission(params));
  if (onElicitation) app.onRequest(methods.client.elicitation.create, async ({ params }: { params: CreateElicitationRequest }) => onElicitation(params));
  if (onElicitationComplete) app.onNotification(methods.client.elicitation.complete, ({ params }: { params: { elicitationId: string } }) => onElicitationComplete(params.elicitationId));
  if (onUpdate) app.onNotification(methods.client.session.update, ({ params }: { params: SessionNotification }) => onUpdate(params as AcpSessionNotification));
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(normalizeClaudeSubagentStream(child.stdout)) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  try {
    const initialized = await withTimeout(connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "Vagus", version: "0.1.0" },
      clientCapabilities: {
        plan: {},
        session: { compaction: {} },
        // The Claude ACP bridge negotiates native child sessions, but currently
        // emits two pre-standardization lifecycle tags. The incoming NDJSON
        // boundary normalizes those to ACP's validated `subagent_update` form.
        subagents: {},
        ...(onElicitation ? { elicitation: { form: {}, url: {} } } : {}),
        // claude-agent-acp uses this ACP v1 extension to report shell output
        // as incremental terminal chunks rather than hiding it in rawOutput.
        _meta: { terminal_output_delta: true },
      },
    }), "Claude ACP 初始化超时");
    const meta = isObject(initialized) && isObject(initialized._meta) ? initialized._meta : null;
    const steeringSupported = Boolean(meta && isObject(meta.steering) && meta.steering.supported === true);
    const agentCapabilities = isObject(initialized) && isObject(initialized.agentCapabilities) ? initialized.agentCapabilities : null;
    const sessionCapabilities = agentCapabilities && isObject(agentCapabilities.sessionCapabilities) ? agentCapabilities.sessionCapabilities : null;
    const sessionDeleteSupported = Boolean(sessionCapabilities && isObject(sessionCapabilities.delete));
    return { child, connection, steeringSupported, sessionDeleteSupported };
  } catch (error) {
    connection.close(error);
    child.kill();
    throw error;
  }
}
