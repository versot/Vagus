

export const HIDDEN_CLAUDE_COMMANDS = new Set([
  "clear", // Starts a fresh Claude session; Vagus has an explicit new-chat action.
  "color", // Changes the Claude terminal prompt color, not the Vagus UI.
  "effort", // Vagus exposes the ACP effort selector.
  "exit", // Exits the CLI process; Vagus owns session/window lifecycle.
  "fork", // Vagus exposes session branching in the conversation UI.
  "focus", // Changes the Claude terminal transcript layout only.
  "heapdump", // Writes a CLI process memory dump to the user's Desktop.
  "model", // Vagus exposes the ACP model selector.
  "new", // Session creation belongs to the Vagus conversation UI.
  "quit", // Alias of the CLI-only exit command.
  "rename", // Vagus owns conversation titles.
  "resume", // Existing conversations are selected/imported through Vagus.
  "branch", // Vagus exposes session branching in the conversation UI.
  "scroll-speed", // Adjusts scrolling in the CLI's fullscreen renderer.
  "terminal-setup", // Configures terminal-specific key bindings.
  "theme", // Changes the Claude terminal theme, not the Vagus app theme.
  "tui", // Restarts or inspects the CLI terminal renderer.
  "workflow-launch-exec", // Internal workflow launcher published by the CLI.
]);

export function normalizeClaudeCommands(commands: Array<{ name?: string; description?: string; input?: { hint?: string } | null }>): import("@vagus/protocol").AgentCommandInfo[] {
  return commands.flatMap((command) => typeof command.name === "string" && command.name.length > 0
    // Keep suggestions focused on user-facing Claude capabilities. Users can
    // still type hidden native commands directly when they need to.
    && !HIDDEN_CLAUDE_COMMANDS.has(command.name.toLocaleLowerCase())
    && !command.name.startsWith("__")
    ? [{
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      ...(command.input?.hint ? { inputHint: command.input.hint } : {}),
      source: command.name === "compact" ? "builtin" as const : "other" as const,
      ...(command.name === "compact" ? { action: "compact" as const } : {}),
    }]
    : []);
}

export function parseClaudePluginCommandResult(output: string): unknown {
  const lines = output.trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch { /* CLI may print a human-readable preamble before its JSON result. */ }
  }
  try { return JSON.parse(output); } catch { return null; }
}

export function claudePluginOperationError(error: unknown): Error {
  const detail = error as Error & { killed?: boolean; code?: string };
  if (detail.killed) return new Error("Claude Code 插件操作超时；请刷新清单确认实际状态后重试。");
  if (detail.code === "ENOENT") return new Error("找不到本机 Claude Code CLI。");
  return new Error("Claude Code 插件操作失败；请检查本机 Claude Code CLI 和 marketplace 状态后重试。");
}
