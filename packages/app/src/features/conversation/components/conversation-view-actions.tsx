import { Maximize2, PanelRightClose, PanelRightOpen, SquarePlus } from "lucide-react";
import type { MouseEvent } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../../locales/i18n.js";
import type { WorkspaceTabId, WorkspaceTabItem } from "../../../workspace-tabs/registry.js";

function HiddenTabIcon({ item }: { item: WorkspaceTabItem }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (item.faviconUrl && failedUrl !== item.faviconUrl) return <img className="workspace-tab-favicon" src={item.faviconUrl} alt="" onError={() => setFailedUrl(item.faviconUrl ?? null)} />;
  const Icon = item.icon;
  return <Icon size={15} />;
}

/** One toolbar owns the right edge in both conversation and split layouts. */
export function ConversationViewActions({ items, panelVisible, hiddenTabsOpen, onEnterFullView, onNewTab, onHidePanel, onRestoreTabs, onShowHiddenTabs, onShowTab, onShowTooltip, onHideTooltip }: {
  items: WorkspaceTabItem[];
  panelVisible: boolean;
  hiddenTabsOpen: boolean;
  onEnterFullView(): void;
  onNewTab(): void;
  onHidePanel(): void;
  onRestoreTabs(): void;
  onShowHiddenTabs(open: boolean): void;
  onShowTab(tab: WorkspaceTabId): void;
  onShowTooltip(event: MouseEvent<HTMLElement>, label: string, shortcut?: string, placement?: "above" | "below" | "right"): void;
  onHideTooltip(): void;
}) {
  useTranslation();
  const hasTabs = items.length > 0;
  const focusHiddenTabs = () => onShowHiddenTabs(true);
  return <div className="workspace-view-actions" role="group" aria-label={i18n.t("工作区标签页")}>
    <span className="conversation-tools-divider" aria-hidden="true" />
    {(hasTabs || panelVisible) && <button data-workspace-view-trigger aria-label={i18n.t("进入完整视图")} onMouseEnter={(event) => onShowTooltip(event, i18n.t("进入完整视图"), undefined, "above")} onMouseLeave={onHideTooltip} onClick={() => { onHideTooltip(); onEnterFullView(); }}><Maximize2 size={16} /></button>}
    {panelVisible ? <button aria-label={i18n.t("隐藏标签页")} onMouseEnter={(event) => onShowTooltip(event, i18n.t("隐藏标签页"), undefined, "above")} onMouseLeave={onHideTooltip} onClick={() => { onHideTooltip(); onHidePanel(); }}><PanelRightClose size={17} /></button> : hasTabs ? <div className="workspace-hidden-tabs" onMouseEnter={focusHiddenTabs} onMouseLeave={() => onShowHiddenTabs(false)} onFocus={focusHiddenTabs} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onShowHiddenTabs(false); }}>
      <button aria-label={i18n.t("显示隐藏的标签页")} aria-haspopup="menu" aria-expanded={hiddenTabsOpen} onMouseEnter={onHideTooltip} onClick={onRestoreTabs}>
        <PanelRightOpen size={17} /><span className="workspace-hidden-tabs-count">{items.length}</span>
      </button>
      {hiddenTabsOpen && <div className="workspace-hidden-tabs-menu" role="menu" aria-label={i18n.t("已打开的标签页")} onKeyDown={(event) => { if (event.key === "Escape") onShowHiddenTabs(false); }}>
        <div className="workspace-hidden-tabs-title">{i18n.t("已打开的标签页")}</div>
        {items.map(item => <button key={item.id} role="menuitem" onClick={() => onShowTab(item.id)}><span className="workspace-hidden-tabs-icon"><HiddenTabIcon item={item} /></span><span className="workspace-hidden-tabs-label">{item.title}</span></button>)}
      </div>}
    </div> : <button data-workspace-view-trigger aria-label={i18n.t("新建标签页")} onMouseEnter={(event) => onShowTooltip(event, i18n.t("新建标签页"))} onMouseLeave={onHideTooltip} onClick={() => { onHideTooltip(); onNewTab(); }}><SquarePlus size={16} /></button>}
  </div>;
}
