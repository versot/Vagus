export interface ProviderSessionPreference {
  modelId?: string | null;
  thinkingLevel?: string | null;
  modeId?: string | null;
}

const STORAGE_KEY = "vagus.provider-session-preferences.v1";
const LAST_CREATED_PROVIDER_KEY = "vagus.last-created-provider.v1";

export function getLastCreatedProviderId(): string | null {
  try {
    const value = window.localStorage.getItem(LAST_CREATED_PROVIDER_KEY);
    return value?.trim() || null;
  } catch { return null; }
}

export function rememberLastCreatedProvider(providerId: string): void {
  if (!providerId) return;
  try { window.localStorage.setItem(LAST_CREATED_PROVIDER_KEY, providerId); } catch { /* Keep the current runtime usable if storage is unavailable. */ }
}

function readAll(): Record<string, ProviderSessionPreference> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, ProviderSessionPreference>;
  } catch { return {}; }
}

export function getProviderSessionPreference(providerId: string): ProviderSessionPreference {
  return readAll()[providerId] ?? {};
}

export function saveProviderSessionPreference(providerId: string, update: ProviderSessionPreference): void {
  if (!providerId) return;
  const all = readAll();
  const current = all[providerId] ?? {};
  const next = { ...current };
  for (const key of ["modelId", "thinkingLevel", "modeId"] as const) {
    const value = update[key];
    if (value === null) next[key] = null;
    else if (typeof value === "string" && value) next[key] = value;
  }
  all[providerId] = next;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch { /* Keep the preference for this runtime even if storage is unavailable. */ }
}
