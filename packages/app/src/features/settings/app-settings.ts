import type { ShortcutOverrides } from "./keyboard-shortcuts.js";

import type { InterfaceLanguage } from "../../locales/interface-languages.js";
export { resolveInterfaceLanguage } from "../../locales/interface-languages.js";
export type { InterfaceLanguage } from "../../locales/interface-languages.js";
export type InterfaceTheme = "system" | "light" | "dark";
export type LightCodeTheme = "github-light" | "solarized-light";
export type DarkCodeTheme = "github-dark" | "monokai";
export type AppearanceSettings = Pick<AppSettings, "interfaceTheme" | "uiFontSize" | "lightCodeTheme" | "darkCodeTheme" | "showCodeLineNumbers" | "wrapCodeLines" | "codeFontSize">;

export interface AppSettings {
  shortcutOverrides: ShortcutOverrides;
  interfaceLanguage: InterfaceLanguage;
  interfaceTheme: InterfaceTheme;
  uiFontSize: number;
  lightCodeTheme: LightCodeTheme;
  darkCodeTheme: DarkCodeTheme;
  showCodeLineNumbers: boolean;
  wrapCodeLines: boolean;
  codeFontSize: number;
  httpProxy: string;
  browserIgnoreCertificateErrors: boolean;
  taskNotifications: boolean;
  notificationSound: boolean;
  closeToTray: boolean;
  keepAwake: boolean;
  dataDirectory: string;
  dataDirectoryFormatVersion: number;
}

export const defaultAppSettings: AppSettings = {
  shortcutOverrides: {},
  interfaceLanguage: "system",
  interfaceTheme: "dark",
  uiFontSize: 14,
  lightCodeTheme: "github-light",
  darkCodeTheme: "github-dark",
  showCodeLineNumbers: true,
  wrapCodeLines: false,
  codeFontSize: 12,
  httpProxy: "",
  browserIgnoreCertificateErrors: false,
  taskNotifications: true,
  notificationSound: true,
  closeToTray: false,
  keepAwake: false,
  dataDirectory: "",
  dataDirectoryFormatVersion: 1,
};

