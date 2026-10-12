import { useState } from "react";
import { getWorkspaceTabDefinition, useWorkspaceTabDefinitions, workspaceTabItems, type WorkspaceTabContext, type WorkspaceTabId, type WorkspaceTabInstance } from "./registry.js";

export interface WorkspaceViewsState {
  tabs: WorkspaceTabInstance[];
  sideTab: WorkspaceTabId | null;
  previousSideTab: WorkspaceTabId | null;
  panelHidden: boolean;
  fullView: boolean;
  activeTab: WorkspaceTabId;
}
const initialViews: WorkspaceViewsState = { tabs: [], sideTab: null, previousSideTab: null, panelHidden: false, fullView: false, activeTab: "chat" };

function fallbackTab(state: WorkspaceViewsState): WorkspaceTabId | null {
  if (state.tabs.some(tab => tab.id === state.previousSideTab)) return state.previousSideTab;
  return workspaceTabItems(state.tabs)[0]?.id ?? null;
}

/** The shell owns per-session instances and layout; feature modules own their payloads. */
export function useWorkspaceViews(sessionId: string | null) {
  const [sessions, setSessions] = useState<Record<string, WorkspaceViewsState>>({});
  useWorkspaceTabDefinitions();
  const state = sessionId ? sessions[sessionId] ?? initialViews : initialViews;
  const update = (transform: (current: WorkspaceViewsState) => WorkspaceViewsState) => {
    if (sessionId) setSessions(current => ({ ...current, [sessionId]: transform(current[sessionId] ?? initialViews) }));
  };
  const openTab = (type: string, context: WorkspaceTabContext, input?: unknown): WorkspaceTabId | null => {
    if (!sessionId || context.sessionId !== sessionId) return null;
    const definition = getWorkspaceTabDefinition(type);
    const payload = definition.createPayload(context, input);
    const id = definition.instancePolicy === "single" ? type : `${type}-${crypto.randomUUID()}`;
    update(current => {
      const existing = current.tabs.find(tab => tab.id === id);
      const instance = { id, type, metadata: existing?.metadata ?? {}, payload };
      let tabs = current.tabs;
      if (existing) {
        tabs = current.tabs.map(tab => tab.id === id ? instance : tab);
      } else {
        const anchorId = current.sideTab === "picker" ? current.previousSideTab : current.sideTab;
        const anchorIndex = anchorId ? current.tabs.findIndex(tab => tab.id === anchorId) : -1;
        tabs = [...current.tabs];
        tabs.splice(anchorId === "chat" ? 0 : anchorIndex < 0 ? tabs.length : anchorIndex + 1, 0, instance);
      }
      return {
        ...current,
        tabs,
        panelHidden: false, sideTab: id, previousSideTab: null,
        activeTab: current.fullView ? id : current.activeTab,
      };
    });
    return id;
  };
  const closePicker = () => update(current => {
    const next = fallbackTab(current);
    return { ...current, sideTab: next, previousSideTab: null, activeTab: current.activeTab === "picker" ? next ?? "chat" : current.activeTab };
  });
  return {
    state, items: workspaceTabItems(state.tabs),
    viewCount: 1 + state.tabs.length,
    openTab,
    openPicker: () => update(current => ({ ...current, panelHidden: false, previousSideTab: current.sideTab === "picker" ? current.previousSideTab : current.fullView ? current.activeTab : current.sideTab, sideTab: "picker", activeTab: current.fullView ? "picker" : current.activeTab })),
    closePicker,
    closeTab: (id: WorkspaceTabId) => {
      if (id === "picker") { closePicker(); return; }
      update(current => {
        if (!current.tabs.some(tab => tab.id === id)) return current;
        const tabs = current.tabs.filter(tab => tab.id !== id);
        if (!tabs.length && current.sideTab !== "picker") return initialViews;
        const next = { ...current, tabs, previousSideTab: current.previousSideTab === id ? null : current.previousSideTab };
        const fallback = fallbackTab(next);
        return {
          ...next, sideTab: current.sideTab === id ? fallback : current.sideTab,
          activeTab: current.activeTab === id ? fallback ?? "chat" : current.activeTab,
        };
      });
    },
    renameTab: (id: WorkspaceTabId, name: string) => update(current => {
      const tab = current.tabs.find(item => item.id === id);
      if (!tab || !getWorkspaceTabDefinition(tab.type).renameable) return current;
      const normalizedName = name.trim().slice(0, 40);
      return {
        ...current,
        tabs: current.tabs.map(item => item.id === id
          ? { ...item, metadata: { ...item.metadata, userTitle: normalizedName || undefined } }
          : item),
      };
    }),
    updateTabTitle: (id: WorkspaceTabId, title: string) => update(current => {
      const tab = current.tabs.find(item => item.id === id);
      if (!tab || !getWorkspaceTabDefinition(tab.type).dynamicTitle) return current;
      const normalizedTitle = title.trim().replace(/\s+/g, " ").slice(0, 80);
      if (!normalizedTitle || tab.metadata.title === normalizedTitle) return current;
      return {
        ...current,
        tabs: current.tabs.map(item => item.id === id
          ? { ...item, metadata: { ...item.metadata, title: normalizedTitle } }
          : item),
      };
    }),
    updateTabFavicon: (id: WorkspaceTabId, faviconUrl: string | null) => update(current => {
      const tab = current.tabs.find(item => item.id === id);
      if (!tab || !getWorkspaceTabDefinition(tab.type).dynamicIcon) return current;
      const normalizedUrl = faviconUrl?.trim().slice(0, 2048) || null;
      if ((tab.metadata.iconUrl ?? null) === normalizedUrl) return current;
      return {
        ...current,
        tabs: current.tabs.map(item => item.id === id
          ? { ...item, metadata: { ...item.metadata, iconUrl: normalizedUrl ?? undefined } }
          : item),
      };
    }),
    hideSidePanel: () => update(current => current.fullView || !current.sideTab ? current : { ...current, panelHidden: true }),
    showSidePanel: () => update(current => ({ ...current, panelHidden: false })),
    enterFullView: () => update(current => current.tabs.length || current.sideTab === "picker" ? { ...current, panelHidden: false, fullView: true, activeTab: current.sideTab ?? "chat" } : current),
    exitFullView: () => update(current => ({ ...current, fullView: false, activeTab: "chat" })),
    selectTab: (id: WorkspaceTabId) => update(current => {
      if (id !== "chat" && !(id === "picker" && current.sideTab === "picker") && !current.tabs.some(tab => tab.id === id)) return current;
      return { ...current, panelHidden: id === "chat" ? current.panelHidden : false, activeTab: id, sideTab: id === "chat" ? current.sideTab : id, previousSideTab: id === "chat" ? current.previousSideTab : null };
    }),
  };
}
