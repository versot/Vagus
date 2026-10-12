import { Component, useLayoutEffect, useRef, type ReactNode } from "react";
import i18n from "../locales/i18n.js";
import { getWorkspaceTabDefinition, type WorkspaceTabContext, type WorkspaceTabId, type WorkspaceTabItem } from "./registry.js";
import type { WorkspaceViewsState } from "./use-workspace-views.js";
import { WorkspaceSideTabBar, WorkspaceTabPicker } from "./workspace-views.js";

class TabBoundary extends Component<{ children: ReactNode; resetKey: unknown }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.error("Workspace tab failed", error); }
  componentDidUpdate(previous: { resetKey: unknown }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? <div className="workspace-tab-error" role="alert"><span>{i18n.t("错误")}</span><button onClick={() => this.setState({ failed: false })}>{i18n.t("重试")}</button></div> : this.props.children;
  }
}

/** One stable panel tree serves split and full layouts, preserving feature state. */
export function WorkspaceTabHost({ state, items, context, onSelectTab, onCloseTab, onRenameTab, onUpdateTabTitle, onUpdateTabFavicon, onNewTab, onOpenTab, onClosePicker, onShowTooltip, onHideTooltip }: {
  state: WorkspaceViewsState; items: WorkspaceTabItem[]; context: WorkspaceTabContext;
  onSelectTab(id: WorkspaceTabId): void; onCloseTab(id: WorkspaceTabId): void; onRenameTab(id: WorkspaceTabId, name: string): void; onUpdateTabTitle(id: WorkspaceTabId, title: string): void; onUpdateTabFavicon(id: WorkspaceTabId, faviconUrl: string | null): void;
  onNewTab(): void; onOpenTab(type: string): void; onClosePicker(): void;
  onShowTooltip?(event: React.MouseEvent<HTMLElement>, label: string): void; onHideTooltip?(): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const expandedWidthRef = useRef(0);
  const hasPanel = state.tabs.length > 0 || state.sideTab === "picker";
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (state.fullView) {
      panel.style.removeProperty("--workspace-panel-content-width");
      return;
    }
    if (state.panelHidden) {
      // Keep the existing lock when a user reverses an unfinished transition.
      if (panel.style.getPropertyValue("--workspace-panel-content-width")) return;
      let width = expandedWidthRef.current;
      if (width < 1) {
        // A session may mount with its panel already hidden. Measure its expanded
        // layout before paint instead of restoring content at zero width.
        const transition = panel.style.transition;
        panel.style.transition = "none";
        panel.classList.remove("is-hidden");
        width = panel.clientWidth;
        panel.classList.add("is-hidden");
        void panel.offsetWidth;
        panel.style.transition = transition;
      }
      if (width > 0) panel.style.setProperty("--workspace-panel-content-width", `${width}px`);
      return;
    }
    const recordWidth = () => { if (panel.clientWidth > 0) expandedWidthRef.current = panel.clientWidth; };
    recordWidth();
    const observer = new ResizeObserver(recordWidth);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [hasPanel, state.panelHidden, state.fullView]);
  if (!hasPanel) return null;
  const hiddenInFullView = state.fullView && state.activeTab === "chat";
  const disabled = state.panelHidden || hiddenInFullView;
  const activeId = state.fullView ? state.activeTab : state.sideTab;
  const handlePanelTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || state.panelHidden || state.fullView) return;
    if (!["width", "flex-basis", "flex-grow"].includes(event.propertyName)) return;
    event.currentTarget.style.removeProperty("--workspace-panel-content-width");
    expandedWidthRef.current = event.currentTarget.clientWidth;
  };
  return <div ref={panelRef} className={`workspace-side-panel${state.panelHidden ? " is-hidden" : ""}${state.fullView ? " is-full-view" : ""}${state.sideTab === "picker" ? " is-picker" : ""}`} hidden={hiddenInFullView} aria-hidden={disabled} inert={disabled} onTransitionEnd={handlePanelTransitionEnd}>
    <div className="workspace-side-panel-content">
      {!state.fullView && state.sideTab && <WorkspaceSideTabBar sideTab={state.sideTab} items={items} hasPicker={state.sideTab === "picker"} onSelectTab={onSelectTab} onCloseTab={onCloseTab} onNewTab={onNewTab} />}
      {state.tabs.map(instance => {
        const definition = getWorkspaceTabDefinition(instance.type);
        const Page = definition.component;
        const title = items.find(item => item.id === instance.id)?.title ?? i18n.t(definition.titleKey);
        const active = activeId === instance.id;
        return <section key={instance.id} id={`workspace-${instance.id}-panel`} className={`workspace-tab-panel${definition.panelClassName ? ` ${definition.panelClassName}` : ""}${state.fullView ? " is-primary" : ""}`} hidden={!active} aria-hidden={!active || disabled} inert={!active || disabled} role="tabpanel" aria-labelledby={`workspace-${instance.id}-tab`} tabIndex={-1}>
          <TabBoundary resetKey={instance.payload}><Page instance={instance} context={context} visible={active && !disabled} title={title}
            {...(definition.renameable ? { onRename: (name: string) => onRenameTab(instance.id, name) } : {})}
            {...(definition.dynamicTitle ? { onUpdateTitle: (name: string) => onUpdateTabTitle(instance.id, name) } : {})}
            {...(definition.dynamicIcon ? { onUpdateFavicon: (faviconUrl: string | null) => onUpdateTabFavicon(instance.id, faviconUrl) } : {})}
            onShowTooltip={onShowTooltip} onHideTooltip={onHideTooltip} /></TabBoundary>
        </section>;
      })}
      {state.sideTab === "picker" && <WorkspaceTabPicker hidden={activeId !== "picker"} onOpen={onOpenTab} onClose={onClosePicker} />}
    </div>
  </div>;
}
