import type { ProviderMcpCatalog, ProviderMcpServer } from "@vagus/protocol";

export function parseClaudeMcpList(output: string): ProviderMcpCatalog["servers"] {
  const stripAnsi = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
  const servers: ProviderMcpCatalog["servers"] = [];
  for (const rawLine of stripAnsi.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || /^(checking|no MCP servers|no servers configured)/iu.test(line)) continue;
    // `claude mcp list` prints a server name followed by implementation details,
    // which may contain credentials. Keep only the initial identifier and
    // explicitly recognized status/transport tokens.
    const match = line.match(/^([\w.-]{1,128})(?=\s*[:(\[])/u) ?? line.match(/^([\w.-]{1,128})\s+/u);
    if (!match) continue;
    const name = match[1]!;
    const lower = line.toLocaleLowerCase();
    if (!/\b(connected|disconnected|not connected|pending|approval|authentication|auth|disabled|rejected|cached|not configured|starting|connecting|error|failed)\b|[✔✓√⏸⊘✘!]/u.test(lower)) continue;
    const status: ProviderMcpCatalog["servers"][number]["status"] = /\bneeds authentication\b|\bneeds auth\b|\bunauthorized\b|\bauthentication required\b/u.test(lower) ? "needs-authentication"
      : /\bpending approval\b|\bpending\b|\bapproval required\b|⏸/u.test(lower) ? "pending"
        : /\brejected\b/u.test(lower) ? "rejected"
          : /\bdisabled for this project\b|\bdisabled\b|⊘/u.test(lower) ? "disabled"
            : /\bnot configured\b/u.test(lower) ? "not-configured"
              : /\bcached\b/u.test(lower) ? "cached"
                : /\bconnected\b|\bready\b|[✔✓√]\s*connected\b/u.test(lower) ? "connected"
                  : /\b(disconnected|not connected)\b/u.test(lower) ? "disconnected"
                    : /\b(pending|starting|connecting)\b/u.test(lower) ? "pending"
                      : /\b(error|failed|✘|!)/u.test(lower) ? "error" : "unknown";
    const transport: ProviderMcpCatalog["servers"][number]["transport"] = /\bwebsocket\b|\bws\b/u.test(lower) ? "websocket"
      : /\bhttps?\b|\bhttp\b/u.test(lower) ? "http"
        : /\bsse\b/u.test(lower) ? "sse"
          : /\bstdio\b|\bcommand\b|\bcmd\b|\bnpx\b|\bnode\b|\bpython\b/u.test(lower) ? "stdio" : "unknown";
    servers.push({ name, scope: "unknown", transport, status });
  }
  return servers;
}

export function parseClaudeMcpDetails(name: string, output: string): ProviderMcpServer {
  const fields = new Map<string, string>();
  for (const line of output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").split(/\r?\n/u)) {
    const match = line.match(/^\s{1,8}(Status|Type|Scope):\s*(.*?)\s*$/iu);
    if (match) fields.set(match[1]!.toLocaleLowerCase(), match[2]!.toLocaleLowerCase());
  }
  const scopeValue = fields.get("scope") ?? "";
  const scopeMatch = scopeValue.match(/^(local|project|user|managed)(?=\b|\s|\(|$)/u);
  const scope: ProviderMcpServer["scope"] = scopeMatch ? scopeMatch[1] as ProviderMcpServer["scope"] : "unknown";
  const type = fields.get("type") ?? "";
  const transport: ProviderMcpServer["transport"] = type === "stdio" ? "stdio" : type === "http" || type === "streamable-http" ? "http" : type === "sse" ? "sse" : type === "ws" || type === "websocket" ? "websocket" : "unknown";
  const statusLine = fields.get("status") ?? "";
  const lower = statusLine.toLocaleLowerCase();
  const status: ProviderMcpServer["status"] = /needs authentication|needs auth|unauthorized|authentication required/u.test(lower) ? "needs-authentication"
    : /pending approval|pending|approval required/u.test(lower) ? "pending"
      : /rejected/u.test(lower) ? "rejected"
        : /disabled/u.test(lower) ? "disabled"
          : /not configured/u.test(lower) ? "not-configured"
            : /cached/u.test(lower) ? "cached"
              : /connected|ready/u.test(lower) ? "connected"
                : /disconnected|not connected/u.test(lower) ? "disconnected"
                  : /connecting|starting/u.test(lower) ? "pending"
                    : /failed|error/u.test(lower) ? "error" : "unknown";
  return { name, scope, transport, status };
}
