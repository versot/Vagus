import { type RpcRecord } from "./types.js";
import { isRecord } from "./utils.js";

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function thinkingLevelsForModel(model: RpcRecord | null): string[] {
  if (!model || model.reasoning === false) return [];
  const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : null;
  return PI_THINKING_LEVELS.filter((option) => {
    const mapped = map?.[option];
    if (mapped === null) return false;
    return option !== "xhigh" && option !== "max" || mapped !== undefined;
  });
}
