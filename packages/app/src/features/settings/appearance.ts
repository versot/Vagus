import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSyncExternalStore } from "react";
import { defaultAppSettings, type AppSettings, type AppearanceSettings } from "./app-settings.js";

const storageKey = "vagus.appearance";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const subscribers = new Set<() => void>();

function normalize(settings: Partial<AppearanceSettings>): AppearanceSettings {
  return {
    interfaceTheme: ["light", "dark", "system"].includes(settings.interfaceTheme ?? "") ? settings.interfaceTheme! : defaultAppSettings.interfaceTheme,
    uiFontSize: Math.max(12, Math.min(20, Math.round(Number.isFinite(settings.uiFontSize) ? settings.uiFontSize! : 14))),
    codeFontSize: Math.max(10, Math.min(20, Math.round(Number.isFinite(settings.codeFontSize) ? settings.codeFontSize! : 12))),
    lightCodeTheme: settings.lightCodeTheme === "solarized-light" ? "solarized-light" : "github-light",
    darkCodeTheme: settings.darkCodeTheme === "monokai" ? "monokai" : "github-dark",
    showCodeLineNumbers: settings.showCodeLineNumbers ?? true,
    wrapCodeLines: settings.wrapCodeLines ?? false,
  };
}

function readCachedSettings(): AppearanceSettings {
  try { return normalize(JSON.parse(localStorage.getItem(storageKey) ?? "{}") as AppearanceSettings); }
  catch { return normalize(defaultAppSettings); }
}

let settings = readCachedSettings();
function snapshot() {
  const resolvedTheme = settings.interfaceTheme === "system" ? (systemTheme.matches ? "dark" : "light") : settings.interfaceTheme;
  return { ...settings, resolvedTheme };
}
let current = snapshot();
let nativeTheme: "light" | "dark" | undefined;

function updateDocument() {
  document.documentElement.dataset.theme = current.resolvedTheme;
  // Only Windows workspace windows have a transparent native backing surface.
  if (isTauri() && /Windows/i.test(navigator.userAgent)) {
    document.documentElement.dataset.windowGlass = "true";
    if (nativeTheme !== current.resolvedTheme) {
      nativeTheme = current.resolvedTheme;
      void getCurrentWindow().setTheme(current.resolvedTheme).catch((error) => {
        nativeTheme = undefined;
        console.warn("Vagus could not update the native window theme", error);
      });
    }
  }
  document.documentElement.style.setProperty("--ui-font-size", `${settings.uiFontSize}px`);
  document.documentElement.style.setProperty("--code-font-size", `${settings.codeFontSize}px`);
}
updateDocument();

export function applyAppearance(next: Partial<AppearanceSettings>) {
  settings = normalize(next);
  const updated = snapshot();
  if (JSON.stringify(updated) === JSON.stringify(current)) {
    updateDocument();
    return;
  }
  current = updated;
  updateDocument();
  try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Settings still work when storage is unavailable. */ }
  for (const subscriber of subscribers) subscriber();
}

systemTheme.addEventListener("change", () => applyAppearance(settings));
export function useAppearance() {
  return useSyncExternalStore((subscriber) => {
    subscribers.add(subscriber);
    return () => { subscribers.delete(subscriber); };
  }, () => current);
}

export async function startAppearanceSettings() {
  // Subscribe before loading so another window's save cannot be missed.
  await listen<AppSettings>("app-settings:updated", (event) => applyAppearance(event.payload));
  applyAppearance(await invoke<AppSettings>("get_app_settings"));
}
