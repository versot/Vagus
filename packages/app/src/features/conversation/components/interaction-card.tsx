import { invoke, isTauri } from "@tauri-apps/api/core";
import { Check, ChevronDown, CircleHelp, ExternalLink, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../../locales/i18n.js";
import type { ChatInteraction } from "../types.js";

export function InteractionCard({ item, busy, connected = true, onRespond }: { item: ChatInteraction; busy: boolean; connected?: boolean; onRespond(value: string | boolean | null): void }) {
  useTranslation();
  const { interaction } = item;
  const [value, setValue] = useState(interaction.kind === "text-editor" ? interaction.initialValue ?? "" : "");
  const [formValues, setFormValues] = useState<Record<string, string | number | boolean | string[]>>(() => interaction.kind === "form" ? Object.fromEntries(interaction.fields.flatMap((field) => field.defaultValue === undefined ? [] : [[field.id, field.defaultValue]])) : {});
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [openUrlError, setOpenUrlError] = useState<string | null>(null);
  const contentId = useId();
  const deadline = interaction.expiresAt ? Date.parse(interaction.expiresAt) : undefined;
  const expired = deadline !== undefined && now >= deadline;
  const pending = item.state === "pending";
  const disabled = busy || expired || !connected;
  useEffect(() => {
    if (!pending || deadline === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline, pending]);
  const title = interaction.kind === "url-consent" ? i18n.t("需要完成网页登录") : interaction.title ?? i18n.t(interaction.kind === "choice" ? "请选择" : interaction.kind === "confirm" ? "请确认" : "请填写");
  const responseLabel = i18n.t(item.reason === "timeout" ? "已超时" : item.reason === "interrupted" ? "已中断" : item.state === "cancelled" ? "已取消" : typeof item.response === "boolean" ? item.response ? "已确认" : "已拒绝" : "已回复");
  const options = interaction.kind === "choice" ? interaction.options.flatMap((option, index) => option.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? [{ option, index }] : []) : [];
  const submit = () => {
    if (disabled) return;
    if (interaction.kind === "choice" && selected !== null) onRespond(selected);
    else if ((interaction.kind === "text-input" || interaction.kind === "text-editor") && value.trim()) onRespond(value);
    else if (interaction.kind === "form" && isFormValid()) {
      const normalized = Object.fromEntries(Object.entries(formValues).filter(([, current]) => current !== "" && !(Array.isArray(current) && current.length === 0)));
      onRespond(JSON.stringify(normalized));
    }
  };
  const openAuthorizationUrl = async () => {
    if (disabled || interaction.kind !== "url-consent") return;
    setOpenUrlError(null);
    try {
      if (isTauri()) await invoke("open_external_url", { url: interaction.url });
      else {
        const opened = window.open("about:blank", "_blank");
        if (!opened) throw new Error("Popup blocked");
        opened.opener = null;
        opened.location.href = interaction.url;
      }
      onRespond(true);
    } catch {
      setOpenUrlError(i18n.t("无法打开授权页面，请稍后重试"));
    }
  };
  const isFormValid = () => interaction.kind === "form" && interaction.fields.every((field) => {
    const current = formValues[field.id];
    if (field.required && (current === undefined || current === "" || (Array.isArray(current) && !current.length))) return false;
    if (typeof current === "string" && field.minLength !== undefined && current.length < field.minLength) return false;
    if (typeof current === "string" && field.maxLength !== undefined && current.length > field.maxLength) return false;
    if (typeof current === "number" && field.minimum !== undefined && current < field.minimum) return false;
    if (typeof current === "number" && field.maximum !== undefined && current > field.maximum) return false;
    if (typeof current === "number" && field.integer && !Number.isInteger(current)) return false;
    if (typeof current === "string" && field.pattern !== undefined) { try { if (!new RegExp(field.pattern).test(current)) return false; } catch { return false; } }
    if (Array.isArray(current) && current.length > 0 && field.minItems !== undefined && current.length < field.minItems) return false;
    if (Array.isArray(current) && field.maxItems !== undefined && current.length > field.maxItems) return false;
    return true;
  });

  return <section className={`interaction-card${pending ? " is-pending" : " is-settled"}${expanded ? " is-expanded" : ""}`} aria-label={title}>
    {pending ? <header className="interaction-card-header"><CircleHelp size={14} aria-hidden="true" /><span>{i18n.t("等待你的回复")}</span>{deadline !== undefined && <small>{expired ? i18n.t("已超时") : i18n.t("{{count}} 秒", { count: Math.max(0, Math.ceil((deadline - now) / 1000)) })}</small>}<button className="interaction-card-cancel" title={i18n.t("取消请求")} aria-label={i18n.t("取消请求")} disabled={disabled} onClick={() => onRespond(null)}><X size={14} /></button></header> : <button className="interaction-settled-heading" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((open) => !open)}>{item.state === "cancelled" || item.response === false ? <X size={14} /> : <Check size={14} />}<strong>{title}</strong><span>{responseLabel}</span><ChevronDown size={13} /></button>}
    <div className="interaction-reveal" data-open={pending || expanded} aria-hidden={!pending && !expanded} inert={!pending && !expanded}><div className="interaction-clip"><div id={contentId} className="interaction-card-body">
      {pending && <h3>{title}</h3>}
      {interaction.message && <p className="interaction-card-message">{interaction.message}</p>}
      {pending && interaction.kind === "url-consent" && <div className="interaction-url-consent"><span>{i18n.t("授权服务")}</span><code>{interaction.host}</code><small>{i18n.t("只会打开系统浏览器；请确认这是你信任的服务。Vagus 不会读取或提交你的登录信息。")}</small>{!interaction.url && <p role="status">{i18n.t("请求已过期")}</p>}{openUrlError && <p role="alert">{openUrlError}</p>}</div>}
      {pending ? <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {interaction.kind === "choice" && <>
          {interaction.options.length > 6 && <label className="interaction-search"><Search size={13} /><input aria-label={i18n.t("搜索选项")} placeholder={i18n.t("搜索选项…")} value={query} onChange={(event) => setQuery(event.target.value)} disabled={disabled} /></label>}
          <div className="interaction-card-options" role="radiogroup" aria-label={title}>{options.map(({ option, index }) => <label className={`interaction-choice${selected === option ? " is-selected" : ""}`} key={`${option}-${index}`}><input type="radio" name={contentId} value={option} checked={selected === option} disabled={disabled} onChange={() => setSelected(option)} /><span><strong>{option}</strong>{interaction.optionHints?.[index] && <small>{i18n.t(interaction.optionHints[index]!)}</small>}</span></label>)}{options.length === 0 && <p className="interaction-empty">{i18n.t("没有匹配的选项")}</p>}</div>
        </>}
        {interaction.kind === "text-input" && <input className="interaction-text-field" aria-label={title} value={value} onChange={(event) => setValue(event.target.value)} placeholder={interaction.placeholder ?? i18n.t("输入内容…")} disabled={disabled} />}
        {interaction.kind === "text-editor" && <textarea className="interaction-text-field" aria-label={title} value={value} onChange={(event) => setValue(event.target.value)} placeholder={i18n.t("输入内容…")} rows={Math.min(9, Math.max(4, value.split("\n").length))} disabled={disabled} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submit(); } }} />}
        {interaction.kind === "form" && <div className="interaction-form-fields">{interaction.fields.map((field) => {
          const current = formValues[field.id];
          const update = (next: string | number | boolean | string[]) => setFormValues((values) => ({ ...values, [field.id]: next }));
          return <div className="interaction-form-field" key={field.id}><span className="interaction-form-label">{field.label}{field.required && <i aria-label={i18n.t("必填")}> *</i>}</span>{field.description && <small>{field.description}</small>}{field.type === "boolean" ? <select className="interaction-text-field" value={typeof current === "boolean" ? String(current) : ""} disabled={disabled} onChange={(event) => update(event.currentTarget.value === "" ? "" : event.currentTarget.value === "true")}><option value="">{i18n.t("请选择")}</option><option value="true">{i18n.t("是")}</option><option value="false">{i18n.t("否")}</option></select> : field.type === "choice" ? <><div className="interaction-form-options" role="radiogroup" aria-label={field.label}>{field.options?.map((option) => <label className={`interaction-choice${current === option.value ? " is-selected" : ""}`} key={option.value}><input type="radio" name={`${contentId}-${field.id}`} checked={current === option.value} disabled={disabled} onChange={() => update(option.value)} /><span className="interaction-form-option-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}{option.preview && <details className="interaction-option-preview" onClick={(event) => event.stopPropagation()}><summary>{i18n.t("代码预览")}</summary><pre>{option.preview}</pre></details>}</span></label>)}</div>{!field.required && typeof current === "string" && <button type="button" className="interaction-secondary-action interaction-form-clear" disabled={disabled} onClick={() => setFormValues((values) => { const next = { ...values }; delete next[field.id]; return next; })}>{i18n.t("取消选择")}</button>}</> : field.type === "multi-choice" ? <div className="interaction-form-options">{field.options?.map((option) => { const selectedValues = Array.isArray(current) ? current : []; return <label className={`interaction-choice${selectedValues.includes(option.value) ? " is-selected" : ""}`} key={option.value}><input type="checkbox" checked={selectedValues.includes(option.value)} disabled={disabled} onChange={(event) => { const next = event.currentTarget.checked ? [...selectedValues, option.value] : selectedValues.filter((item) => item !== option.value); if (field.maxItems !== undefined && next.length > field.maxItems) return; update(next); }} /><span className="interaction-form-option-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}{option.preview && <details className="interaction-option-preview" onClick={(event) => event.stopPropagation()}><summary>{i18n.t("代码预览")}</summary><pre>{option.preview}</pre></details>}</span></label>; })}</div> : <input className="interaction-text-field" type={field.type === "number" ? "number" : field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : field.format === "date-time" ? "datetime-local" : "text"} value={typeof current === "string" || typeof current === "number" ? current : ""} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} disabled={disabled} onChange={(event) => update(field.type === "number" ? (event.currentTarget.value === "" ? "" : Number(event.currentTarget.value)) : event.currentTarget.value)} />}</div>;
        })}</div>}
        <footer className="interaction-card-actions"><small>{!connected ? i18n.t("连接已断开") : busy ? i18n.t("正在提交…") : expired ? i18n.t("请求已过期") : interaction.kind === "text-editor" ? i18n.t("Ctrl + Enter 提交") : ""}</small><button type="button" className="interaction-secondary-action" disabled={disabled} onClick={() => onRespond(interaction.kind === "confirm" ? false : null)}>{interaction.kind === "confirm" ? i18n.t("拒绝") : i18n.t("取消")}</button>{interaction.kind === "confirm" ? <button type="button" className="interaction-primary-action" disabled={disabled} onClick={() => onRespond(true)}>{busy ? <LoaderCircle className="interaction-spinner" size={13} /> : <Check size={13} />}{i18n.t("确认")}</button> : interaction.kind === "url-consent" ? <button type="button" className="interaction-primary-action" disabled={disabled || !interaction.url} onClick={() => void openAuthorizationUrl()}><ExternalLink size={13} />{i18n.t("打开授权页面")}</button> : <button type="submit" className="interaction-primary-action" disabled={disabled || (interaction.kind === "choice" ? selected === null : interaction.kind === "form" ? !isFormValid() : !value.trim())}>{busy && <LoaderCircle className="interaction-spinner" size={13} />}{interaction.kind === "choice" ? i18n.t("确认") : i18n.t("提交")}</button>}</footer>
      </form> : <p className="interaction-card-response">{interaction.kind === "form" && item.response ? i18n.t("已回复") : typeof item.response === "string" ? item.response : responseLabel}</p>}
    </div></div></div>
  </section>;
}
