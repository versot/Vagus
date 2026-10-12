

export interface AcpAgentProfile {
  id: string;
  displayName: string;
  command: string;
  args: string[];
  modelSource: string;
}

export const BUILTIN_ACP_AGENTS: AcpAgentProfile[] = [
  { id: "opencode", displayName: "OpenCode", command: "opencode", args: ["acp"], modelSource: "opencode" },
  { id: "qoder", displayName: "Qoder CLI", command: "qoder", args: ["--acp"], modelSource: "qoder" },
  // npm's Windows .cmd shim invokes dist/cli.js directly, so the CLI cannot
  // detect the zcode-acp-server alias from argv[1]. Be explicit to avoid
  // falling back to its interactive TUI (which exits cleanly without a TTY).
  { id: "zcode", displayName: "ZCode", command: "zcode-acp-server", args: ["server"], modelSource: "zcode" },
];
