import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let loginPath: Promise<string | null> | undefined;

function macOSLoginPath(environment: NodeJS.ProcessEnv): Promise<string | null> {
  if (loginPath) return loginPath;
  const pending = (async () => {
    const shell = environment.SHELL || "/bin/zsh";
    try {
      const { stdout } = await execFileAsync(shell, ["-lic", "printf '\\n__VAGUS_PATH__%s\\n' \"$PATH\""], {
        env: environment,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      const match = stdout.match(/(?:^|\n)__VAGUS_PATH__([^\n]*)/u);
      return match?.[1] || null;
    } catch {
      // GUI apps may not have a usable interactive login shell; keep the inherited PATH.
      return null;
    }
  })();
  loginPath = pending;
  // Share concurrent startup lookups, but let later refreshes observe CLI
  // installers that update the user's login-shell configuration.
  void pending.then(() => {
    if (loginPath === pending) loginPath = undefined;
  });
  return pending;
}

function commonExecutableDirectories(environment: NodeJS.ProcessEnv): string[] {
  const home = environment.USERPROFILE || environment.HOME || homedir();
  const appData = environment.APPDATA || join(home, "AppData", "Roaming");
  const localAppData = environment.LOCALAPPDATA || join(home, "AppData", "Local");
  return [
    join(home, ".local", "bin"),
    join(home, ".local", "share", "pnpm"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".nvm", "current", "bin"),
    join(appData, "npm"),
    join(localAppData, "pnpm"),
    join(localAppData, "Programs", "OpenAI", "Codex", "bin"),
    join(home, "Library", "pnpm"),
    join(home, "Library", "Application Support", "mise", "shims"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    "/usr/bin",
    "/bin",
  ];
}

/** Find user-installed CLIs outside a desktop app's inherited PATH. */
export async function providerSearchPaths(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ directory: string; source: "environment" | "login-shell" | "common-location" }>> {
  const inherited = environment.PATH ?? environment.Path ?? "";
  const paths: Array<{ directory: string; source: "environment" | "login-shell" | "common-location" }> = [];
  const seen = new Set<string>();
  const add = (directory: string, source: "environment" | "login-shell" | "common-location") => {
    const trimmed = directory.trim().replace(/^"|"$/gu, "");
    if (!trimmed) return;
    const normalized = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    paths.push({ directory: trimmed, source });
  };
  for (const directory of inherited.split(delimiter)) add(directory, "environment");
  if (process.platform === "darwin") {
    const shellPath = await macOSLoginPath(environment);
    for (const directory of (shellPath ?? "").split(delimiter)) add(directory, "login-shell");
  }
  for (const directory of commonExecutableDirectories(environment)) add(directory, "common-location");
  return paths;
}

export async function providerSearchPath(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return (await providerSearchPaths(environment)).map(({ directory }) => directory).join(delimiter);
}

/** Desktop bridge credentials belong to the Host, never to provider/package workers. */
export function providerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.VAGUS_HOST_TOKEN;
  delete environment.VAGUS_ALLOWED_ORIGINS;
  return environment;
}

export async function providerEnvironmentWithSearchPath(): Promise<NodeJS.ProcessEnv> {
  const environment = providerEnvironment();
  const path = await providerSearchPath(environment);
  if (path) environment.PATH = path;
  return environment;
}
