import type { HostClient, ProviderMcpCatalog, ProviderMcpServer } from "@vagus/client";
import { AlertCircle, ChevronDown, CircleCheck, CircleHelp, LoaderCircle, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import i18n from "../../locales/i18n.js";

const statusKey: Record<ProviderMcpCatalog["servers"][number]["status"], string> = {
  connected: "已连接", disconnected: "未连接", pending: "待批准", "needs-authentication": "需要认证", disabled: "已禁用", rejected: "已拒绝", cached: "使用缓存", "not-configured": "尚未配置", error: "连接错误", unknown: "状态未知",
};
const transportKey: Record<ProviderMcpCatalog["servers"][number]["transport"], string> = {
  stdio: "stdio", http: "HTTP", sse: "SSE", websocket: "WebSocket", unknown: "传输方式未知",
};

export function ProviderMcpServers({ client, providerId }: { client: HostClient; providerId: string }) {
  const [catalog, setCatalog] = useState<ProviderMcpCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ProviderMcpServer>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await client.request("providers.mcp", { providerId });
      if (generation.current === request) setCatalog(next);
    } catch (reason) {
      if (generation.current === request) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, [client, providerId]);
  const showDetails = async (serverName: string) => {
    if (expanded === serverName) { setExpanded(null); return; }
    setExpanded(serverName);
    if (details[serverName]) return;
    setBusyName(serverName);
    setError(null);
    try {
      const detail = await client.request("providers.mcp.detail", { providerId, serverName });
      setDetails(current => ({ ...current, [serverName]: detail }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setExpanded(null);
    } finally { setBusyName(null); }
  };
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);

  return <section className="provider-plugin-panel provider-mcp-panel" id="provider-mcp-panel" role="tabpanel" aria-labelledby="provider-mcp-tab">
    <div className="provider-dialog-controls">
      <div className="provider-mcp-heading"><Server size={16} /><strong>{i18n.t("MCP 服务")}</strong>{catalog && <span>{catalog.servers.length}</span>}</div>
      <button className="provider-refresh-button" disabled={loading} onClick={() => void refresh()} aria-label={i18n.t("刷新 MCP 清单")}><RefreshCw size={14} className={loading ? "is-spinning" : ""} /><span>{i18n.t("刷新")}</span></button>
    </div>
    {error && <div className="provider-model-error" role="alert"><AlertCircle size={15} /><span>{error}</span><button disabled={loading} onClick={() => void refresh()}>{i18n.t("重试")}</button></div>}
    <div className="provider-plugin-inventory provider-mcp-inventory" aria-busy={loading} aria-live="polite">
      {!catalog && loading ? <div className="provider-plugin-empty"><LoaderCircle size={19} className="archive-toast-spinner" /><span>{i18n.t("正在读取 MCP 服务清单…")}</span></div>
        : catalog?.servers.length ? <section className="provider-plugin-section">
          <header><strong>{i18n.t("本机 Claude Code 配置")}</strong><span>{catalog.servers.length}</span></header>
          {catalog.servers.map(server => <article className="provider-mcp-item" key={server.name}>
            <div className="provider-plugin-row">
              <span className={`provider-plugin-state ${server.status === "connected" ? "is-enabled" : "is-available"}`}>{server.status === "connected" ? <CircleCheck size={15} /> : <CircleHelp size={15} />}</span>
              <div className="provider-plugin-copy"><strong title={server.name}>{server.name}</strong><span>{i18n.t(transportKey[server.transport])}</span></div>
              <span className={`provider-plugin-badge ${server.status === "connected" ? "is-enabled" : ""}`}>{i18n.t(statusKey[server.status])}</span>
              <button type="button" className="provider-mcp-detail-button" aria-expanded={expanded === server.name} aria-label={i18n.t("MCP 服务详情")} onClick={() => void showDetails(server.name)}>{busyName === server.name ? <LoaderCircle size={14} className="is-spinning" /> : <ChevronDown size={15} className={expanded === server.name ? "is-open" : ""} />}</button>
            </div>
            {expanded === server.name && <div className="provider-mcp-detail">
              {details[server.name] ? <><span>{i18n.t("配置范围")}</span><strong>{i18n.t(details[server.name]!.scope === "unknown" ? "范围未知" : details[server.name]!.scope === "managed" ? "受管理" : details[server.name]!.scope === "user" ? "用户" : details[server.name]!.scope === "project" ? "项目" : "本机项目")}</strong>
              </> : <span>{i18n.t("正在读取安全详情…")}</span>}
            </div>}
          </article>)}
        </section> : <div className="provider-plugin-empty"><Server size={20} /><span>{error ? i18n.t("无法读取 MCP 服务清单") : i18n.t("尚未配置 MCP 服务")}</span></div>}
    </div>
    <footer className="provider-model-footer provider-plugin-footer">{catalog && <time dateTime={catalog.fetchedAt}>{new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, { hour: "2-digit", minute: "2-digit" }).format(new Date(catalog.fetchedAt))}</time>}</footer>
  </section>;
}
