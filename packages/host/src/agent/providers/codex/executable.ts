import spawn from "cross-spawn";
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class CodexStartupError extends Error {
  constructor(
    readonly kind: "version" | "launch" | "exit" | "timeout" | "protocol" | "configuration",
    executable: string,
    detail: string,
  ) {
    super(`Codex CLI ${kind} failure: ${detail} (${executable})`);
    this.name = "CodexStartupError";
  }
}

export function codexConfigurationHint(message: string): string {
  if (
    /unauthorized|authentication|not (?:logged|signed) in|(?:invalid|expired).*(?:api key|token)|\b(?:http|status(?: code)?|error(?: code)?)[:\s]*(?:401|403)\b/iu.test(
      message,
    )
  )
    return "Codex authentication failed. Check the local Codex sign-in and account configuration.";
  if (/error parsing.*config|failed to (?:load|parse).*config|invalid.*config(?:uration)?/iu.test(message))
    return "Codex configuration could not be loaded. Check the local Codex configuration.";
  return "";
}

export function codexStartupHint(stderr: string): string {
  if (/bad cpu type|wrong architecture|exec format error/iu.test(stderr))
    return "The installed CLI is incompatible with this CPU architecture.";
  if (/env:.*node.*(?:no such file|not found)|['"]?node['"]?.*not recognized/iu.test(stderr))
    return "Node.js is unavailable in the CLI's PATH. Install Node.js 22.13 or later.";
  if (/cannot find module|cannot find package|missing.*(?:codex|optional dependency)/iu.test(stderr))
    return "The Codex CLI installation is incomplete. Reinstall the CLI for this platform.";
  if (/(?:unrecognized|unknown|unexpected).*(?:app-server|--listen)/iu.test(stderr))
    return "This CLI does not support the required app-server command. Update Codex CLI.";
  return "";
}

/** Read only the launcher header; standalone native binaries can be hundreds of MB. */
export async function npmCodexArm64Binaries(executable: string): Promise<string[]> {
  try {
    const entry = await realpath(executable);
    const file = await open(entry, "r");
    let isNodeLauncher = false;
    try {
      const header = Buffer.alloc(32);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      isNodeLauncher = header.subarray(0, bytesRead).toString("utf8").startsWith("#!/usr/bin/env node");
    } finally {
      await file.close();
    }
    if (!isNodeLauncher) return [];
    const packageRoot = dirname(dirname(entry));
    const root = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (root.name !== "@openai/codex" || typeof root.version !== "string") return [];
    const arm64PackagePath = createRequire(entry).resolve("@openai/codex-darwin-arm64/package.json");
    const arm64 = JSON.parse(await readFile(arm64PackagePath, "utf8"));
    if (arm64.version !== `${root.version}-darwin-arm64`) return [];
    const vendor = join(dirname(arm64PackagePath), "vendor", "aarch64-apple-darwin");
    const binaries: string[] = [];
    for (const relative of [
      ["bin", "codex"],
      ["codex", "codex"],
    ]) {
      const binary = join(vendor, ...relative);
      try {
        if (!(await stat(binary)).isFile()) continue;
        await access(binary, constants.X_OK);
        binaries.push(binary);
      } catch {
        // The native package may use either the current or legacy layout.
      }
    }
    return binaries;
  } catch {
    return [];
  }
}

export async function nativeArm64CodexBinaries(executable: string, environment: NodeJS.ProcessEnv): Promise<string[]> {
  if (process.platform !== "darwin" || process.arch !== "x64" || environment.VAGUS_CODEX_EXECUTABLE?.trim()) return [];
  try {
    const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], {
      timeout: 1_000,
      maxBuffer: 4_096,
    });
    return stdout.trim() === "1" ? npmCodexArm64Binaries(executable) : [];
  } catch {
    return [];
  }
}

export async function terminateCodexProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = new Promise<void>((resolve) => child.once("close", () => resolve()));
  if (child.pid && process.platform !== "win32") {
    // Each CLI gets its own process group, including any npm launcher child.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") {
      // npm .cmd launchers have a child Node process; terminate the entire tree.
      await execFileAsync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
        timeout: 2_000,
        windowsHide: true,
      }).catch(() => child.kill("SIGKILL"));
    }
    await Promise.race([
      ended,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
      }),
    ]);
  }
  if (timer) clearTimeout(timer);
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}

export async function probeCodexVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const child = spawn(executable, ["--version"], {
    env: environment,
    windowsHide: true,
    stdio: "pipe",
    detached: process.platform !== "win32",
  }) as ChildProcessWithoutNullStreams;
  await new Promise<void>((resolve, reject) => {
    let stdout = "",
      stderr = "",
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      if (error)
        void terminateCodexProcess(child).then(
          () => reject(error),
          () => reject(error),
        );
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new CodexStartupError("timeout", executable, "Version check timed out.")),
      timeoutMs,
    );
    const cancelled = () => finish(new Error("Codex app-server startup was cancelled."));
    signal?.addEventListener("abort", cancelled, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-8_192);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096);
    });
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish(new CodexStartupError("launch", executable, error.code ?? "Process could not be launched.")),
    );
    child.stdin.on("error", () => undefined);
    child.stdout.on("error", () =>
      finish(new CodexStartupError("version", executable, "Version output could not be read.")),
    );
    child.stderr.on("error", () => undefined);
    child.once("close", (code) => {
      const version = /^codex(?:-cli)?\s+\d+\.\d+\.\d+(?:[-+]\S+)?\s*$/imu.test(stdout);
      const configuration = codexConfigurationHint(stderr);
      finish(
        code === 0 && version
          ? undefined
          : configuration
            ? new CodexStartupError("configuration", executable, configuration)
            : new CodexStartupError(
                "version",
                executable,
                codexStartupHint(stderr) || "The executable did not return a Codex CLI version.",
              ),
      );
    });
    child.stdin.end();
  });
}
