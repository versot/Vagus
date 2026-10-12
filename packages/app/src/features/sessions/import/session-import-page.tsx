import type { ProviderImportCandidate, ProviderInfo, WorkspaceSession } from "@vagus/client";
import { AlertCircle, ArrowLeft, Check, CheckCircle2, Clock3, Folder, Import, LoaderCircle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ClaudeIcon } from "../../../components/icons/claude-icon.js";
import { CodexIcon } from "../../../components/icons/codex-icon.js";
import { OpenCodeIcon } from "../../../components/icons/opencode-icon.js";
import { PiIcon } from "../../../components/icons/pi-icon.js";
import { QoderIcon } from "../../../components/icons/qoder-icon.js";
import { ZCodeIcon } from "../../../components/icons/zcode-icon.js";
import i18n from "../../../locales/i18n.js";
import "./session-import-page.css";

interface SessionImportPageProps {
  providers: ProviderInfo[];
  onClose(): void;
  onScan(providerId: string): Promise<ProviderImportCandidate[]>;
  onImport(providerId: string, sourceId: string): Promise<WorkspaceSession>;
  onImported(sessions: WorkspaceSession[], complete: boolean): Promise<void>;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function SessionImportPage({ providers, onClose, onScan, onImport, onImported }: SessionImportPageProps) {
  const importProviders = providers.filter((provider) => provider.capabilities.some((capability) => capability.id === "session.import" && capability.status === "implemented"));
  const [providerId, setProviderId] = useState(importProviders[0]?.id ?? "");
  const [candidates, setCandidates] = useState<ProviderImportCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    setLoading(true); setError(""); setResult(""); setCandidates([]); setSelected(new Set());
    void onScan(providerId).then((items) => {
      if (!cancelled) setCandidates(items);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [providerId, onScan]);

  const visibleCandidates = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return candidates.filter((candidate) => !candidate.alreadyImported && (!query || `${candidate.title}\n${candidate.workingDirectory}\n${candidate.preview}`.toLocaleLowerCase().includes(query)));
  }, [candidates, filter]);
  const selectableCandidates = visibleCandidates;
  const selectedCount = [...selected].filter((id) => candidates.some((candidate) => candidate.sourceId === id && !candidate.alreadyImported)).length;

  const toggleSelected = (candidate: ProviderImportCandidate) => {
    if (candidate.alreadyImported || importing) return;
    setSelected((current) => { const next = new Set(current); if (next.has(candidate.sourceId)) next.delete(candidate.sourceId); else next.add(candidate.sourceId); return next; });
  };

  const importSelected = async () => {
    const toImport = candidates.filter((candidate) => selected.has(candidate.sourceId) && !candidate.alreadyImported);
    if (!toImport.length || importing) return;
    setImporting(true); setError(""); setResult("");
    const imported: WorkspaceSession[] = [];
    const importedSourceIds = new Set<string>();
    const failures: { sourceId: string; message: string }[] = [];
    for (const candidate of toImport) {
      try { imported.push(await onImport(providerId, candidate.sourceId)); importedSourceIds.add(candidate.sourceId); }
      catch (reason) { failures.push({ sourceId: candidate.sourceId, message: `${candidate.title}: ${reason instanceof Error ? reason.message : String(reason)}` }); }
    }
    if (imported.length) {
      setCandidates((current) => current.map((candidate) => importedSourceIds.has(candidate.sourceId) ? { ...candidate, alreadyImported: true } : candidate));
      setSelected((current) => { const next = new Set(current); for (const id of importedSourceIds) next.delete(id); return next; });
      await onImported(imported, failures.length === 0);
      setResult(i18n.t("已导入 {{count}} 个会话", { count: imported.length }));
      if (!failures.length) onClose();
    }
    if (failures.length) {
      setError(failures.map((failure) => failure.message).join("\n"));
      try {
        const refreshed = await onScan(providerId);
        const importedSourceIds = new Set(refreshed.filter((candidate) => candidate.alreadyImported).map((candidate) => candidate.sourceId));
        setCandidates(refreshed);
        setSelected((current) => new Set([...current].filter((sourceId) => !importedSourceIds.has(sourceId))));
        const remainingFailures = failures.filter((failure) => !importedSourceIds.has(failure.sourceId));
        setError(remainingFailures.map((failure) => failure.message).join("\n"));
      } catch { /* Preserve the current list and its detailed import error if rescanning is unavailable. */ }
    }
    setImporting(false);
  };

