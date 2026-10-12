import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import type { AppSettings } from "./app-settings.js";
import defaults from "./keyboard-shortcuts-defaults.json";

export type ShortcutId = "open-settings" | "search-sessions" | "toggle-sidebar" | "toggle-right-panel" | "new-chat" | "open-folder" | "close-window" | "go-back" | "go-forward" | "toggle-fullscreen";
export type ShortcutOverrides = Partial<Record<ShortcutId, string>>;
export interface ShortcutDefinition { id: ShortcutId; label: string; description: string; scope: "app" | "workspace"; binding: string; }
export const shortcutDefinitions = defaults as ShortcutDefinition[];
const storageKey = "vagus.keyboard-shortcuts.v1";
const subscribers = new Set<() => void>();
const modifiers = ["Ctrl", "Alt", "Shift", "Meta"];
const keys: Record<string, string> = { Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Minus: "−", Equal: "=", Backquote: "`", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };

export function bindingParts(binding: string): string[] {
  return binding ? binding.split("+").map((part) => keys[part] ?? part.replace(/^(Key|Digit)/, "")) : [];
}
export function shortcutLabel(binding: string): string { return bindingParts(binding).join("+"); }
export function effectiveShortcuts(overrides: ShortcutOverrides): Record<ShortcutId, string> {
  return Object.fromEntries(shortcutDefinitions.map((definition) => [definition.id, overrides[definition.id] ?? definition.binding])) as Record<ShortcutId, string>;
}

/** Physical key codes keep shortcuts stable when the input language changes. */
export function bindingFromEvent(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  if (!event.code || /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(event.code)) return null;
  return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta", event.code].filter(Boolean).join("+");
}
export function bindingIsAllowed(binding: string): boolean {
  if (!binding) return true;
  const parts = binding.split("+");
  const code = parts.pop()!;
  if (parts.some((part) => !modifiers.includes(part)) || new Set(parts).size !== parts.length
    || parts.join("+") !== modifiers.filter((modifier) => parts.includes(modifier)).join("+")) return false;
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(code);
  if (!functionKey && !/^Key[A-Z]$|^Digit[0-9]$|^Arrow(Left|Right|Up|Down)$/.test(code) && !(code in keys)) return false;
  if (!functionKey && !parts.some((part) => part === "Ctrl" || part === "Alt" || part === "Meta")) return false;
  if (parts.includes("Meta")) return false;
  if (binding === "Alt+F4" || binding === "Ctrl+Alt+Delete") return false;
  // Preserve text editing and focus traversal instead of claiming those combinations.
  if (/^Ctrl\+(Shift\+)?Key[ACVXYZ]$/.test(binding)) return false;
  return true;
}
export function conflictingShortcut(overrides: ShortcutOverrides, id: ShortcutId, binding: string): ShortcutDefinition | undefined {
  if (!binding) return undefined;
  const effective = effectiveShortcuts(overrides);
  return shortcutDefinitions.find((definition) => definition.id !== id && effective[definition.id] === binding);
}
function normalize(overrides: ShortcutOverrides): ShortcutOverrides {
  const normalized: ShortcutOverrides = {};
  if (!overrides || typeof overrides !== "object") return normalized;
  for (const definition of shortcutDefinitions) {
    const binding = overrides[definition.id];
    if (typeof binding === "string" && bindingIsAllowed(binding)) normalized[definition.id] = binding;
  }
  return normalized;
}
let current: ShortcutOverrides = {};
try { current = normalize(JSON.parse(localStorage.getItem(storageKey) ?? "{}") as ShortcutOverrides); } catch { /* Use defaults when the local cache is unavailable. */ }
export function applyShortcutOverrides(overrides: ShortcutOverrides = {}) {
  const next = normalize(overrides);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  try { localStorage.setItem(storageKey, JSON.stringify(current)); } catch { /* Persistent settings remain authoritative. */ }
  for (const subscriber of subscribers) subscriber();
}
export function useKeyboardShortcuts() {
  const overrides = useSyncExternalStore((subscriber) => { subscribers.add(subscriber); return () => { subscribers.delete(subscriber); }; }, () => current);
  return effectiveShortcuts(overrides);
}
export function matchesShortcut(event: KeyboardEvent, id: ShortcutId): boolean {
  const binding = effectiveShortcuts(current)[id];
  return Boolean(binding) && bindingFromEvent(event) === binding;
}
export async function startKeyboardShortcuts() {
  await listen<AppSettings>("app-settings:updated", (event) => applyShortcutOverrides(event.payload.shortcutOverrides));
  applyShortcutOverrides((await invoke<AppSettings>("get_app_settings")).shortcutOverrides);
}
