import { execFile } from "node:child_process";
import { delimiter } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let loginPath: Promise<string | null> | undefined;

function macOSLoginPath(environment: NodeJS.ProcessEnv): Promise<string | null> {
  if (loginPath) return loginPath;
  loginPath = (async () => {
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
  return loginPath;
}

/** Find user-installed CLIs when a macOS GUI launch has a smaller PATH than Terminal. */
export async function providerSearchPath(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const inherited = environment.PATH ?? environment.Path ?? "";
  if (process.platform !== "darwin") return inherited;
  const shellPath = await macOSLoginPath(environment);
  if (!shellPath) return inherited;
  return [...new Set([...shellPath.split(delimiter), ...inherited.split(delimiter)].filter(Boolean))].join(delimiter);
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
