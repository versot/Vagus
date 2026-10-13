import type { AcpSessionNotification } from "@agentclientprotocol/claude-agent-acp/dist/acp-subagents.js";
import { client, CreateElicitationRequest, methods, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type CreateElicitationRequest as CreateElicitationRequestType, type CreateElicitationResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { providerEnvironmentWithSearchPath, providerSearchPath } from "../../provider-environment.js";
import { normalizeClaudeSubagentStream } from "./subagents.js";
import { claudeSdkModelDiagnostic, isObject, withTimeout } from "./utils.js";

export const execFileAsync = promisify(execFile);

type ClaudeExtensionMetadata = { name?: unknown; publisher?: unknown; version?: unknown };

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findClaudeExtensionExecutable(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const home = environment.USERPROFILE || environment.HOME || homedir();
  const editorExtensionRoots = [
    join(home, ".vscode", "extensions"),
    join(home, ".vscode-insiders", "extensions"),
    join(home, ".cursor", "extensions"),
  ];
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates: Array<{ path: string; version: string; rootOrder: number }> = [];

  for (const [rootOrder, extensionsRoot] of editorExtensionRoots.entries()) {
    let extensionDirectories: string[];
    try {
      extensionDirectories = (await readdir(extensionsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith("anthropic.claude-code-"))
        .map((entry) => join(extensionsRoot, entry.name));
    } catch {
      continue;
    }

    for (const extensionDirectory of extensionDirectories) {
      try {
        const metadata = JSON.parse(await readFile(join(extensionDirectory, "package.json"), "utf8")) as ClaudeExtensionMetadata;
        if (metadata.name !== "claude-code" || typeof metadata.publisher !== "string" || metadata.publisher.toLowerCase() !== "anthropic") continue;
        if (typeof metadata.version !== "string") continue;
        const executable = join(extensionDirectory, "resources", "native-binary", binaryName);
        if (await isExecutableFile(executable)) candidates.push({ path: executable, version: metadata.version, rootOrder });
      } catch {
        // Ignore incomplete extension installs and continue with other editor versions.
      }
    }
  }

  candidates.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true, sensitivity: "base" }) || left.rootOrder - right.rootOrder);
  return candidates[0]?.path;
}

export async function resolveClaudeExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = environment.CLAUDE_CODE_EXECUTABLE || environment.VAGUS_CLAUDE_CODE_EXECUTABLE;
  if (configured) return configured;
  for (const directory of (await providerSearchPath(environment)).split(delimiter)) {
    for (const name of process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"]) {
      const candidate = join(directory, name);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  const extensionExecutable = await findClaudeExtensionExecutable(environment);
  if (extensionExecutable) return extensionExecutable;
  throw new Error("找不到本机 Claude Code。请安装 Claude Code CLI，或通过 PATH、VS Code / Insiders / Cursor 扩展，或 CLAUDE_CODE_EXECUTABLE 指定其可执行文件。");
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
  const executable = await resolveClaudeExecutable();
  const child = spawn(process.execPath, [acpEntryPath()], {
    cwd: process.cwd(),
    env: { ...await providerEnvironmentWithSearchPath(), CLAUDE_CODE_EXECUTABLE: executable, CLAUDE_AGENT_SDK_CLIENT_APP: "Vagus" },
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
