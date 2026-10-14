import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { providerSearchPaths } from "./provider-environment.js";

const execFileAsync = promisify(execFile);

export interface ProviderExecutableSearch {
  displayName: string;
  commandNames: string[];
  environmentVariables?: string[];
  candidatePaths?: string[];
  candidateDirectories?: string[];
  environment?: NodeJS.ProcessEnv;
  validate?: (candidate: ResolvedProviderExecutable) => Promise<ResolvedProviderExecutable | undefined>;
  strictConfigured?: boolean;
}

export interface ResolvedProviderExecutable {
  path: string;
  source: string;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(name: string, environment: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32" || extname(name)) return [name];
  const pathExt = (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [
    name,
    ...pathExt.map((extension) => `${name}${extension.toLowerCase()}`),
    ...pathExt.map((extension) => `${name}${extension.toUpperCase()}`),
  ];
}

async function searchDirectories(
  names: string[],
  directories: Array<{ directory: string; source: string }>,
  environment: NodeJS.ProcessEnv,
  validate?: ProviderExecutableSearch["validate"],
): Promise<ResolvedProviderExecutable | undefined> {
  for (const { directory, source } of directories) {
    for (const name of names) {
      for (const fileName of executableNames(name, environment)) {
        const candidate = join(directory, fileName);
        if (await isExecutableFile(candidate)) {
          const found = { path: candidate, source };
          const accepted = validate ? await validate(found) : found;
          if (accepted) return accepted;
        }
      }
    }
  }
  return undefined;
}

function safeSearchName(name: string): boolean {
  return /^[\w.-]+$/u.test(name) && name !== "." && name !== "..";
}

async function indexedSearch(
  names: string[],
  environment: NodeJS.ProcessEnv,
  validate?: ProviderExecutableSearch["validate"],
): Promise<ResolvedProviderExecutable | undefined> {
  const safeNames = [...new Set(names.filter(safeSearchName))];
  if (!safeNames.length) return undefined;

  if (process.platform === "darwin") {
    try {
      const query = safeNames.map((name) => `kMDItemFSName == "${name}"`).join(" || ");
      const { stdout } = await execFileAsync("mdfind", [query], {
        timeout: 3_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        env: environment,
      });
      for (const candidate of stdout.split(/\r?\n/u).filter(Boolean).slice(0, 100)) {
        if (!safeNames.includes(basename(candidate))) continue;
        if (await isExecutableFile(candidate)) {
          const found = { path: candidate, source: "macOS search index" };
          const accepted = validate ? await validate(found) : found;
          if (accepted) return accepted;
        }
      }
    } catch {
      // Spotlight may be unavailable, disabled, or still indexing; known paths remain searchable.
    }
  }

  if (process.platform === "win32") {
    const keys = [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
      "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
      "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    ];
    for (const name of safeNames) {
      const executable = extname(name) ? name : `${name}.exe`;
      for (const root of keys) {
        const key = `${root}\\${executable}`;
        try {
          const { stdout } = await execFileAsync("reg.exe", ["query", key, "/ve"], {
            timeout: 2_000,
            maxBuffer: 32 * 1024,
            windowsHide: true,
            env: environment,
          });
          const value = stdout
            .match(/\(Default\)\s+REG_SZ\s+(.+)/iu)?.[1]
            ?.trim()
            .replace(/^"|"$/gu, "");
          if (value && (await isExecutableFile(value))) {
            const found = { path: value, source: "Windows App Paths registry" };
            const accepted = validate ? await validate(found) : found;
            if (accepted) return accepted;
          }
        } catch {
          // Missing per-user or machine entries are expected for command-line installs.
        }
      }
    }
  }

  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("whereis", ["-b", ...safeNames], {
        timeout: 2_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: environment,
      });
      for (const candidate of stdout.split(/\r?\n/u).flatMap((line) => line.trim().split(/\s+/u).slice(1))) {
        if (!isAbsolute(candidate) || !safeNames.includes(basename(candidate))) continue;
        if (await isExecutableFile(candidate)) {
          const found = { path: candidate, source: "system binary index" };
          const accepted = validate ? await validate(found) : found;
          if (accepted) return accepted;
        }
      }
    } catch {
      // `whereis` is optional; PATH and standard install directories are sufficient fallbacks.
    }
  }
  return undefined;
}

export async function resolveProviderExecutable(
  options: ProviderExecutableSearch,
): Promise<ResolvedProviderExecutable> {
  const environment = options.environment ?? process.env;
  const validate = options.validate;
  const configured = options.environmentVariables?.map((key) => environment[key]?.trim()).find(Boolean);
  const names = [...new Set([...(configured && !isAbsolute(configured) ? [configured] : []), ...options.commandNames])];

  if (configured && (isAbsolute(configured) || /[/\\]/u.test(configured))) {
    const configuredPath = isAbsolute(configured) ? configured : resolve(configured);
    if (await isExecutableFile(configuredPath)) {
      const found = {
        path: configuredPath,
        source: `setting ${options.environmentVariables?.find((key) => environment[key]?.trim() === configured) ?? "executable override"}`,
      };
      const accepted = validate ? await validate(found) : found;
      if (accepted) return accepted;
      throw new Error(`${options.displayName} configured executable could not be started: ${configured}`);
    }
    throw new Error(`${options.displayName} 可执行文件配置路径无效：${configured}`);
  }

  for (const name of names) {
    if (isAbsolute(name) && (await isExecutableFile(name))) {
      const found = { path: name, source: "absolute command path" };
      const accepted = validate ? await validate(found) : found;
      if (accepted) return accepted;
    }
  }
  const searchPaths = await providerSearchPaths(environment);
  if (configured && !isAbsolute(configured) && !configured.includes("/") && !configured.includes("\\")) {
    const configuredExecutable = await searchDirectories([configured], searchPaths, environment, validate);
    if (configuredExecutable)
      return {
        ...configuredExecutable,
        source: `setting ${options.environmentVariables?.find((key) => environment[key]?.trim() === configured) ?? "executable override"}`,
      };
    if (options.strictConfigured)
      throw new Error(`${options.displayName} configured command is missing or unusable: ${configured}`);
  }
  const found = await searchDirectories(names, searchPaths, environment, validate);
  if (found) return found;

  for (const candidate of options.candidatePaths ?? []) {
    if (await isExecutableFile(candidate)) {
      const found = { path: candidate, source: "provider install location" };
      const accepted = validate ? await validate(found) : found;
      if (accepted) return accepted;
    }
  }
  const candidate = await searchDirectories(
    names,
    (options.candidateDirectories ?? []).map((directory) => ({ directory, source: "provider install location" })),
    environment,
    validate,
  );
  if (candidate) return candidate;

  const indexed = await indexedSearch(names, environment, validate);
  if (indexed) return indexed;

  throw new Error(
    `找不到本机 ${options.displayName} 命令（${options.commandNames.join(" / ")}）。已检查应用 PATH、登录 Shell PATH、常见安装目录和系统索引；可通过 ${options.environmentVariables?.[0] ?? "对应的 VAGUS_*_EXECUTABLE 设置"} 指定路径。`,
  );
}