  const toggleAllVisible = () => {
    if (!selectableCandidates.length || importing) return;
    const allSelected = selectableCandidates.every((candidate) => selected.has(candidate.sourceId));
    setSelected((current) => {
      const next = new Set(current);
      for (const candidate of selectableCandidates) allSelected ? next.delete(candidate.sourceId) : next.add(candidate.sourceId);
      return next;
    });
  };

  return <section className="session-import-page" aria-labelledby="session-import-title">
    <header className="session-import-page-header">
      <button className="session-import-back" type="button" onClick={onClose} aria-label={i18n.t("返回聊天")}><ArrowLeft size={17} /><span>{i18n.t("返回")}</span></button>
      <div><h1 id="session-import-title">{i18n.t("导入会话")}</h1><p>{i18n.t("选择 Agent 来源，再导入已有会话。会话会按工作目录放入对应项目。")}</p></div>
    </header>

    <div className="session-import-source-row">
      <span>{i18n.t("来源 Agent")}</span>
      <div className="session-import-provider-list" role="tablist" aria-label={i18n.t("来源 Agent")}>
        {importProviders.map((provider) => <button type="button" role="tab" aria-selected={provider.id === providerId} className={provider.id === providerId ? "is-selected" : ""} key={provider.id} onClick={() => setProviderId(provider.id)}>{provider.id === "pi" ? <PiIcon size={17} /> : provider.id === "claude" ? <ClaudeIcon size={17} /> : provider.id === "codex" ? <CodexIcon size={17} /> : provider.id === "opencode" ? <OpenCodeIcon size={17} /> : provider.id === "qoder" ? <QoderIcon size={17} /> : provider.id === "zcode" ? <ZCodeIcon size={17} /> : <span className="provider-mark">AI</span>}<span>{provider.displayName}</span></button>)}
      </div>
    </div>

    <div className="session-import-toolbar">
      <label className="session-import-search"><Search size={16} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={i18n.t("搜索会话或工作目录")} /></label>
      <span>{loading ? i18n.t("正在扫描…") : i18n.t("{{count}} 个会话", { count: visibleCandidates.length })}</span>
    </div>

    {(error || result) && <div className={`session-import-feedback${error ? " is-error" : " is-success"}`} role={error ? "alert" : "status"}>{error ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}<span>{error || result}</span></div>}
    <div className="session-import-list" aria-label={i18n.t("本机 Agent 会话列表")} aria-busy={loading}>
      {loading ? <div className="session-import-empty"><LoaderCircle size={20} className="is-spinning" />{i18n.t("正在读取本机 Agent 会话")}</div>
        : visibleCandidates.length === 0 ? <div className="session-import-empty"><Folder size={21} />{candidates.some((candidate) => !candidate.alreadyImported) ? i18n.t("没有匹配的会话") : i18n.t("没有找到可导入的会话")}</div>
          : visibleCandidates.map((candidate) => {
            const checked = selected.has(candidate.sourceId);
            return <button type="button" key={candidate.sourceId} className={`session-import-candidate${checked ? " is-selected" : ""}`} aria-pressed={checked} disabled={importing} onClick={() => toggleSelected(candidate)}>
              <span className="session-import-checkbox" aria-hidden="true">{checked && <Check size={14} />}</span>
              <span className="session-import-candidate-copy"><strong title={candidate.title}>{candidate.title}</strong><small title={candidate.workingDirectory}><Folder size={13} />{candidate.workingDirectory}{candidate.additionalDirectories?.length ? ` · ${i18n.t("另有 {{count}} 个工作目录", { count: candidate.additionalDirectories.length })}` : ""}</small><span className="session-import-candidate-meta"><span><Clock3 size={12} />{dateLabel(candidate.updatedAt)}</span>{candidate.messageCount !== undefined && <span>{i18n.t("{{count}} 条消息", { count: candidate.messageCount })}</span>}</span></span>
            </button>;
          })}
    </div>

    <footer className="session-import-page-footer"><button type="button" className="session-import-select-all" disabled={!selectableCandidates.length || importing} onClick={toggleAllVisible}>{selectableCandidates.length && selectableCandidates.every((candidate) => selected.has(candidate.sourceId)) ? i18n.t("取消全选") : i18n.t("全选当前结果")}</button><span className="session-import-selection-count">{i18n.t("已选择 {{selected}} 个", { selected: selectedCount })}</span><button type="button" className="cancel-button" disabled={importing} onClick={onClose}>{i18n.t("取消")}</button><button type="button" className="primary-button" disabled={!selectedCount || importing || loading} onClick={() => void importSelected()}>{importing ? <><LoaderCircle size={15} className="is-spinning" />{i18n.t("正在导入…")}</> : <><Import size={16} />{i18n.t("导入所选会话", { count: selectedCount })}</>}</button></footer>
  </section>;
}
