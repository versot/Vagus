import { MessageSquare, Minimize2, Plus, SquarePlus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { beginFrameCapture } from "../lib/performance.js";
import i18n from "../locales/i18n.js";
import { useWorkspaceTabDefinitions, type WorkspaceTabId, type WorkspaceTabItem } from "./registry.js";

type TooltipProps = {
  onShowTooltip(event: MouseEvent<HTMLElement>, label: string): void;
  onHideTooltip(): void;
};

function displayTabs(items: WorkspaceTabItem[], hasPicker: boolean): WorkspaceTabItem[] {
  return hasPicker ? [...items, { id: "picker", title: i18n.t("新建标签页"), icon: SquarePlus, closeLabel: i18n.t("关闭新建标签页") }] : items;
}

function WorkspaceTabIcon({ item, size = 15 }: { item: WorkspaceTabItem; size?: number }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (item.faviconUrl && failedUrl !== item.faviconUrl) return <img className="workspace-tab-favicon" src={item.faviconUrl} width={size} height={size} alt="" onError={() => setFailedUrl(item.faviconUrl ?? null)} />;
  const Icon = item.icon;
  return <Icon size={size} />;
}

function SideTab({ item, active, onSelect, onClose }: { item: WorkspaceTabItem; active: boolean; onSelect(): void; onClose(): void }) {
  return <div className={`workspace-tab-item${active ? " is-active" : ""}`}>
    <button className="workspace-tab" role="tab" id={`workspace-${item.id}-tab`} data-workspace-tab={item.id} aria-controls={`workspace-${item.id}-panel`} aria-selected={active} tabIndex={active ? 0 : -1} onClick={onSelect}>
      <WorkspaceTabIcon item={item} /><span>{item.title}</span>
    </button>
    <button className="workspace-tab-close" aria-label={item.closeLabel} onClick={onClose}><X size={13} /></button>
  </div>;
}

function navigateTabs(event: KeyboardEvent<HTMLDivElement>, onSelect: (id: WorkspaceTabId) => void) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || (event.target as HTMLElement).getAttribute("role") !== "tab") return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const index = tabs.findIndex(tab => tab === event.target);
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
  event.preventDefault(); event.stopPropagation();
  const tab = tabs[next];
  if (tab?.dataset.workspaceTab) { onSelect(tab.dataset.workspaceTab); tab.focus(); }
}

export function WorkspaceViewBar({ title, activeTab, items, hasPicker, onSelectTab, onCloseTab, onNewTab, onExitFullView, onShowTooltip, onHideTooltip }: TooltipProps & {
  title: string; activeTab: WorkspaceTabId; items: WorkspaceTabItem[]; hasPicker: boolean;
  onSelectTab(id: WorkspaceTabId): void; onCloseTab(id: WorkspaceTabId): void; onNewTab(): void; onExitFullView(): void;
}) {
  useTranslation();
  const tabs = displayTabs(items, hasPicker);
  return <header className="workspace-view-bar">
    <div className="workspace-tabs" role="tablist" aria-label={i18n.t("工作区标签页")} onKeyDown={event => navigateTabs(event, onSelectTab)}>
      <button className={`workspace-tab${activeTab === "chat" ? " is-active" : ""}`} role="tab" id="workspace-chat-tab" data-workspace-tab="chat" aria-controls="workspace-chat-panel" aria-selected={activeTab === "chat"} tabIndex={activeTab === "chat" ? 0 : -1} onClick={() => onSelectTab("chat")}><MessageSquare size={15} /><span>{title}</span></button>
      {tabs.map(item => <SideTab key={item.id} item={item} active={activeTab === item.id} onSelect={() => onSelectTab(item.id)} onClose={() => onCloseTab(item.id)} />)}
    </div>
    <div className="workspace-bar-actions">
      {!hasPicker && <button aria-label={i18n.t("新建标签页")} onMouseEnter={event => onShowTooltip(event, i18n.t("新建标签页"))} onMouseLeave={onHideTooltip} onClick={() => { onHideTooltip(); onNewTab(); }}><Plus size={17} /></button>}
      <span className="conversation-tools-divider" aria-hidden="true" />
      <button aria-label={i18n.t("退出完整视图")} onMouseEnter={event => onShowTooltip(event, i18n.t("退出完整视图"))} onMouseLeave={onHideTooltip} onClick={() => { onHideTooltip(); onExitFullView(); }}><Minimize2 size={16} /></button>
    </div>
  </header>;
}

export function WorkspaceSideTabBar({ sideTab, items, hasPicker, onSelectTab, onCloseTab, onNewTab }: { sideTab: WorkspaceTabId; items: WorkspaceTabItem[]; hasPicker: boolean; onSelectTab(id: WorkspaceTabId): void; onCloseTab(id: WorkspaceTabId): void; onNewTab(): void }) {
  useTranslation();
  const tabs = displayTabs(items, hasPicker);
  const tabListRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = tabListRef.current;
    if (!list) return;
    const revealActiveTab = () => {
      const tab = [...list.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(element => element.dataset.workspaceTab === sideTab);
      tab?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    };
    revealActiveTab();
    const observer = new ResizeObserver(revealActiveTab);
    observer.observe(list);
    return () => observer.disconnect();
  }, [sideTab, tabs.length]);
  return <header className="workspace-side-tabs">
    <div ref={tabListRef} className="workspace-tabs" role="tablist" aria-label={i18n.t("工作区标签页")} onKeyDown={event => navigateTabs(event, onSelectTab)} onWheel={event => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.currentTarget.scrollLeft += event.deltaY;
      event.preventDefault();
    }}>
      {tabs.map(item => <SideTab key={item.id} item={item} active={sideTab === item.id} onSelect={() => onSelectTab(item.id)} onClose={() => onCloseTab(item.id)} />)}
    </div>
    <div className="workspace-side-actions">{!hasPicker && <button className="workspace-side-tab-add" aria-label={i18n.t("新建标签页")} onClick={onNewTab}><Plus size={17} /></button>}</div>
  </header>;
}

