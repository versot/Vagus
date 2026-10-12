import type { BrowserElementReference } from "@vagus/protocol";
import { MousePointer2, X } from "lucide-react";
import i18n from "../../../locales/i18n.js";
import "./browser-element-chip.css";

export function BrowserElementChip({ elements, removable = false, onRemove }: { elements: BrowserElementReference[]; removable?: boolean; onRemove?(): void }) {
  if (!elements.length) return null;
  return <div className="browser-element-chip-wrap">
    <div className="browser-element-chip" tabIndex={0} aria-label={`${elements.length} ${i18n.t("网页元素")}`}>
      <MousePointer2 size={14} aria-hidden="true" />
      <span>{elements.length}{i18n.language.startsWith("zh") ? " 个" : " "}{i18n.t("网页元素")}</span>
      {removable && <button type="button" aria-label={i18n.t("移除网页元素")} onClick={(event) => { event.stopPropagation(); onRemove?.(); }}><X size={13} /></button>}
    </div>
    <div className="browser-element-popover" role="tooltip">
      {elements.map((element, index) => <div className="browser-element-popover-item" key={element.id}>
        <div className="browser-element-popover-title"><MousePointer2 size={13} aria-hidden="true" /><strong>{element.text || `<${element.tag}>` || `${i18n.t("网页元素")} ${index + 1}`}</strong></div>
        <div className="browser-element-popover-meta">{element.tag} · {element.selector}</div>
        {element.note && <div className="browser-element-popover-note">{element.note}</div>}
        <div className="browser-element-popover-url">{element.url}</div>
      </div>)}
    </div>
  </div>;
}
