import { type SessionConfigOption, type SessionModeState } from "@agentclientprotocol/sdk";
import type { AgentRuntimeSettings, ProviderModelCatalog, ProviderModelInfo } from "@vagus/protocol";

export function isClaudeConfigOptionApplied(options: SessionConfigOption[], configId: string, expectedValue: string): boolean {
  const option = options.find((item) => item.id === configId);
  return option?.type === "select" && option.currentValue === expectedValue;
}

export function configSelectOptions(option: SessionConfigOption): Array<{ value: string; name: string }> {
  if (option.type !== "select") return [];
  return option.options.flatMap((item) => "options" in item
    ? item.options.map((nested) => ({ value: nested.value, name: nested.name }))
    : [{ value: item.value, name: item.name }]);
}

export function settingsFrom(options: SessionConfigOption[] | null | undefined, previous?: AgentRuntimeSettings, modes?: SessionModeState | null): AgentRuntimeSettings {
  const model = options?.find((option) => option.category === "model");
  const thought = options?.find((option) => option.category === "thought_level");
  const modelOptions = model ? configSelectOptions(model) : [];
  const thoughtOptions = thought ? configSelectOptions(thought).map((item) => item.value) : [];
  return {
    providerId: "claude",
    modelId: model?.type === "select" ? model.currentValue : previous?.modelId ?? null,
    thinkingLevel: thought?.type === "select" ? thought.currentValue : previous?.thinkingLevel ?? null,
    thinkingLevels: thoughtOptions.length ? thoughtOptions : previous?.thinkingLevels ?? [],
    ...(modes ? {
      currentModeId: modes.currentModeId,
      availableModes: modes.availableModes.map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) })),
    } : previous?.availableModes ? { currentModeId: previous.currentModeId ?? null, availableModes: previous.availableModes } : {}),
    ...(!modelOptions.length && previous?.modelId ? { modelId: previous.modelId } : {}),
  };
}

export function catalogFrom(options: SessionConfigOption[] | null | undefined, modes?: SessionModeState | null): ProviderModelCatalog {
  const model = options?.find((option) => option.category === "model");
  const thought = options?.find((option) => option.category === "thought_level");
  const thinkingLevels = thought ? configSelectOptions(thought).map((item) => item.value) : [];
  const modelOptions = model ? configSelectOptions(model) : [];
  const duplicateNames = new Map<string, number>();
  for (const option of modelOptions) duplicateNames.set(option.name, (duplicateNames.get(option.name) ?? 0) + 1);
  const models: ProviderModelInfo[] = modelOptions.map(({ value, name }) => ({
    id: value,
    // Claude Code can expose different aliases that resolve to the same
    // configured model name. Keep those choices distinguishable in Vagus.
    name: (duplicateNames.get(name) ?? 0) > 1 ? `${name} (${value})` : name,
    source: "claude-code",
    ...(thinkingLevels.length ? { thinkingLevels } : {}),
  }));
  return {
    providerId: "claude",
    models,
    currentModelId: model?.type === "select" ? model.currentValue : null,
    currentThinkingLevel: thought?.type === "select" ? thought.currentValue : null,
    ...(modes ? { currentModeId: modes.currentModeId, availableModes: modes.availableModes.map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) })) } : {}),
    fetchedAt: new Date().toISOString(),
    status: "ready",
    stale: false,
  };
}
