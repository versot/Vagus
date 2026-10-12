import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { AppSettings } from "../features/settings/app-settings.js";
import { chineseResources, englishResources } from "./en-US.js";
import { isInterfaceLanguage, resolveInterfaceLanguage, type InterfaceLanguage } from "./interface-languages.js";

const storageKey = "vagus.interface-language.v1";
function readCachedLanguage(): InterfaceLanguage {
  try {
    const cached = localStorage.getItem(storageKey);
    if (isInterfaceLanguage(cached)) return cached;
  } catch { /* Native settings remain authoritative when storage is unavailable. */ }
  return "system";
}

let requestedLanguage = readCachedLanguage();
let languageRevision = 0;
const initialLanguage = resolveInterfaceLanguage(requestedLanguage);
const localeLoaders: Partial<Record<InterfaceLanguage, () => Promise<{ default: Record<string, string> }>>> = {
  "ja-JP": () => import("./ja-JP.js"),
  "ko-KR": () => import("./ko-KR.js"),
  "de-DE": () => import("./de-DE.js"),
  "fr-FR": () => import("./fr-FR.js"),
  "es-ES": () => import("./es-ES.js"),
  "pt-BR": () => import("./pt-BR.js"),
};

async function ensureLanguageBundle(language: InterfaceLanguage) {
  const load = localeLoaders[language];
  if (!load || i18n.hasResourceBundle(language, "translation")) return;
  const module = await load();
  if (!i18n.hasResourceBundle(language, "translation")) i18n.addResourceBundle(language, "translation", module.default, true, true);
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: chineseResources },
    "en-US": { translation: englishResources },
  },
  lng: initialLanguage,
  fallbackLng: "en-US",
  keySeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
}).then(async () => {
  const revision = languageRevision;
  await ensureLanguageBundle(initialLanguage);
  if (revision === languageRevision) await i18n.changeLanguage(initialLanguage);
});
document.documentElement.lang = initialLanguage;

export async function applyInterfaceLanguage(language: InterfaceLanguage): Promise<void> {
  const revision = ++languageRevision;
  requestedLanguage = isInterfaceLanguage(language) ? language : "system";
  const resolved = resolveInterfaceLanguage(requestedLanguage);
  document.documentElement.lang = resolved;
  try { localStorage.setItem(storageKey, requestedLanguage); } catch { /* Apply without caching. */ }
  await ensureLanguageBundle(resolved);
  if (revision === languageRevision && i18n.language !== resolved) await i18n.changeLanguage(resolved);
}

window.addEventListener("languagechange", () => {
  if (requestedLanguage === "system") void applyInterfaceLanguage("system");
});

let settingsSubscription: Promise<void> | undefined;
export function startInterfaceLanguageSettings(): Promise<void> {
  // Subscribe once per window, before reading persisted settings.
  return settingsSubscription ??= (async () => {
    if (!isTauri()) return;
    let revision = 0;
    await listen<AppSettings>("app-settings:updated", event => {
      revision++;
      void applyInterfaceLanguage(event.payload.interfaceLanguage);
    });
    const loadingRevision = revision;
    const settings = await invoke<AppSettings>("get_app_settings");
    if (loadingRevision === revision) await applyInterfaceLanguage(settings.interfaceLanguage);
  })();
}

export default i18n;
