export interface AcpAgentProfile {
  id: string;
  displayName: string;
  command: string;
  executableEnvironmentVariables: string[];
  args: string[];
  modelSource: string;
}

export const BUILTIN_ACP_AGENTS: AcpAgentProfile[] = [
  {
    id: "opencode",
    displayName: "OpenCode",
    command: "opencode",
    executableEnvironmentVariables: ["VAGUS_OPENCODE_EXECUTABLE"],
    args: ["acp"],
    modelSource: "opencode",
  },
  {
    id: "qoder",
    displayName: "Qoder CLI",
    command: "qoder",
    executableEnvironmentVariables: ["VAGUS_QODER_EXECUTABLE"],
    args: ["--acp"],
    modelSource: "qoder",
  },
  // npm's Windows .cmd shim invokes dist/cli.js directly, so the CLI cannot
  // detect the zcode-acp-server alias from argv[1]. Be explicit to avoid
  // falling back to its interactive TUI (which exits cleanly without a TTY).
  {
    id: "zcode",
    displayName: "ZCode",
    command: "zcode-acp-server",
    executableEnvironmentVariables: ["VAGUS_ZCODE_EXECUTABLE"],
    args: ["server"],
    modelSource: "zcode",
  },
];
