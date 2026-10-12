/** Native names keep the language picker readable regardless of UI language. */
export const interfaceLanguages = [
  { value: "zh-CN", label: "中文（简体）" },
  { value: "en-US", label: "English" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "de-DE", label: "Deutsch" },
  { value: "fr-FR", label: "Français" },
  { value: "es-ES", label: "Español" },
  { value: "pt-BR", label: "Português (Brasil)" },
] as const;

export type SupportedLanguage = typeof interfaceLanguages[number]["value"];
export type InterfaceLanguage = "system" | SupportedLanguage;

export function isInterfaceLanguage(value: unknown): value is InterfaceLanguage {
  return value === "system" || interfaceLanguages.some((language) => language.value === value);
}

export function resolveInterfaceLanguage(language: InterfaceLanguage): SupportedLanguage {
  if (language !== "system") return language;
  const preferences = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const preference of preferences) {
    const primary = preference.toLowerCase().replaceAll("_", "-").split("-")[0];
    const match = interfaceLanguages.find((candidate) => candidate.value.toLowerCase().split("-")[0] === primary);
    if (match) return match.value;
  }
  return "en-US";
}
