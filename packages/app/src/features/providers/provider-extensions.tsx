import { invoke } from "@tauri-apps/api/core";
import type { HostClient, ProviderExtensionCatalog } from "@vagus/client";
import { AlertCircle, ArrowUpRight, CheckCircle2, Download, Folder, LoaderCircle, Puzzle, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import i18n from "../../locales/i18n.js";

type InstallState = { status: "idle" | "installing" | "installed" | "error" | "unknown"; source: string; error?: string };
const idleInstall: InstallState = { status: "idle", source: "" };
// Keep an in-flight install visible when the user changes tabs or closes/reopens
// provider settings; closing the panel does not cancel a package operation.
const installs = new Map<string, InstallState>();
const installListeners = new Set<() => void>();
function publishInstall(providerId: string, state: InstallState) {
  installs.set(providerId, state);
  installListeners.forEach((listener) => listener());
}
async function install(client: HostClient, providerId: string, source: string) {
  if (installs.get(providerId)?.status === "installing") return;
  publishInstall(providerId, { status: "installing", source });
  try {
    const result = await client.request("providers.packages.install", { providerId, source }, 360_000);
    publishInstall(providerId, { status: "installed", source: result.source });
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : String(reason);
    publishInstall(providerId, { status: error === "Host 连接已断开" || error === "Host 请求超时" ? "unknown" : "error", source, error });
  }
}

export function ProviderExtensions({ client, providerId }: { client: HostClient; providerId: string }) {
  const [catalog, setCatalog] = useState<ProviderExtensionCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const installation = useSyncExternalStore(
    useCallback((listener: () => void) => { installListeners.add(listener); return () => { installListeners.delete(listener); }; }, []),
    useCallback(() => installs.get(providerId) ?? idleInstall, [providerId]),
  );
  const installing = installation.status === "installing";
  const [source, setSource] = useState(installation.status === "installing" || installation.status === "error" ? installation.source : "");
  const [marketError, setMarketError] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError(null);
    try {
      const next = await client.request("providers.extensions", { providerId });
      if (generation.current === request) setCatalog(next);
    } catch (reason) {
      if (generation.current === request) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, [client, providerId]);
  useEffect(() => {
    if (!installing) void refresh();
    return () => { generation.current++; };
  }, [refresh, installation]);
  useEffect(() => { if (installation.status === "installed") setSource(""); }, [installation]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const extensions = (catalog?.extensions ?? []).filter((extension) =>
    !normalizedQuery || [extension.name, extension.source, extension.description, ...extension.paths].join(" ").toLocaleLowerCase().includes(normalizedQuery));
  return <section className="provider-extension-panel" id="provider-extensions-panel" role="tabpanel" aria-labelledby="provider-extensions-tab">
    <div className="provider-package-install">
      <div className="provider-package-install-heading"><strong>{i18n.t("安装 Pi 包")}</strong><a href="https://pi.dev/packages" target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); setMarketError(false); void invoke("open_pi_package_market").catch(() => setMarketError(true)); }}>{i18n.t("Pi 包市场")}<ArrowUpRight size={13} /></a></div>
      <form className="provider-package-install-form" onSubmit={(event) => { event.preventDefault(); if (source.trim() && !installing) void install(client, providerId, source.trim()); }}>
        <input value={installing ? installation.source : source} onChange={(event) => setSource(event.target.value)} disabled={installing} placeholder="npm:@scope/package" aria-label={i18n.t("Pi 包来源")} autoComplete="off" spellCheck={false} />
        <button type="submit" className="provider-package-install-button" disabled={installing || !source.trim()}>{installing ? <LoaderCircle size={14} className="is-spinning" /> : <Download size={14} />}<span>{i18n.t(installing ? "正在安装…" : "安装")}</span></button>
      </form>
      <p className="provider-package-install-hint">{i18n.t("支持 npm 包名、Git 来源或本地绝对路径，安装到 Pi 全局配置。")}</p>
      {installation.status === "installed" && <div className="provider-package-install-result is-success" role="status"><CheckCircle2 size={14} /><span>{i18n.t("{{source}} 已安装。重新启动 Agent 会话后加载；仅含技能或主题的包不显示在扩展列表。", { source: installation.source })}</span></div>}
      {installation.status === "error" && <div className="provider-package-install-result is-error" role="alert"><AlertCircle size={14} /><span>{i18n.t("包安装失败")}<span className="provider-package-install-detail">{i18n.t(installation.error ?? "请检查包来源和网络后重试。")}</span></span></div>}
      {installation.status === "unknown" && <div className="provider-package-install-result" role="status"><AlertCircle size={14} /><span>{i18n.t("连接已中断或超时，安装结果暂未确认。请刷新扩展目录后检查。")}</span></div>}
      {marketError && <div className="provider-package-install-result is-error" role="alert"><AlertCircle size={14} /><span>{i18n.t("无法打开 Pi 包市场，请在浏览器访问 pi.dev/packages。")}</span></div>}
    </div>
    <div className="provider-dialog-controls">
      <label className="provider-model-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={i18n.t("搜索扩展名称、来源或路径")} aria-label={i18n.t("搜索扩展")} /></label>
      <button className="provider-refresh-button" disabled={loading || installing} onClick={() => void refresh()} aria-label={i18n.t("刷新扩展目录")}><RefreshCw size={14} className={loading ? "is-spinning" : ""} /><span>{i18n.t("刷新")}</span></button>
    </div>
    {error && <div className="provider-model-error" role="alert"><AlertCircle size={15} /><span>{i18n.t(error)}</span><button disabled={loading} onClick={() => void refresh()}>{i18n.t("重试")}</button></div>}
    <div className="provider-dialog-list-label"><span>{i18n.t("全局扩展")}</span><span>{catalog ? i18n.t("{{count}} 个扩展", { count: catalog.extensions.length }) : "—"}</span></div>
    <div className="provider-extension-list" aria-busy={loading} aria-live="polite">
      {!catalog && loading ? <div className="provider-extension-empty"><LoaderCircle size={20} className="archive-toast-spinner" /><strong>{i18n.t("正在读取已安装扩展…")}</strong></div>
        : extensions.length === 0 ? <div className="provider-extension-empty"><Puzzle size={27} /><strong>{i18n.t(normalizedQuery ? "没有匹配的扩展" : error ? "扩展目录暂时不可用" : "尚未发现全局扩展")}</strong><span>{i18n.t(normalizedQuery ? "尝试其他名称或路径。" : error ? "可以点击刷新重新读取。" : "输入包来源安装扩展，或前往 Pi 包市场浏览。")}</span></div>
          : extensions.map((extension) => <article className="provider-extension-card" key={extension.id}>
            <div className="provider-extension-heading">
              <span className="provider-extension-icon"><Puzzle size={17} /></span>
              <div className="provider-extension-name"><strong title={extension.name}>{extension.name}</strong><span>{extension.sourceType === "local" ? i18n.t("本地扩展") : extension.sourceType === "git" ? "Git" : "npm"}{extension.version && <span className="provider-extension-version">v{extension.version}</span>}</span></div>
              <span className={`provider-extension-state is-${extension.configuration}`}>{i18n.t(extension.configuration === "enabled" ? "配置已启用" : extension.configuration === "disabled" ? "配置已禁用" : "部分已启用")}</span>
            </div>
            {extension.description && <p className="provider-extension-description">{extension.description}</p>}
            <div className="provider-extension-source"><span>{i18n.t("来源")}</span><code title={extension.source}>{extension.source}</code></div>
            <div className="provider-extension-paths"><div><Folder size={13} /><span>{i18n.t("扩展文件")}</span><span className="provider-extension-path-count">{extension.paths.length}</span></div>{extension.paths.map((path) => <code key={path} title={path}>{path}</code>)}</div>
          </article>)}
    </div>
    {Boolean(catalog?.warnings.length) && <div className="provider-extension-warning"><AlertCircle size={14} /><span>{i18n.t("部分配置的包尚未安装或版本不匹配，已跳过。")}</span><details><summary>{i18n.t("详情")}</summary>{catalog!.warnings.map((warning) => <div key={warning}>{warning}</div>)}</details></div>}
    <footer className="provider-model-footer provider-extension-footer">{catalog && <time dateTime={catalog.fetchedAt}>{new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, { hour: "2-digit", minute: "2-digit" }).format(new Date(catalog.fetchedAt))}</time>}</footer>
  </section>;
}
