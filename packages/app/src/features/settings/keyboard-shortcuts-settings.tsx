import { Keyboard, Pencil, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import i18n from "../../locales/i18n.js";
import { bindingFromEvent, bindingIsAllowed, bindingParts, conflictingShortcut, effectiveShortcuts, shortcutDefinitions, shortcutLabel, type ShortcutDefinition, type ShortcutId, type ShortcutOverrides } from "./keyboard-shortcuts.js";

function Keycaps({ binding }: { binding: string }) {
  return <span className="shortcut-keycaps">{bindingParts(binding).map((part, index) => <kbd key={`${index}:${part}`}>{part}</kbd>)}</span>;
}

export function KeyboardShortcutsSettings({ overrides, onChange, saving, loaded, error, notice }: {
  overrides: ShortcutOverrides; onChange(overrides: ShortcutOverrides): void;
  saving: boolean; loaded: boolean; error: string | null; notice: string | null;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ShortcutDefinition | null>(null);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const bindings = effectiveShortcuts(overrides);
  const conflict = editing && candidate ? conflictingShortcut(overrides, editing.id, candidate) : null;
  const closeEditor = () => { setEditing(null); requestAnimationFrame(() => triggerRef.current?.focus()); };
  const update = (id: ShortcutId, binding: string | null) => {
    const next = { ...overrides };
    if (binding === null || binding === shortcutDefinitions.find((definition) => definition.id === id)?.binding) delete next[id]; else next[id] = binding;
    onChange(next);
  };
  const acceptBinding = () => {
    if (!editing || candidate === null || recordError || conflict) return;
    update(editing.id, candidate); closeEditor();
  };
  useEffect(() => {
    if (!editing) return;
    document.body.dataset.shortcutRecording = "true";
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === "Escape") { closeEditor(); return; }
      if (event.key === "Tab") {
        const buttons = [...dialogRef.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.findIndex((button) => button === document.activeElement);
        const next = index < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && !event.ctrlKey && !event.altKey && !event.metaKey && document.activeElement instanceof HTMLButtonElement) { document.activeElement.click(); return; }
      if (event.key === "Enter" && !event.ctrlKey && !event.altKey && !event.metaKey) { acceptBinding(); return; }
      if (event.repeat) return;
      if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.altKey && !event.metaKey) { setCandidate(""); setRecordError(null); return; }
      const binding = bindingFromEvent(event);
      if (!binding) return;
      if (!bindingIsAllowed(binding)) { setRecordError(i18n.t("请使用 Ctrl 或 Alt 组合键，或 F1–F24；保留系统和文本编辑按键。")); return; }
      setCandidate(binding); setRecordError(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => { window.removeEventListener("keydown", onKeyDown, true); delete document.body.dataset.shortcutRecording; };
  }, [editing, candidate, recordError, overrides]);

  const normalized = query.trim().toLocaleLowerCase();
  const rows = shortcutDefinitions.filter((definition) => !normalized || `${i18n.t(definition.label)} ${i18n.t(definition.description)} ${shortcutLabel(bindings[definition.id])}`.toLocaleLowerCase().includes(normalized));
  return <div className="archive-settings-content general-settings-content keyboard-settings-content">
    <div className="archive-page-heading"><div><h2>{i18n.t("键盘快捷键")}</h2><p className="general-settings-intro">{i18n.t("自定义常用操作的按键，修改后立即生效。")}</p></div></div>
    <div className="keyboard-settings-toolbar"><label className="shortcut-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={i18n.t("搜索命令或快捷键")} aria-label={i18n.t("搜索快捷键")} /><Keyboard size={16} /></label><button className="shortcut-reset-all" disabled={!loaded || saving || !Object.keys(overrides).length} onClick={() => onChange({})}><RotateCcw size={14} /><span>{i18n.t("全部恢复默认")}</span></button></div>
    <div className="shortcut-table-wrap"><table className="shortcut-table"><thead><tr><th>{i18n.t("命令")}</th><th>{i18n.t("按键绑定")}</th><th>{i18n.t("作用域")}</th><th className="shortcut-actions-heading">{i18n.t("操作")}</th></tr></thead><tbody>
      {rows.map((definition) => <tr key={definition.id}>
        <td><strong>{i18n.t(definition.label)}</strong><small>{i18n.t(definition.description)}</small></td>
        <td><button className="shortcut-binding-button" disabled={!loaded || saving} aria-label={i18n.t("修改 {{command}} 的快捷键", { command: i18n.t(definition.label) })} onClick={(event) => { triggerRef.current = event.currentTarget; setCandidate(null); setRecordError(null); setEditing(definition); }}>{bindings[definition.id] ? <Keycaps binding={bindings[definition.id]} /> : <span className="shortcut-unbound">{i18n.t("未绑定")}</span>}<Pencil size={13} /></button></td>
        <td className="shortcut-scope">{i18n.t(definition.scope === "app" ? "应用内" : "工作区")}</td>
        <td><div className="shortcut-row-actions"><button disabled={!loaded || saving || !bindings[definition.id]} title={i18n.t("清除绑定")} aria-label={i18n.t("清除 {{command}} 的快捷键", { command: i18n.t(definition.label) })} onClick={() => update(definition.id, "")}><Trash2 size={15} /></button><button disabled={!loaded || saving || overrides[definition.id] === undefined} title={i18n.t("恢复默认")} aria-label={i18n.t("恢复 {{command}} 的默认快捷键", { command: i18n.t(definition.label) })} onClick={() => { const conflict = conflictingShortcut(overrides, definition.id, definition.binding); if (conflict) { triggerRef.current = null; setCandidate(definition.binding); setRecordError(null); setEditing(definition); } else update(definition.id, null); }}><RotateCcw size={14} /></button></div></td>
      </tr>)}
      {!rows.length && <tr><td colSpan={4} className="shortcut-empty">{i18n.t("没有匹配的快捷键")}</td></tr>}
    </tbody></table></div>
    {error && <div className="general-settings-error" role="alert">{i18n.t(error)}</div>}
    <footer className="general-settings-footer"><span className="general-settings-saved" role="status">{saving ? i18n.t("正在保存…") : notice ? i18n.t(notice) : ""}</span></footer>
    {editing && <div className="shortcut-editor-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(); }}><section ref={dialogRef} className="shortcut-editor" role="dialog" aria-modal="true" aria-labelledby="shortcut-editor-title" aria-describedby="shortcut-editor-help" tabIndex={-1}>
      <header><div><h3 id="shortcut-editor-title">{i18n.t("修改快捷键")}</h3><p>{i18n.t(editing.label)}</p></div><button onClick={closeEditor} aria-label={i18n.t("关闭")}><X size={17} /></button></header>
      <div className="shortcut-record-pad" aria-live="polite"><Keyboard size={23} />{candidate === null ? <span>{i18n.t("按下新的组合键…")}</span> : candidate ? <Keycaps binding={candidate} /> : <span>{i18n.t("未绑定")}</span>}</div>
      <p id="shortcut-editor-help" className="shortcut-record-help">{i18n.t("按 Esc 取消，按 Enter 应用；Backspace 或 Delete 清除绑定。")}</p>
      <div className="shortcut-record-error" role="status">{recordError ?? (conflict ? i18n.t("此组合已用于“{{command}}”，请使用其他按键。", { command: i18n.t(conflict.label) }) : "")}</div>
      <footer><button className="general-secondary-button" onClick={closeEditor}>{i18n.t("取消")}</button><button className="general-save-button" disabled={candidate === null || Boolean(recordError || conflict)} onClick={acceptBinding}>{i18n.t("应用绑定")}</button></footer>
    </section></div>}
  </div>;
}
