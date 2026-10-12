import { type ProviderInfo, type ProviderModelCatalog } from "@vagus/client";

export function providerHealthFromCatalog(catalog: ProviderModelCatalog): ProviderInfo["health"] {
  if (catalog.status === "error" || catalog.error) return "unavailable";
  if (catalog.status === "ready" && !catalog.stale) return "healthy";
  return "checking";
}