export function WorkspacePanelResizer({ width, hidden = false, onResize, onEnterFullView, onExitFullView }: { width: number | null; hidden?: boolean; onResize(width: number): void; onEnterFullView(): void; onExitFullView(): void }) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number; latestWidth: number; centerZeroThreshold: number; fullViewPreview: boolean; stopFrameCapture: () => void } | null>(null);
  const applyWidth = (element: HTMLDivElement, next: number, duringDrag = false) => {
    const body = element.parentElement;
    if (!body) return width ?? 360;
    const maximum = duringDrag
      ? Math.max(260, body.clientWidth - 1)
      : Math.max(260, Math.min(body.clientWidth * .9, body.clientWidth - 280));
    const clamped = Math.round(Math.max(260, Math.min(maximum, next)));
    body.classList.add("has-custom-panel-width");
    body.style.setProperty("--workspace-panel-width", `${clamped}px`);
    element.setAttribute("aria-valuenow", String(clamped));
    return clamped;
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const panel = event.currentTarget.parentElement?.querySelector<HTMLDivElement>(".workspace-side-panel");
    if (!panel) return;
    event.preventDefault();
    const body = event.currentTarget.parentElement;
    if (!body) return;
    // The panel and resizer together may consume the whole center workspace,
    // but any remaining center width should stay in split view, however small.
    const centerZeroThreshold = Math.max(260, body.clientWidth - 1);
    const startWidth = panel.getBoundingClientRect().width;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, latestWidth: startWidth, centerZeroThreshold, fullViewPreview: false, stopFrameCapture: beginFrameCapture("workspace.panelDrag") };
    body.classList.add("is-resizing-workspace-panel");
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const body = event.currentTarget.parentElement;
    if (!body) return;
    const next = drag.startWidth - (event.clientX - drag.startX);
    const shouldPreviewFullView = next >= drag.centerZeroThreshold;
    if (shouldPreviewFullView && !drag.fullViewPreview) {
      drag.fullViewPreview = true;
      onEnterFullView();
    } else if (!shouldPreviewFullView && drag.fullViewPreview) {
      drag.fullViewPreview = false;
      onExitFullView();
      drag.latestWidth = applyWidth(event.currentTarget, next, true);
    } else if (!drag.fullViewPreview) {
      drag.latestWidth = applyWidth(event.currentTarget, next, true);
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = drag.startWidth - (event.clientX - drag.startX);
    const shouldEnterFullView = next >= drag.centerZeroThreshold;
    dragRef.current = null;
    drag.stopFrameCapture();
    event.currentTarget.parentElement?.classList.remove("is-resizing-workspace-panel");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (shouldEnterFullView) {
      if (!drag.fullViewPreview) onEnterFullView();
    } else {
      if (drag.fullViewPreview) onExitFullView();
      onResize(applyWidth(event.currentTarget, next));
    }
  };
  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    drag.stopFrameCapture();
    event.currentTarget.parentElement?.classList.remove("is-resizing-workspace-panel");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.fullViewPreview) onExitFullView();
    onResize(drag.latestWidth);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const panel = event.currentTarget.parentElement?.querySelector<HTMLDivElement>(".workspace-side-panel");
    const next = event.key === "Home" ? 260 : event.key === "End" ? Number.POSITIVE_INFINITY : (panel?.getBoundingClientRect().width ?? width ?? 360) + (event.key === "ArrowLeft" ? 24 : -24);
    if (panel) onResize(applyWidth(event.currentTarget, next));
  };
  return <div className={`workspace-panel-resizer${hidden ? " is-hidden" : ""}`} role="separator" aria-orientation="vertical" aria-label={i18n.t("调整右侧面板宽度")} aria-hidden={hidden} aria-valuemin={260} aria-valuemax={1000} aria-valuenow={width ?? 360} tabIndex={hidden ? -1 : 0} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onKeyDown={onKeyDown} />;
}

export function WorkspaceTabPicker({ onOpen, onClose, hidden = false }: { onOpen(type: string): void; onClose(): void; hidden?: boolean }) {
  useTranslation();
  const definitions = useWorkspaceTabDefinitions().filter(definition => definition.availableInPicker !== false);
  const choiceRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!hidden) choiceRef.current?.focus(); }, [hidden]);
  return <div id="workspace-picker-panel" className="workspace-tab-picker" hidden={hidden} aria-hidden={hidden} inert={hidden} role="tabpanel" aria-labelledby="workspace-picker-tab" tabIndex={-1} aria-label={i18n.t("新建标签页")} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="workspace-picker-body"><div className="workspace-picker-content">
      <h2>{i18n.t("打开标签页")}</h2>
      <p>{i18n.t("选择要在侧边面板中打开的标签。")}</p>
      {definitions.map((definition, index) => {
        const Icon = definition.icon;
        return <button key={definition.type} ref={index === 0 ? choiceRef : undefined} className="workspace-page-choice" onClick={() => onOpen(definition.type)}><span className="workspace-page-choice-icon" aria-hidden="true"><Icon size={15} strokeWidth={1.7} /></span><span className="workspace-page-choice-title"><strong>{i18n.t(definition.titleKey)}</strong></span></button>;
      })}
    </div></div>
  </div>;
}
