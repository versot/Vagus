import type { ProviderPackageInstallResult } from "@vagus/protocol";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { providerEnvironment } from "../../provider-environment.js";
import { findPiRoot } from "./pi-extension-catalog.js";

function normalizeSource(input: string): string {
  let source = input.trim().replace(/^pi\s+install\s+/, "").trim();
  if (!source || source.length > 2048 || /[\x00-\x1f\x7f]/.test(source) || source.startsWith("-")) {
    throw new Error("请输入有效的 Pi 包来源。");
  }
  const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._~^*+-]+)?$/;
  if (npmName.test(source)) source = `npm:${source}`;
  if (source.startsWith("npm:")) {
    if (!npmName.test(source.slice(4))) throw new Error("npm 包来源格式无效。");
  } else if (source.startsWith("~/") || source.startsWith("~\\")) {
    source = resolve(homedir(), source.slice(2));
  } else if (!isAbsolute(source) && !/^(git:|https?:\/\/|ssh:\/\/|git@)\S+$/.test(source)) {
    throw new Error("请输入 npm 包名、Git 来源或本地绝对路径。");
  }
  return source;
}

// Reuse Pi's package semantics and settings writer without loading extensions or
// entering its interactive CLI. Arguments cross the process boundary as JSON.
const INSTALL_PACKAGE = String.raw`
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { root, agentDir, source } = JSON.parse(process.argv[1]);
try {
  const [{ DefaultPackageManager }, { SettingsManager }] = await Promise.all([
    import(pathToFileURL(join(root, "dist/core/package-manager.js")).href),
    import(pathToFileURL(join(root, "dist/core/settings-manager.js")).href),
  ]);
  const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  const before = settings.drainErrors();
  if (before.length) throw before[0].error;
  const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: settings });
  await manager.installAndPersist(source, { local: false });
  await settings.flush();
  const after = settings.drainErrors();
  if (after.length) throw after[0].error;
  console.log("VAGUS_PACKAGE_INSTALL:" + JSON.stringify({ ok: true }));
} catch (error) {
  console.log("VAGUS_PACKAGE_INSTALL:" + JSON.stringify({ ok: false, error: String(error.message || error) }));
  process.exitCode = 1;
}
`;

export async function installPiPackage(command: string, input: string): Promise<ProviderPackageInstallResult> {
  const source = normalizeSource(input);
  const root = await findPiRoot(command);
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", INSTALL_PACKAGE, JSON.stringify({ root, agentDir, source })], {
      cwd: homedir(), env: { ...providerEnvironment(), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
    });
    let output = "";
    let diagnostics = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output = (output + chunk).slice(-131072); });
    child.stderr.on("data", (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-12000); });
    const timer = setTimeout(() => {
      timedOut = true;
      // Terminate npm/git descendants too, so a timed-out install cannot keep
      // modifying the global package directory after the UI offers a retry.
      if (process.platform === "win32" && child.pid) {
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => { child.kill(); });
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }, 300_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("无法启动 Pi 包安装进程。")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error("安装 Pi 包超时，请检查网络后重试。")); return; }
      const record = output.split(/\r?\n/).reverse().find((line) => line.startsWith("VAGUS_PACKAGE_INSTALL:"));
      let result: { ok?: boolean; error?: string } = {};
      try { if (record) result = JSON.parse(record.slice("VAGUS_PACKAGE_INSTALL:".length)); } catch { /* Report bounded diagnostics below. */ }
      if (code === 0 && result.ok) { accept(); return; }
      const detail = (result.error || diagnostics || "请检查包来源和网络后重试。")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, 1500);
      reject(new Error(`安装 Pi 包失败：${detail}`));
    });
  });
  return { providerId: "pi", source, installedAt: new Date().toISOString() };
}
