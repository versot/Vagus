import { useLayoutEffect, useRef, useState } from "react";


const WORKSPACE_PANEL_RATIOS_KEY = "vagus.workspace-side-panel-ratios.v1";

const LEGACY_WORKSPACE_PANEL_WIDTH_KEY = "vagus.workspace-side-panel-width";

const DEFAULT_WORKSPACE_PANEL_RATIO = 0.5;

export function useWorkspacePanelSize(selectedSessionId: string | null) {
  const workspaceViewBodyRef = useRef<HTMLDivElement>(null);
  const [workspacePanelRatios, setWorkspacePanelRatios] = useState<Record<string, number>>(() => {
    try {
      const stored = window.localStorage.getItem(WORKSPACE_PANEL_RATIOS_KEY);
      if (!stored) return {};
      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0 && entry[1] < 1));
    } catch { return {}; }
  });
  const workspacePanelRatio = selectedSessionId ? workspacePanelRatios[selectedSessionId] ?? DEFAULT_WORKSPACE_PANEL_RATIO : null;
  const workspaceSidePanelWidth = workspacePanelRatio === null ? null : Math.round((workspaceViewBodyRef.current?.clientWidth || window.innerWidth) * workspacePanelRatio);
  const resizeWorkspaceSidePanel = (width: number) => {
    if (!selectedSessionId) return;
    const bodyWidth = workspaceViewBodyRef.current?.clientWidth ?? 0;
    if (bodyWidth < 1) return;
    const ratio = Math.min(0.999, Math.max(0.1, width / bodyWidth));
    const next = { ...workspacePanelRatios, [selectedSessionId]: ratio };
    setWorkspacePanelRatios(next);
    try { window.localStorage.setItem(WORKSPACE_PANEL_RATIOS_KEY, JSON.stringify(next)); } catch { /* Keep the adjusted ratio for this session. */ }
  };
  useLayoutEffect(() => {
    if (!selectedSessionId || workspacePanelRatios[selectedSessionId] !== undefined) return;
    const bodyWidth = workspaceViewBodyRef.current?.clientWidth ?? 0;
    if (bodyWidth < 1) return;
    try {
      const legacyWidth = Number(window.localStorage.getItem(LEGACY_WORKSPACE_PANEL_WIDTH_KEY));
      if (!Number.isFinite(legacyWidth) || legacyWidth < 260) return;
      const migrated = Math.min(0.999, Math.max(0.1, legacyWidth / bodyWidth));
      const next = { ...workspacePanelRatios, [selectedSessionId]: migrated };
      setWorkspacePanelRatios(next);
      window.localStorage.setItem(WORKSPACE_PANEL_RATIOS_KEY, JSON.stringify(next));
      window.localStorage.removeItem(LEGACY_WORKSPACE_PANEL_WIDTH_KEY);
    } catch { /* Ignore unavailable local storage and keep the default ratio. */ }
  }, [selectedSessionId, workspacePanelRatios]);
  return { workspaceViewBodyRef, workspacePanelRatio, workspaceSidePanelWidth, resizeWorkspaceSidePanel };
}
