import { type SessionConfigOption, type SessionModeState } from "@agentclientprotocol/sdk";
import type { AgentRuntimeSettings, ProviderModelCatalog, ProviderModelInfo } from "@vagus/protocol";
import { type AcpAgentProfile } from "./profiles.js";

export function choices(option: SessionConfigOption): Array<{ value: string; name: string }> {
  if (option.type !== "select") return [];
  return option.options.flatMap((item) => "options" in item ? item.options.map(({ value, name }) => ({ value, name })) : [{ value: item.value, name: item.name }]);
}

export function modeStateFromConfigOptions(options: SessionConfigOption[]): SessionModeState | null {
  const option = options.find((item) => item.category === "mode");
  if (!option || option.type !== "select") return null;
  const availableModes = option.options.flatMap((item) => "options" in item ? item.options : [item]).map(({ value, name, description }) => ({ id: value, name, ...(description ? { description } : {}) }));
  if (!availableModes.length) return null;
  return { currentModeId: option.currentValue, availableModes };
}

export function settingsFromAcpOptions(providerId: string, options: SessionConfigOption[] = [], modes?: SessionModeState | null, previous?: AgentRuntimeSettings): AgentRuntimeSettings {
  const model = options.find((option) => option.category === "model");
  const thought = options.find((option) => option.category === "thought_level");
  const configModes = modeStateFromConfigOptions(options);
  const activeModes = modes ?? configModes ?? (options.length ? null : previous?.availableModes ? { currentModeId: previous.currentModeId ?? "", availableModes: previous.availableModes } : null);
  return {
    providerId,
    modelId: model?.type === "select" ? model.currentValue : previous?.modelId ?? null,
    // ACP configOptions describe the live session. Do not carry a previous
    // model's thinking controls forward when the agent omits thought_level.
    thinkingLevel: thought?.type === "select" ? thought.currentValue : null,
    thinkingLevels: thought ? choices(thought).map((item) => item.value) : [],
    ...(activeModes ? { currentModeId: activeModes.currentModeId, availableModes: activeModes.availableModes.map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) })) } : {}),
  };
}

export function catalogFrom(provider: AcpAgentProfile, options: SessionConfigOption[] = [], modes?: SessionModeState | null): ProviderModelCatalog {
  const model = options.find((option) => option.category === "model");
  const thought = options.find((option) => option.category === "thought_level");
  const levels = thought ? choices(thought).map((item) => item.value) : [];
  const models: ProviderModelInfo[] = model ? choices(model).map(({ value, name }) => ({ id: value, name, source: provider.modelSource, ...(levels.length ? { thinkingLevels: levels } : {}) })) : [];
  const availableModes = modes ?? modeStateFromConfigOptions(options);
  return { providerId: provider.id, models, currentModelId: model?.type === "select" ? model.currentValue : null, currentThinkingLevel: thought?.type === "select" ? thought.currentValue : null, ...(availableModes ? { currentModeId: availableModes.currentModeId, availableModes: availableModes.availableModes.map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) })) } : {}), fetchedAt: new Date().toISOString(), status: "ready", stale: false };
}
