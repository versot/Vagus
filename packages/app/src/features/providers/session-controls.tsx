import { type ProviderModelCatalog, type WorkspaceSession } from "@vagus/client";
import { type AgentRuntimeSettings } from "@vagus/protocol";
import { ArrowLeft, Check, ChevronDown, ChevronRight, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { host } from "../../lib/workspace-host.js";
import i18n from "../../locales/i18n.js";
import { ThinkingLevelSlider, thinkingLevelDisplay } from "./draft-session-controls.js";
import { saveProviderSessionPreference } from "./provider-session-preferences.js";

export function AgentSessionControls({
  session,
  supported,
  onSettings,
  onError,
}: {
  session: WorkspaceSession;
  supported: boolean;
  onSettings: (settings: AgentRuntimeSettings, state?: string) => void;
  onError: (message: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"thinking" | "models">("thinking");
  const [catalog, setCatalog] = useState<ProviderModelCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewThinkingLevel, setPreviewThinkingLevel] = useState<string | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const runtimeSettings = session.runtimeSettings;
  const sessionBusy = session.state === "running" || session.state === "starting";
  const canChange = supported && !sessionBusy && Boolean(runtimeSettings);
  const currentModel = catalog?.models.find((model) => model.id === runtimeSettings?.modelId);
  const modelLabel = currentModel?.name ?? (session.providerId === "claude" && !catalog ? i18n.t("正在读取模型…") : runtimeSettings?.modelId?.split("/").at(-1) ?? i18n.t("选择模型"));
  const filteredModels = (catalog?.models ?? []).filter((model) => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || `${model.name} ${model.id} ${model.source}`.toLocaleLowerCase().includes(needle);
  });
  const modelGroups = [...new Set(filteredModels.map((model) => model.source))].map((source) => ({ source, models: filteredModels.filter((model) => model.source === source) }));

  useEffect(() => {
    setMenuOpen(false);
    setMenuView("thinking");
    setQuery("");
    setCatalog(null);
    setPreviewThinkingLevel(null);
  }, [session.id]);

  useEffect(() => {
    let active = true;
    void host.request("providers.models", { providerId: session.providerId ?? "pi" }).then((current) => {
      if (!active) return;
      setCatalog(current);
      if (current.stale || current.status === "loading") {
        void host.request("providers.models.refresh", { providerId: session.providerId ?? "pi" })
          .then((fresh) => { if (active) setCatalog(fresh); })
          .catch(() => undefined);
      }
    }).catch((reason: unknown) => {
      if (active) onError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [session.id, session.providerId]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [menuOpen]);

  const changeModel = async (modelId: string) => {
    setSaving(true);
    try {
      const settings = await host.request("sessions.set-model", { sessionId: session.id, modelId });
      saveProviderSessionPreference(session.providerId ?? "pi", { modelId: settings.modelId ?? modelId, thinkingLevel: settings.thinkingLevel });
      onSettings(settings); setQuery(""); setMenuView(settings.thinkingLevels?.length ? "thinking" : "models");
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  const changeThinking = async (level: string) => {
    setPreviewThinkingLevel(level);
    setSaving(true);
    try {
      const settings = await host.request("sessions.set-thinking-level", { sessionId: session.id, level });
      saveProviderSessionPreference(session.providerId ?? "pi", { modelId: settings.modelId ?? undefined, thinkingLevel: settings.thinkingLevel ?? level });
      onSettings(settings); setPreviewThinkingLevel(null);
    } catch (reason) { setPreviewThinkingLevel(null); onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  const visibleThinkingLevel = previewThinkingLevel ?? runtimeSettings?.thinkingLevel;
  const settingsTitle = canChange ? i18n.t("模型与思考程度") : !supported ? i18n.t("当前 Host 版本较旧；重启 Vagus 后可使用") : sessionBusy ? i18n.t("请等待当前回复完成后再调整") : i18n.t("打开时读取会话设置");
  const openSettings = () => {
    setMenuView(runtimeSettings?.thinkingLevels?.length ? "thinking" : "models");
    setMenuOpen(true);
    if (!runtimeSettings && !saving) {
      setSaving(true);
      void host.request("sessions.get-settings", { sessionId: session.id })
        .then(({ settings, state }) => { onSettings(settings, state); setMenuView(settings.thinkingLevels?.length ? "thinking" : "models"); })
        .catch((reason: unknown) => onError(reason instanceof Error ? reason.message : String(reason)))
        .finally(() => setSaving(false));
    }
  };
  return <div className="session-controls" ref={controlsRef}>
    <button className="session-settings-trigger" title={runtimeSettings?.thinkingLevels.length ? thinkingLevelDisplay(runtimeSettings.thinkingLevels, visibleThinkingLevel) : undefined} aria-haspopup="dialog" aria-expanded={menuOpen} aria-description={settingsTitle} disabled={!supported || sessionBusy || saving} onClick={() => { if (menuOpen) setMenuOpen(false); else openSettings(); }}>
      <span className="session-setting-label" title={session.providerId === "claude" && currentModel ? `${currentModel.name} (${runtimeSettings?.modelId ?? ""})` : undefined}>{modelLabel}</span>
      {(runtimeSettings?.thinkingLevels.length ?? 0) > 0 && <span className="session-settings-thinking-label">{thinkingLevelDisplay(runtimeSettings?.thinkingLevels ?? [], visibleThinkingLevel)}</span>}<ChevronDown size={12} />
    </button>
    {menuOpen && <div className="session-preferences-menu" role="dialog" aria-label={i18n.t("模型与思考程度")}>
      {menuView === "thinking" && (runtimeSettings?.thinkingLevels.length ?? 0) > 0 ? <>
        <div className="session-preferences-quick-heading"><strong>{thinkingLevelDisplay(runtimeSettings?.thinkingLevels ?? [], visibleThinkingLevel)}</strong></div>
        <button className="session-preferences-model-link" onClick={() => { setQuery(""); setMenuView("models"); }}>
          <span>{modelLabel}</span><ChevronRight size={15} />
        </button>
        <ThinkingLevelSlider levels={runtimeSettings?.thinkingLevels ?? []} value={visibleThinkingLevel} disabled={!canChange || saving} onChange={(level) => void changeThinking(level)} />
      </> : <>
        <div className="session-preferences-model-heading">{(runtimeSettings?.thinkingLevels.length ?? 0) > 0 && <button aria-label={i18n.t("返回思考程度")} onClick={() => setMenuView("thinking")}><ArrowLeft size={15} /></button>}<strong>{i18n.t("选择模型")}</strong><span>{currentModel?.name ?? runtimeSettings?.modelId?.split("/").at(-1) ?? ""}</span></div>
        <label className="session-model-search"><Search size={15} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={i18n.t("搜索模型")} /></label>
        <div className="session-model-results" role="listbox" aria-label={i18n.t("可用模型")}>
          {catalog?.status === "loading" && <div className="session-model-empty">{i18n.t("正在读取模型…")}</div>}
          {catalog?.status === "error" && <div className="session-model-empty">{i18n.t("无法读取模型目录")}</div>}
          {modelGroups.map(({ source, models }) => <section className="session-model-group" key={source}>
            <div className="session-model-group-label">{source}</div>
            {models.map((model) => <button key={model.id} role="option" aria-selected={runtimeSettings?.modelId === model.id} className="session-model-option" disabled={!canChange || saving} onClick={() => void changeModel(model.id)}>
              <span className="session-model-option-copy"><strong>{model.name}</strong><small>{model.id}</small></span>
              {runtimeSettings?.modelId === model.id && <Check size={15} />}
            </button>)}
          </section>)}
          {catalog && catalog.status !== "loading" && filteredModels.length === 0 && <div className="session-model-empty">{i18n.t("没有匹配的可用模型")}</div>}
        </div>
      </>}
    </div>}
  </div>;
}

export function AgentModeControl({
  session,
  supported,
  onSettings,
  onError,
}: {
  session: WorkspaceSession;
  supported: boolean;
  onSettings: (settings: AgentRuntimeSettings, state?: string) => void;
  onError: (message: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const controlsRef = useRef<HTMLDivElement>(null);
  const runtimeSettings = session.runtimeSettings;
  const modes = runtimeSettings?.availableModes ?? [];
  const currentMode = modes.find((mode) => mode.id === runtimeSettings?.currentModeId);
  const sessionBusy = session.state === "running" || session.state === "starting";

  useEffect(() => {
    if (runtimeSettings || !supported) return;
    let active = true;
    void host.request("sessions.get-settings", { sessionId: session.id })
      .then(({ settings, state }) => { if (active) onSettings(settings, state); })
      .catch((reason: unknown) => { if (active) onError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [session.id, runtimeSettings, supported]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [menuOpen]);

  const changeMode = async (modeId: string) => {
    setSaving(true);
    try {
      const settings = await host.request("sessions.set-mode", { sessionId: session.id, modeId });
      saveProviderSessionPreference(session.providerId ?? "pi", { modeId: settings.currentModeId ?? modeId });
      onSettings(settings);
      setMenuOpen(false);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  if (modes.length === 0) return null;
  const modeLabel = currentMode ? i18n.t(currentMode.name) : runtimeSettings?.currentModeId ?? "";
  const disabled = !supported || sessionBusy || saving;
  return <div className="session-mode-control" ref={controlsRef}>
    <button type="button" className="session-mode-trigger" aria-label={`${i18n.t("工作模式")}: ${modeLabel}`} title={`${i18n.t("工作模式")}: ${modeLabel}`} aria-haspopup="dialog" aria-expanded={menuOpen} disabled={disabled} onClick={() => setMenuOpen((open) => !open)}>
      <span className="session-mode-trigger-value">{modeLabel}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {menuOpen && <div className="session-preferences-menu session-mode-menu" role="dialog" aria-label={i18n.t("工作模式")}>
      <div className="session-preferences-model-heading"><strong>{i18n.t("选择模式")}</strong><span>{modeLabel}</span></div>
      <div className="session-model-results" role="listbox" aria-label={i18n.t("工作模式")}>
        {modes.map((mode) => <button type="button" key={mode.id} role="option" aria-selected={runtimeSettings?.currentModeId === mode.id} className="session-model-option" disabled={disabled} onClick={() => void changeMode(mode.id)}>
          <span className="session-model-option-copy"><strong>{i18n.t(mode.name)}</strong>{mode.description && <small>{mode.description}</small>}</span>
          {runtimeSettings?.currentModeId === mode.id && <Check size={15} />}
        </button>)}
      </div>
    </div>}
  </div>;
}
