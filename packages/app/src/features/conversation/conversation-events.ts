import type { AgentEvent } from "@vagus/protocol";
import type { ToolActivity } from "./types.js";

export function applyToolStarted(current: ToolActivity[], event: Extract<AgentEvent, { type: "tool.started" }>, order: number): ToolActivity[] {
  // A tool ID identifies one execution. Repeated starts must not move a
  // historical tool, strip its turn/content, or turn a completed tool running.
  // Subsequent arguments/results arrive through tool.updated/tool.completed.
  if (current.some((activity) => activity.id === event.toolCallId)) return current;
  return [...current, {
    id: event.toolCallId, name: event.name, state: "running", order,
    ...(event.title ? { title: event.title } : {}),
    ...(event.toolKind ? { toolKind: event.toolKind } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
    ...(event.input !== undefined ? { input: event.input } : {}),
    ...(event.content !== undefined ? { content: event.content } : {}),
    ...(event.locations !== undefined ? { locations: event.locations } : {}),
  }];
}
