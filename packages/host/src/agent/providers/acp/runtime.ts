import { client, CreateElicitationRequest, methods, ndJsonStream, PROTOCOL_VERSION, type CreateElicitationResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk";
import spawn from "cross-spawn";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { providerEnvironment } from "../../provider-environment.js";
import { type AcpAgentProfile } from "./profiles.js";
import { type AcpRuntime } from "./types.js";
import { isRecord, timeout } from "./utils.js";

export function acpEnvironment(profile: AcpAgentProfile): NodeJS.ProcessEnv {
  const environment = providerEnvironment();
  if (profile.id === "zcode") {
    // zcode-acp-server publishes its successful turn summary (for example,
    // "✓ completed · cache …") as an extra ACP assistant message. That is
    // useful in editor clients without a turn-status UI, but appears as a
    // second final answer in Vagus. Keep the bridge's explicit user config
    // authoritative; this environment default only applies when unset there.
    if (!environment.ZCODE_ACP_SHOW_COMPLETION_STATUS) environment.ZCODE_ACP_SHOW_COMPLETION_STATUS = "0";
    // zcode-acp-server resolves its bundled ZCode .cjs through `which node`.
    // That lookup is Unix-specific and fails on Windows, leaving the bridge to
    // spawn the .cjs file directly (which raises spawn EFTYPE). Its resolver
    // supports ZCODE_NODE, so point it at the same Node runtime Vagus uses.
    if (!environment.ZCODE_NODE) environment.ZCODE_NODE = process.execPath;
  }
  if (profile.id === "zcode" && !environment.ZCODE_BIN) {
    const localAppData = environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    const bundledCli = join(localAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs");
    if (process.platform === "win32") {
      const candidates = [bundledCli];
      // ZCode can be installed to a custom directory (for example D:\\IT\\ZCode).
      // Its ACP bridge only knows the default install path, so discover the
      // registered desktop install and pass its bundled CLI explicitly.
      for (const key of [
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      ]) {
        try {
          const registry = execFileSync("reg.exe", ["query", key, "/s"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000, windowsHide: true });
          for (const entry of registry.split(/(?=^HKEY_)/mu)) {
            if (!/^\s*DisplayName\s+REG_SZ\s+ZCode(?:\s|$)/imu.test(entry)) continue;
            const icon = entry.match(/^\s*DisplayIcon\s+REG_SZ\s+(.+?)\s*$/imu)?.[1];
            const iconPath = icon?.replace(/^"([^"]+)".*$/u, "$1").replace(/,\d+$/u, "");
            if (iconPath) candidates.push(join(dirname(iconPath), "resources", "glm", "zcode.cjs"));
          }
        } catch { /* Missing registry hives or keys are expected on some installs. */ }
      }
      const found = candidates.find((candidate) => existsSync(candidate));
      if (found) environment.ZCODE_BIN = found;
    }
  }
  if (profile.id === "opencode") {
    // OpenCode ACP uses a private loopback HTTP service internally. Keep those
    // requests out of the user's upstream proxy or its API calls fail with 502.
    const loopbackHosts = ["localhost", "127.0.0.1", "::1"];
    for (const key of ["NO_PROXY", "no_proxy"]) {
      const hosts = (environment[key] ?? "").split(",").map((host) => host.trim()).filter(Boolean);
      const known = new Set(hosts.map((host) => host.toLowerCase()));
      for (const host of loopbackHosts) if (!known.has(host)) hosts.push(host);
      environment[key] = hosts.join(",");
    }
  }
  return environment;
}

export async function openAcp(profile: AcpAgentProfile, cwd: string, onUpdate?: (params: SessionNotification) => void, onPermission?: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>, onElicitation?: (params: CreateElicitationRequest) => Promise<CreateElicitationResponse>): Promise<AcpRuntime> {
  const child = spawn(profile.command, profile.args, { cwd, env: acpEnvironment(profile), stdio: "pipe", windowsHide: true }) as ChildProcessWithoutNullStreams;
  let stderr = "";
  let spawnError: NodeJS.ErrnoException | undefined;
  const processEnded = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  child.once("error", (error) => { spawnError = error; });
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000); });
  const app = client({ name: "Vagus" });
  if (onUpdate) app.onNotification(methods.client.session.update, ({ params }: { params: SessionNotification }) => onUpdate(params));
  if (onPermission) app.onRequest(methods.client.session.requestPermission, ({ params }: { params: RequestPermissionRequest }) => onPermission(params));
  if (onElicitation) app.onRequest(methods.client.elicitation.create, ({ params }: { params: CreateElicitationRequest }) => onElicitation(params));
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
  // A missing executable or an early exit can break stdin while initialize is
  // still being written. Keep pipe failures inside this connection so one
  // unavailable Agent cannot crash the entire Host with an unhandled EPIPE.
  child.stdin.on("error", (error) => connection.close(error));
  child.stdout.on("error", (error) => connection.close(error));
  child.stderr.on("error", () => undefined);
  child.once("error", (error) => connection.close(error));
  child.once("exit", (code, signal) => connection.close(new Error(`${profile.displayName} ACP 进程已退出 (${signal ?? code ?? "unknown"})`)));
  try {
    const initialized = await timeout(connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "Vagus", version: "0.1.0" },
      // Advertise only client-side ACP features that this adapter actually handles.
      // Do not advertise unstable extensions. Only session connections that
      // register a form handler advertise stable form elicitation support.
      clientCapabilities: onElicitation ? { elicitation: { form: {} } } : {},
    }), `${profile.displayName} ACP 初始化超时`);
    return { child, connection, capabilities: isRecord(initialized) && isRecord(initialized.agentCapabilities) ? initialized.agentCapabilities : {} };
  } catch (error) {
    // Windows command shims can close stdout before cross-spawn reports
    // ENOENT on process exit. Preserve that launch error before cleanup.
    if (!spawnError && connection.signal.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([processEnded, new Promise<void>((resolve) => { timer = setTimeout(resolve, 100); })]);
      if (timer) clearTimeout(timer);
    }
    connection.close(error);
    child.kill();
    if (spawnError?.code === "ENOENT") throw new Error(`找不到本机 ${profile.displayName} 命令“${profile.command}”。请先安装对应 CLI，并确认它在 Vagus 的 PATH 中可用。`);
    const message = error instanceof Error ? error.message : String(error);
    if ((child as any).exitCode === null && stderr.trim()) throw new Error(`${message}：${stderr.trim().split(/\r?\n/u).at(-1)?.slice(0, 500)}`);
    throw error;
  }
}
