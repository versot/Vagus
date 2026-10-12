import { type WorkspaceSession } from "@vagus/client";
import { type AgentRuntimeSettings, type AgentUsage } from "@vagus/protocol";
import { useEffect, useRef, useState } from "react";
import { host } from "../../../lib/workspace-host.js";
import i18n from "../../../locales/i18n.js";

export function formatUsageTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}m`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  return String(Math.round(value));
}

export function SessionUsageControl({
  session,
  onUsage,
  contextSupported,
  sessionBusy,
  onSettings,
  onError,
}: {
  session: WorkspaceSession;
  onUsage: (usage: AgentUsage) => void;
  contextSupported: boolean;
  sessionBusy: boolean;
  onSettings: (settings: AgentRuntimeSettings) => void;
  onError: (message: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [loading, setLoading] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const usageRequestRef = useRef(false);
  const usage = session.usage;
  const isOpen = hovered;
  const contextUsed = usage?.contextWindowUsedTokens;
  const contextMax = usage?.contextWindowMaxTokens;
  const contextPercent = contextUsed !== undefined && contextMax ? Math.round(contextUsed / contextMax * 100) : null;
  const hasUsage = Boolean(usage && Object.keys(usage).length);

  const refreshUsage = async () => {
    if (usageRequestRef.current) return;
    usageRequestRef.current = true;
    setLoading(true);
    try {
      const next = await host.request("sessions.get-usage", { sessionId: session.id });
      if (next) onUsage(next);
    } catch {
      // Usage details are optional and should not interrupt chatting.
    } finally { usageRequestRef.current = false; setLoading(false); }
  };
  const openUsage = () => {
    setHovered(true);
    if (!hasUsage) void refreshUsage();
  };
  const compactContext = async () => {
    if (compacting || sessionBusy) return;
    setCompacting(true);
    try {
      // A compaction may legitimately take longer than the generic 30 second
      // RPC timeout. Let the Host response (or socket disconnect) settle it.
      const result = await host.request("sessions.compact", { sessionId: session.id }, 0);
      if (result.usage) onUsage(result.usage);
    } catch (reason) { onError(reason instanceof Error ? reason.message : i18n.t("压缩上下文失败")); }
    finally { setCompacting(false); }
  };
  const setAutoCompaction = async (enabled: boolean) => {
    try {
      const settings = await host.request("sessions.set-auto-compaction", { sessionId: session.id, enabled });
      onSettings(settings);
    } catch (reason) { onError(reason instanceof Error ? reason.message : i18n.t("更新自动压缩设置失败")); }
  };

  useEffect(() => {
    setHovered(false);
  }, [session.id]);
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setHovered(false); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  return <div className="session-usage-control" ref={rootRef} onMouseEnter={openUsage} onMouseLeave={() => setHovered(false)}>
    <button className="session-usage-button" aria-label={i18n.t("查看上下文与会话费用")} aria-haspopup="dialog" aria-expanded={isOpen} onFocus={openUsage}>
      <svg className={`session-usage-ring${loading ? " is-refreshing" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
        <circle className="session-usage-ring-track" cx="8" cy="8" r="6" />
        {contextPercent !== null && <circle className="session-usage-ring-value" cx="8" cy="8" r="6" pathLength="100" style={{ strokeDasharray: `${Math.min(100, contextPercent)} 100` }} />}
      </svg>
    </button>
    {isOpen && <div className="session-usage-popover" role="dialog" aria-label={i18n.t("会话用量")}>
      <strong>{i18n.t("上下文窗口")}</strong>
      {contextUsed !== undefined && contextMax !== undefined ? <>
        <div className="session-usage-percent">{i18n.t("已使用")}{contextPercent ?? 0}%</div>
        <div className="session-usage-token-count">{formatUsageTokens(contextUsed)} / {formatUsageTokens(contextMax)} tokens</div>
      </> : <div className="session-usage-token-count">{loading ? i18n.t("正在读取用量…") : hasUsage ? i18n.t("当前模型未提供上下文用量") : i18n.t("完成首条回复后显示用量")}</div>}
      {usage?.totalCostUsd !== undefined && <div className="session-usage-cost">{i18n.t("会话费用 $")}{usage.totalCostUsd.toFixed(2)}</div>}
      {contextSupported && <div className="session-context-actions">
        <button type="button" disabled={sessionBusy || compacting} onClick={() => void compactContext()}>{compacting ? i18n.t("正在压缩…") : i18n.t("压缩上下文")}</button>
        {typeof session.runtimeSettings?.autoCompactionEnabled === "boolean" && <label><input type="checkbox" checked={session.runtimeSettings.autoCompactionEnabled} disabled={sessionBusy || compacting} onChange={(event) => void setAutoCompaction(event.currentTarget.checked)} />{i18n.t("自动压缩")}</label>}
      </div>}
    </div>}
  </div>;
}
