import type { HostClient, ProviderPluginCatalog, ProviderPluginInstallResult } from "@vagus/client";
import { AlertCircle, Boxes, CheckCircle2, Download, LoaderCircle, Plus, Power, RefreshCw, Search, Store, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "../../locales/i18n.js";

type ConfirmAction = { title: string; description: string; confirmLabel: string; destructive?: boolean; command?: string; run: () => Promise<void> };

export function ProviderPlugins({ client, providerId }: { client: HostClient; providerId: string }) {
  const providerName = providerId === "codex" ? "Codex" : "Claude Code";
  const [catalog, setCatalog] = useState<ProviderPluginCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [inventorySection, setInventorySection] = useState<"installed" | "available" | "marketplaces">("installed");
  const [visibleAvailableCount, setVisibleAvailableCount] = useState(50);
  const inventoryRef = useRef<HTMLDivElement>(null);
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true); setError(null);
    try {
      const next = await client.request("providers.plugins", { providerId });
      if (generation.current === request) setCatalog(next);
    } catch (reason) {
      if (generation.current === request) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, [client, providerId]);

  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
  useEffect(() => { inventoryRef.current?.scrollTo({ top: 0 }); }, [inventorySection]);

  const finishOperation = useCallback(async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key); setError(null); setNotice(null);
    try {
      await operation();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(null); }
  }, [busy, refresh]);

  const runInstall = useCallback(async (pluginId: string, acceptCommandSha256?: string) => {
    await finishOperation(`install:${pluginId}`, async () => {
      const result: ProviderPluginInstallResult = await client.request("providers.plugins.install", {
        providerId, pluginId, scope: "user", ...(acceptCommandSha256 ? { acceptCommandSha256 } : {}),
      }, 240_000);
      if (result.status === "confirmation-required") {
        if (!result.command || !result.commandSha256) throw new Error(i18n.t(providerId === "codex" ? "Codex 返回了不完整的命令确认信息，未执行安装。" : "Claude Code 返回了不完整的命令确认信息，未执行安装。"));
        setConfirmation({
          title: i18n.t(providerId === "codex" ? "Codex 插件要求运行本机命令" : "插件要求运行本机命令"),
          description: i18n.t("安装此插件需要执行 marketplace 声明的命令。请先检查命令内容；只有确认信任来源和命令时才继续。"),
          confirmLabel: i18n.t("确认并运行"),
          command: result.command,
          run: async () => { setConfirmation(null); await runInstall(pluginId, result.commandSha256); },
        });
        return;
      }
      setNotice(result.appsNeedingAuth?.length
        ? i18n.t("{{plugin}} 已安装。请在 {{provider}} 中授权这些应用：{{apps}}", { plugin: pluginId, provider: providerName, apps: result.appsNeedingAuth.join("、") })
        : i18n.t("{{plugin}} 已安装。新会话将加载该插件。", { plugin: pluginId }));
    });
  }, [client, finishOperation, providerId]);

  const runPluginAction = useCallback((pluginId: string, scope: string | undefined, action: "enable" | "disable" | "uninstall") => {
    if (scope !== "user") {
      setError(i18n.t("此处只管理用户范围的插件。项目范围插件请在对应项目的 Claude Code 中管理。"));
      return;
    }
    const execute = async () => finishOperation(`${action}:${pluginId}`, async () => {
      await client.request("providers.plugins.manage", { providerId, pluginId, action, scope: "user" }, 180_000);
      setNotice(i18n.t(action === "enable" ? "{{plugin}} 已启用。新会话将加载该插件。" : action === "disable" ? "{{plugin}} 已禁用。现有会话不会改变。" : "{{plugin}} 已卸载。", { plugin: pluginId }));
    });
    if (action === "uninstall") setConfirmation({
      title: i18n.t("卸载 {{provider}} 插件？", { provider: providerName }),
      description: i18n.t("这会从本机 {{provider}} 用户配置中卸载 {{plugin}}。", { provider: providerName, plugin: pluginId }),
      confirmLabel: i18n.t("卸载"), destructive: true,
      run: async () => { setConfirmation(null); await execute(); },
    });
    else void execute();
  }, [client, finishOperation, providerId]);

  const runMarketplaceAction = useCallback((action: "add" | "update" | "remove", values: { source?: string; name?: string }) => {
    const target = values.name ?? values.source ?? "";
    const execute = async () => finishOperation(`marketplace:${action}:${target}`, async () => {
      await client.request("providers.plugins.marketplace", { providerId, action, ...values, scope: "user" }, 240_000);
      if (action === "add") setMarketplaceSource("");
      setNotice(i18n.t(action === "add" ? "已添加 marketplace：{{name}}" : action === "update" ? "已更新 marketplace：{{name}}" : "已移除 marketplace：{{name}}", { name: target || i18n.t("全部市场") }));
    });
    if (action === "add") setConfirmation({
      title: i18n.t("添加 {{provider}} marketplace？", { provider: providerName }),
      description: i18n.t("{{provider}} 将读取此来源中的 marketplace 清单。只添加你信任的来源。", { provider: providerName }),
      confirmLabel: i18n.t("添加"),
      run: async () => { setConfirmation(null); await execute(); },
    });
    else if (action === "remove") setConfirmation({
      title: i18n.t("移除 marketplace？"),
      description: i18n.t("这会从本机 {{provider}} 用户配置中移除 marketplace {{name}}。", { provider: providerName, name: target }),
      confirmLabel: i18n.t("移除"), destructive: true,
      run: async () => { setConfirmation(null); await execute(); },
    });
    else void execute();
  }, [client, finishOperation, providerId]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const marketplaceUpdating = busy?.startsWith("marketplace:update:") ?? false;
  const installed = (catalog?.installed ?? []).filter(plugin => !normalizedQuery || `${plugin.id} ${plugin.version ?? ""} ${plugin.scope ?? ""}`.toLocaleLowerCase().includes(normalizedQuery));
  const available = (catalog?.available ?? []).filter(plugin => !normalizedQuery || `${plugin.name} ${plugin.description ?? ""} ${plugin.marketplace} ${plugin.id}`.toLocaleLowerCase().includes(normalizedQuery));
  const marketplaces = (catalog?.marketplaces ?? []).filter(item => !normalizedQuery || `${item.name} ${item.source ?? ""}`.toLocaleLowerCase().includes(normalizedQuery));

  return <section className="provider-plugin-panel" id="provider-plugins-panel" role="tabpanel" aria-labelledby="provider-plugins-tab">
    <div className="provider-plugin-marketplace-add">
      <label><span>{i18n.t("添加 marketplace")}</span><input value={marketplaceSource} onChange={event => setMarketplaceSource(event.target.value)} disabled={Boolean(busy)} placeholder={i18n.t("GitHub 仓库、URL 或本地路径")} aria-label={i18n.t("marketplace 来源")} autoComplete="off" spellCheck={false} /></label>
      <button disabled={Boolean(busy) || !marketplaceSource.trim()} onClick={() => runMarketplaceAction("add", { source: marketplaceSource.trim() })}><Plus size={14} />{i18n.t("添加")}</button>
    </div>
    <div className="provider-dialog-controls">
      <label className="provider-model-search"><Search size={15} /><input value={query} onChange={event => { setQuery(event.target.value); setVisibleAvailableCount(50); }} placeholder={i18n.t("搜索插件或市场")} aria-label={i18n.t("搜索插件或市场")} /></label>
    </div>
    {error && <div className="provider-model-error" role="alert"><AlertCircle size={15} /><span>{error}</span><button disabled={loading || Boolean(busy)} onClick={() => void refresh()}>{i18n.t("重试")}</button></div>}
    {notice && <div className="provider-package-install-result is-success" role="status"><CheckCircle2 size={14} /><span>{notice}</span></div>}
    <div className="provider-plugin-content" aria-busy={loading || Boolean(busy)} aria-live="polite">
      {!catalog && loading ? <div className="provider-plugin-empty"><LoaderCircle size={19} className="archive-toast-spinner" /><span>{i18n.t(providerId === "codex" ? "正在读取 Codex 插件目录…" : "正在读取 Claude Code 插件目录…")}</span></div> : <>
        <div className="provider-plugin-inventory-tabs" role="tablist" aria-label={i18n.t("插件列表")}>
          {([
            ["installed", "已安装", installed.length],
            ["available", "市场中的可用插件", available.length],
            ["marketplaces", "已配置的插件市场", marketplaces.length],
          ] as const).map(([section, label, count]) => <button type="button" role="tab" id={`provider-plugin-${section}-tab`} aria-controls={`provider-plugin-${section}-panel`} aria-selected={inventorySection === section} tabIndex={inventorySection === section ? 0 : -1} className={`provider-plugin-inventory-tab${inventorySection === section ? " is-active" : ""}`} key={section} onClick={() => setInventorySection(section)}><span>{i18n.t(label)}</span><small>{count}</small></button>)}
        </div>
        <div ref={inventoryRef} className="provider-plugin-inventory" role="tabpanel" id={`provider-plugin-${inventorySection}-panel`} aria-labelledby={`provider-plugin-${inventorySection}-tab`}>
          {inventorySection === "installed" && <section className="provider-plugin-section">
            <header><strong>{i18n.t("已安装")}</strong><button type="button" className="provider-plugin-section-action" disabled={loading || Boolean(busy)} title={i18n.t("重新读取本机插件与市场列表，不访问远程")} aria-label={i18n.t("重新读取")} onClick={() => void refresh()}>{loading ? <LoaderCircle size={14} className="is-spinning" /> : <RefreshCw size={14} />}<span>{i18n.t(loading ? "读取中…" : "重新读取")}</span></button></header>
            <div className="provider-plugin-list">
              {installed.length ? installed.map(plugin => <article className="provider-plugin-row" key={`${plugin.id}:${plugin.scope ?? ""}`}>
                <span className={`provider-plugin-state ${plugin.enabled ? "is-enabled" : "is-disabled"}`}><CheckCircle2 size={15} /></span>
                <div className="provider-plugin-copy"><strong title={plugin.id}>{plugin.id}</strong><span>{plugin.version ? `v${plugin.version}` : i18n.t("版本未知")}{plugin.scope ? ` · ${i18n.t("范围")} ${plugin.scope}` : ""}</span></div>
                <span className={`provider-plugin-badge ${plugin.enabled ? "is-enabled" : "is-disabled"}`}>{i18n.t(plugin.enabled ? "已启用" : "已禁用")}</span>
                {plugin.scope === "user" && (plugin.canToggle !== false || plugin.canUninstall !== false) && <div className="provider-plugin-actions">
                  {plugin.canToggle !== false && <button disabled={Boolean(busy)} title={i18n.t(plugin.enabled ? "禁用插件" : "启用插件")} aria-label={i18n.t(plugin.enabled ? "禁用插件" : "启用插件")} onClick={() => runPluginAction(plugin.id, plugin.scope, plugin.enabled ? "disable" : "enable")}><Power size={15} /></button>}
                  {plugin.canUninstall !== false && <button disabled={Boolean(busy)} title={i18n.t("卸载插件")} aria-label={i18n.t("卸载插件")} onClick={() => runPluginAction(plugin.id, plugin.scope, "uninstall")}><Trash2 size={15} /></button>}
                </div>}
              </article>) : <p className="provider-plugin-empty-inline">{i18n.t("没有匹配的已安装插件")}</p>}
            </div>
          </section>}
          {inventorySection === "available" && <section className="provider-plugin-section">
            <header><strong>{i18n.t("市场中的可用插件")}</strong><button type="button" className="provider-plugin-section-action" disabled={Boolean(busy)} title={i18n.t("从远程同步插件市场目录")} aria-label={i18n.t("同步市场")} onClick={() => runMarketplaceAction("update", {})}>{marketplaceUpdating ? <LoaderCircle size={14} className="is-spinning" /> : <RefreshCw size={14} />}<span>{i18n.t(marketplaceUpdating ? "正在同步…" : "同步市场")}</span></button></header>
            <div className="provider-plugin-list">
              {available.length ? available.slice(0, visibleAvailableCount).map(plugin => {
                const isInstalled = catalog?.installed.some(item => item.id === plugin.id) ?? false;
                return <article className="provider-plugin-row" key={plugin.id}>
                  <span className="provider-plugin-state is-available"><Boxes size={16} /></span>
                  <div className="provider-plugin-copy provider-plugin-available-copy"><strong title={plugin.name}>{plugin.name}</strong><span className="provider-plugin-description">{plugin.description || plugin.marketplace}</span><span className="provider-plugin-metadata"><span>{plugin.marketplace}</span><code title={plugin.id}>{plugin.id}</code></span></div>
                  {isInstalled ? <span className="provider-plugin-badge is-enabled">{i18n.t("已安装")}</span> : <button className="provider-plugin-install" disabled={Boolean(busy)} onClick={() => void runInstall(plugin.id)}>{busy === `install:${plugin.id}` ? <LoaderCircle size={14} className="is-spinning" /> : <Download size={14} />}{i18n.t("安装")}</button>}
                </article>;
              }) : <p className="provider-plugin-empty-inline">{i18n.t("当前没有可用插件，或搜索条件未匹配")}</p>}
            </div>
            {available.length > visibleAvailableCount && <button type="button" className="provider-plugin-more" onClick={() => setVisibleAvailableCount(count => Math.min(count + 50, available.length))}>{i18n.t("显示更多插件（{{shown}} / {{total}}）", { shown: Math.min(visibleAvailableCount, available.length), total: available.length })}</button>}
          </section>}
          {inventorySection === "marketplaces" && <section className="provider-plugin-section">
            <header><strong>{i18n.t("已配置的插件市场")}</strong></header>
            <div className="provider-plugin-list">
              {marketplaces.length ? marketplaces.map(marketplace => <article className="provider-plugin-market" key={marketplace.name}>
                <div className="provider-plugin-market-copy"><Store size={14} /><strong title={marketplace.name}>{marketplace.name}</strong><span title={marketplace.source}>{marketplace.source ?? i18n.t("本地目录")}</span></div>
                {marketplace.canManage !== false && <div className="provider-plugin-actions">{marketplace.canUpdate !== false && <button disabled={Boolean(busy)} title={i18n.t("更新 marketplace")} aria-label={i18n.t("更新 marketplace")} onClick={() => runMarketplaceAction("update", { name: marketplace.name })}>{busy === `marketplace:update:${marketplace.name}` ? <LoaderCircle size={14} className="is-spinning" /> : <RefreshCw size={14} />}</button>}<button disabled={Boolean(busy)} title={i18n.t("移除 marketplace")} aria-label={i18n.t("移除 marketplace")} onClick={() => runMarketplaceAction("remove", { name: marketplace.name })}><Trash2 size={14} /></button></div>}
              </article>) : <p className="provider-plugin-empty-inline">{i18n.t("尚未配置插件市场")}</p>}
            </div>
          </section>}
        </div>
      </>}
    </div>
    <footer className="provider-model-footer provider-plugin-footer">{catalog && <time dateTime={catalog.fetchedAt}>{new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, { hour: "2-digit", minute: "2-digit" }).format(new Date(catalog.fetchedAt))}</time>}</footer>
    {confirmation && <div className="overlay provider-plugin-confirm-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setConfirmation(null); }}><section className="provider-plugin-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="provider-plugin-confirm-title" aria-describedby="provider-plugin-confirm-description">
      <header><h2 id="provider-plugin-confirm-title">{confirmation.title}</h2><button disabled={Boolean(busy)} aria-label={i18n.t("关闭")} onClick={() => setConfirmation(null)}>×</button></header>
      <p id="provider-plugin-confirm-description">{confirmation.description}</p>
      {confirmation.command && <pre>{confirmation.command}</pre>}
      <footer><button className="cancel-button" disabled={Boolean(busy)} onClick={() => setConfirmation(null)}>{i18n.t("取消")}</button><button className={confirmation.destructive ? "archive-delete-confirm" : "provider-plugin-confirm-action"} disabled={Boolean(busy)} onClick={() => void confirmation.run()}>{busy ? <LoaderCircle size={14} className="is-spinning" /> : null}{confirmation.confirmLabel}</button></footer>
    </section></div>}
  </section>;
}
