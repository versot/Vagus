import { invoke } from "@tauri-apps/api/core";
import { Profiler } from "react";
import { createRoot } from "react-dom/client";
import "./features/settings/appearance.css";
import { startAppearanceSettings } from "./features/settings/appearance.js";
import { startKeyboardShortcuts } from "./features/settings/keyboard-shortcuts.js";
import { appPerformance, recordPerformance } from "./lib/performance.js";
import { startInterfaceLanguageSettings } from "./locales/i18n.js";
import { WorkspaceApp } from "./shell/workspace-app.js";
import "./styles.css";
import "./workspace-tabs/builtins.js";

void startAppearanceSettings().catch(console.error);
void startKeyboardShortcuts().catch(console.error);

// Opt-in desktop-only diagnostic capture. The native layer writes aggregate timing data
// to its cache directory only when VAGUS_CAPTURE_PERF=1; no conversation content is sent.
void invoke<string | null>("start_performance_capture").then((path) => {
  if (!path) return;
  appPerformance.reset();
  appPerformance.enable(true);
  window.setInterval(() => {
    void invoke("append_performance_capture", { snapshot: appPerformance.snapshot() }).catch(console.error);
  }, 5_000);
}).catch(() => undefined);

function renderWorkspace() {
  createRoot(document.getElementById("root")!).render(<Profiler id="workspace" onRender={(_id, phase, actualDuration, baseDuration) => {
    recordPerformance(`react.workspace.${phase}.actual`, actualDuration);
    recordPerformance(`react.workspace.${phase}.base`, baseDuration);
  }}><WorkspaceApp /></Profiler>);
}

// Load the persisted interface language before mounting React so a newly opened
// window never paints the default/system language first and leaves a mixed UI.
void startInterfaceLanguageSettings().catch(console.error).then(renderWorkspace);
