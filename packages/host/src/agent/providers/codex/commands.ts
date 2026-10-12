import type { AgentCommandInfo } from "@vagus/protocol";

export function codexCommands(): AgentCommandInfo[] {
  return [
    { name: "goal", source: "builtin", action: "goal", description: "查看或管理当前会话目标", inputHint: "输入目标内容；或 pause 暂停、resume 恢复、clear 清除" },
    { name: "review", source: "builtin", action: "review", description: "审查当前工作区未提交的改动", inputHint: "可选：补充审查范围" },
    { name: "mcp", source: "builtin", action: "mcp-status", description: "查看 Codex 当前会话的 MCP 服务器状态" },
    { name: "fast", source: "builtin", action: "fast-mode", description: "切换 Codex 快速服务档位" },
    { name: "feedback", source: "builtin", action: "feedback", description: "向 Codex 提交反馈", inputHint: "描述反馈；不会附带日志" },
    { name: "compact", source: "builtin", action: "compact", description: "压缩当前 Codex 会话的上下文" },
  ];
}

export const CODEX_PERMISSION_MODES = [
  { id: ":read-only", name: "只读" },
  { id: ":workspace", name: "工作区读写" },
  { id: ":danger-full-access", name: "完全访问" },
] as const;
