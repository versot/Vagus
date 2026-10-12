import type { ProviderExtensionCatalog } from "@vagus/protocol";
import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { providerEnvironment } from "../../provider-environment.js";

const execFileAsync = promisify(execFile);
const PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"];

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function findPiRoot(command: string): Promise<string> {
  const directories = new Set<string>();
  const names = process.platform === "win32" && !/\.(cmd|exe|bat|ps1)$/i.test(command)
    ? [`${command}.cmd`, `${command}.exe`, `${command}.ps1`, command] : [command];
  for (const directory of isAbsolute(command) || /[/\\]/.test(command)
    ? [process.cwd()] : (process.env.PATH ?? "").split(delimiter)) {
    for (const name of names) {
      const candidate = resolve(directory.replace(/^"|"$/g, ""), name);
      if (!await exists(candidate)) continue;
      const executable = await realpath(candidate);
      directories.add(join(dirname(executable), "node_modules"));
      directories.add(join(dirname(candidate), "node_modules"));
      // Unix npm bin links point into the package itself.
      let ancestor = dirname(executable);
      for (let depth = 0; depth < 5; depth++, ancestor = dirname(ancestor)) {
        if (PI_PACKAGES.some((name) => basename(ancestor) === name.split("/").at(-1))) directories.add(dirname(dirname(ancestor)));
      }
    }
    if (directories.size) break;
  }
  directories.add(join(dirname(process.execPath), "node_modules"));
  for (const directory of directories) {
    for (const name of PI_PACKAGES) {
      const root = join(directory, name);
      if (await exists(join(root, "dist", "core", "package-manager.js"))) return root;
    }
  }
  throw new Error("无法找到本机 Pi 的扩展解析模块，请确认 Pi 已通过 npm 安装。");
}

// Resolve metadata in a short-lived worker process. No resource loader or extension
// entrypoint is imported; missing packages are skipped and settings stay in memory.
const READ_EXTENSIONS = String.raw`
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
const { root, agentDir } = JSON.parse(process.argv[1]);
const [{ DefaultPackageManager }, { SettingsManager }] = await Promise.all([
  import(pathToFileURL(join(root, "dist/core/package-manager.js")).href),
  import(pathToFileURL(join(root, "dist/core/settings-manager.js")).href),
]);
let settings = {};
try { settings = JSON.parse((await readFile(join(agentDir, "settings.json"), "utf8")).replace(/^\uFEFF/, "")); }
catch (error) { if (error.code !== "ENOENT") throw new Error("Pi 全局配置无法读取：" + error.message); }
if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Pi 全局配置格式无效");
const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: SettingsManager.inMemory(settings) });
const warnings = new Set();
const resources = await manager.resolve(async (source) => { warnings.add("未安装或版本不匹配：" + source); return "skip"; });
const groups = new Map();
const clean = (value, length = 300) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, length) : undefined;
for (const resource of resources.extensions) {
  if (resource.metadata.scope !== "user" || resource.path.startsWith("builtin:")) continue;
  if (!await stat(resource.path).then((value) => value.isFile() || value.isDirectory()).catch(() => false)) continue;
  const metadata = resource.metadata;
  const packageRoot = metadata.packageRoot;
  const source = clean(metadata.source) || "local";
  const sourceType = source.startsWith("npm:") ? "npm" : /^(git:|https?:\/\/|git@)/.test(source) ? "git" : "local";
  const id = packageRoot || resource.path;
  let group = groups.get(id);
  if (!group) {
    let manifest = {};
    if (packageRoot) {
      try { manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")); } catch {}
    }
    const name = clean(manifest.name, 160) || (packageRoot ? basename(packageRoot) : basename(resource.path, extname(resource.path)));
    group = { id, name, source: source === "local" ? (packageRoot || resource.path) : source, sourceType,
      version: clean(manifest.version, 60), description: clean(manifest.description), paths: [], states: [] };
    groups.set(id, group);
  }
  if (!group.paths.includes(resource.path)) { group.paths.push(resource.path); group.states.push(resource.enabled); }
}
const extensions = [...groups.values()].map(({ states, ...group }) => ({ ...group,
  paths: group.paths.sort(), configuration: states.every(Boolean) ? "enabled" : states.every((enabled) => !enabled) ? "disabled" : "mixed" }));
extensions.sort((a, b) => a.name.localeCompare(b.name));
console.log("VAGUS_EXTENSIONS:" + JSON.stringify({ extensions, warnings: [...warnings] }));
`;

export async function readPiExtensions(command: string): Promise<ProviderExtensionCatalog> {
  const root = await findPiRoot(command);
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  try {
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", READ_EXTENSIONS, JSON.stringify({ root, agentDir })], {
      timeout: 25_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: providerEnvironment(),
    });
    const record = stdout.split(/\r?\n/).find((line) => line.startsWith("VAGUS_EXTENSIONS:"));
    if (!record) throw new Error("Pi 没有返回扩展目录");
    const catalog = JSON.parse(record.slice("VAGUS_EXTENSIONS:".length)) as Pick<ProviderExtensionCatalog, "extensions" | "warnings">;
    return { providerId: "pi", fetchedAt: new Date().toISOString(), ...catalog };
  } catch (error) {
    // Child-process errors include the entire script/command. Keep that out of the UI.
    const reason = error as Error & { killed?: boolean; stderr?: string };
    if (reason.killed) throw new Error("读取 Pi 扩展目录超时，请重试。");
    const detail = reason.stderr?.match(/(?:Error|SyntaxError): ([^\r\n]+)/)?.[1];
    throw new Error(detail ? `读取 Pi 扩展目录失败：${detail}` : "读取 Pi 扩展目录失败，请确认 Pi 安装完整后重试。");
  }
}
