import type { AgentProvider } from "@vagus/agent-core";
import { AcpProvider } from "./providers/acp/acp-provider.js";
import { BUILTIN_ACP_AGENTS } from "./providers/acp/profiles.js";
import { ClaudeProvider } from "./providers/claude/claude-provider.js";
import { CodexProvider } from "./providers/codex/codex-provider.js";
import { PiProvider, type PiProviderOptions } from "./providers/pi/pi-provider.js";

/** Provider adapters register here; clients consume the same provider-neutral session contract. */
export function createProviderRegistry(options: { pi?: PiProviderOptions } = {}): Map<string, AgentProvider> {
  const pi = new PiProvider(options.pi);
  const claude = new ClaudeProvider();
  const codex = new CodexProvider();
  const providers: AgentProvider[] = [pi, claude, codex, ...BUILTIN_ACP_AGENTS.map((profile) => new AcpProvider(profile))];
  return new Map<string, AgentProvider>(providers.map((provider) => [provider.descriptor.id, provider]));
}
