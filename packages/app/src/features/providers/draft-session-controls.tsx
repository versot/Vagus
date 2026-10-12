import type { HostClient, ProviderModelCatalog } from "@vagus/client";
import { ArrowLeft, Check, ChevronDown, ChevronRight, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../locales/i18n.js";
import { getProviderSessionPreference, saveProviderSessionPreference } from "./provider-session-preferences.js";

const thinkingLevelLabels: Record<string, string> = {
  off: "关闭", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大",
};

interface ThinkingChoice { value: string; label: string; }

function thinkingChoicesForModel(levels: string[]): ThinkingChoice[] {
  const available = new Set(levels);
  const maximum = ["max", "xhigh", "high", "medium", "low", "minimal", "off"].find((level) => available.has(level));
  const high = maximum === "high"
    ? available.has("medium") ? "medium" : undefined
    : ["high", "medium", "low", "minimal", "off"].find((level) => available.has(level) && level !== maximum);
  const low = ["low", "minimal", "medium", "high", "xhigh", "max"].find((level) => available.has(level) && level !== high && level !== maximum);
  const off = available.has("off") ? "off" : undefined;
  const candidates: Array<ThinkingChoice | undefined> = [
    off ? { value: off, label: i18n.t("关闭") } : undefined,
    low ? { value: low, label: i18n.t("低") } : undefined,
    high ? { value: high, label: i18n.t("高") } : undefined,
    maximum ? { value: maximum, label: i18n.t("最大") } : undefined,
  ];
  const seen = new Set<string>();
  return candidates.flatMap((choice) => {
    if (!choice || seen.has(choice.value)) return [];
    seen.add(choice.value);
    return [choice];
  });
}

function thinkingChoiceIndex(levels: string[], value: string | null | undefined): number {
  const choices = thinkingChoicesForModel(levels);
  if (choices.length === 0) return 0;
  const exact = choices.findIndex((choice) => choice.value === value);
  if (exact >= 0) return exact;
  const nativeIndex = levels.indexOf(value ?? "");
  if (nativeIndex < 0) return 0;
  return choices.reduce((nearestIndex, choice, index) => {
    const currentDistance = Math.abs(levels.indexOf(choice.value) - nativeIndex);
    const nearestChoice = choices[nearestIndex];
    const nearestDistance = nearestChoice ? Math.abs(levels.indexOf(nearestChoice.value) - nativeIndex) : Number.POSITIVE_INFINITY;
    return currentDistance < nearestDistance ? index : nearestIndex;
  }, 0);
}

export function thinkingLevelDisplay(levels: string[], value: string | null | undefined): string {
  if (thinkingChoicesForModel(levels).length === 0) return "";
  return thinkingChoicesForModel(levels)[thinkingChoiceIndex(levels, value)]?.label
    ?? (thinkingLevelLabels[value ?? ""] ? i18n.t(thinkingLevelLabels[value ?? ""]!) : undefined)
    ?? value
    ?? i18n.t("思考");
}

export function ThinkingLevelSlider({
  levels,
  value,
  disabled = false,
  onChange,
}: {
  levels: string[];
  value: string | null | undefined;
  disabled?: boolean;
  onChange: (level: string) => void;
}) {
  const choices = thinkingChoicesForModel(levels);
  const activeIndex = thinkingChoiceIndex(levels, value);
  if (choices.length === 0) return null;
  return <div className="session-thinking-slider-wrap">
    <div className="session-thinking-level-options" role="group" aria-label={i18n.t("思考程度")} style={{ gridTemplateColumns: `repeat(${choices.length}, minmax(0, 1fr))` }}>
      {choices.map((choice, index) => <button
        key={choice.value}
        type="button"
        className={index === activeIndex ? "is-selected" : ""}
        aria-pressed={index === activeIndex}
        disabled={disabled}
        onClick={() => { if (index !== activeIndex) onChange(choice.value); }}
      >{choice.label}</button>)}
    </div>
  </div>;
}

export interface DraftSessionSelection {
  providerId: string;
  modelId: string | null;
  thinkingLevel: string | null;
  modeId: string | null;
  availableModes: Array<{ id: string; name: string; description?: string }>;
}

export function defaultSessionModeId(providerId: string, modes: DraftSessionSelection["availableModes"], currentModeId?: string | null): string | null {
  const find = (pattern: RegExp) => modes.find((mode) => pattern.test(`${mode.id} ${mode.name}`.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase()));
  const preferred = providerId === "codex" ? modes.find((mode) => mode.id === ":danger-full-access")
    : providerId === "claude" ? find(/\bauto\b/u)
      : providerId === "qoder" ? find(/don.?t.?ask|do not ask|不询问|不再询问/u)
        : undefined;
  return preferred?.id ?? (modes.some((mode) => mode.id === currentModeId) ? currentModeId! : modes[0]?.id ?? null);
}

export function DraftSessionControls({
  host,
  providerId,
  supported,
  disabled = false,
  className = "",
  onChange,
}: {
  host: HostClient;
  providerId: string;
  supported: boolean;
  disabled?: boolean;
  className?: string;
  onChange: (selection: DraftSessionSelection) => void;
}) {
  useTranslation();
  const [catalog, setCatalog] = useState<ProviderModelCatalog | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"thinking" | "models">("thinking");
  const [query, setQuery] = useState("");
  const controlsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuLayout, setMenuLayout] = useState<CSSProperties>({});
  const selectionRef = useRef<DraftSessionSelection>({ providerId, modelId: null, thinkingLevel: null, modeId: null, availableModes: [] });
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const [retry, setRetry] = useState(0);
  const selectedModel = catalog?.models.find((model) => model.id === modelId);
  const thinkingLevels = selectedModel?.thinkingLevels ?? [];
  const filteredModels = (catalog?.models ?? []).filter((model) => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || `${model.name} ${model.id} ${model.source}`.toLocaleLowerCase().includes(needle);
  });
  const modelGroups = [...new Set(filteredModels.map((model) => model.source))].map((source) => ({ source, models: filteredModels.filter((model) => model.source === source) }));

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const positionMenu = () => {
      const rect = controlsRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!rect || !menu) return;
      const above = Math.max(0, rect.top - 22);
      const below = Math.max(0, window.innerHeight - rect.bottom - 22);
      const desiredHeight = menuView === "models" ? 490 : menu.scrollHeight;
      const openAbove = above >= Math.min(desiredHeight, window.innerHeight * .68) || above >= below;
      setMenuLayout({ top: openAbove ? "auto" : "calc(100% + 10px)", bottom: openAbove ? "calc(100% + 10px)" : "auto", maxHeight: Math.min(490, window.innerHeight * .68, openAbove ? above : below) });
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => { window.removeEventListener("resize", positionMenu); window.removeEventListener("scroll", positionMenu, true); };
  }, [menuOpen, menuView]);

  useEffect(() => { if (disabled) setMenuOpen(false); }, [disabled]);

  useEffect(() => {
    let active = true;
    setCatalog(null); setModelId(null); setThinkingLevel(null); setMenuOpen(false); setMenuView("thinking");
    selectionRef.current = { providerId, modelId: null, thinkingLevel: null, modeId: null, availableModes: [] };
    onChangeRef.current(selectionRef.current);
    if (!providerId || !supported) return;
    const applyCatalog = (next: ProviderModelCatalog) => {
      if (!active) return;
      setCatalog(next);
      if (next.status !== "ready") return;
      // Preserve choices made while a stale catalog refresh is in flight.
      const previous = selectionRef.current;
      const saved = getProviderSessionPreference(providerId);
      const initialModel = next.models.find((model) => model.id === previous.modelId)
        ?? next.models.find((model) => model.id === saved.modelId)
        ?? next.models.find((model) => model.id === next.currentModelId)
        ?? next.models[0];
      const initialThinking = [previous.thinkingLevel, saved.thinkingLevel, next.currentThinkingLevel, "medium"]
        .find((level) => level != null && initialModel?.thinkingLevels?.includes(level)) ?? null;
      const availableModes = next.availableModes ?? [];
      const preferredMode = availableModes.some((mode) => mode.id === saved.modeId) ? saved.modeId! : defaultSessionModeId(providerId, availableModes, next.currentModeId);
      const selection = { providerId, modelId: initialModel?.id ?? null, thinkingLevel: initialThinking, modeId: preferredMode, availableModes };
      selectionRef.current = selection;
      setModelId(selection.modelId); setThinkingLevel(selection.thinkingLevel);
      onChangeRef.current(selection);
    };
    void host.request("providers.models", { providerId }).then((current) => {
      if (!active) return;
      applyCatalog(current);
      if (current.stale || current.status === "loading" || !current.models.length) {
        return host.request("providers.models.refresh", { providerId }).then(applyCatalog);
      }
    }).catch(() => {
      if (!active) return;
      setCatalog({ providerId, models: [], currentModelId: null, fetchedAt: "", status: "error", stale: true });
      setModelId(null); setThinkingLevel(null);
      selectionRef.current = { providerId, modelId: null, thinkingLevel: null, modeId: null, availableModes: [] };
      onChangeRef.current(selectionRef.current);
    });
    return () => { active = false; };
  }, [host, providerId, supported, retry]);

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

  const chooseModel = (nextModelId: string) => {
    const nextModel = catalog?.models.find((model) => model.id === nextModelId);
    const nextThinking = nextModel?.thinkingLevels?.includes(thinkingLevel ?? "")
      ? thinkingLevel
      : nextModel?.thinkingLevels?.includes(catalog?.currentThinkingLevel ?? "")
        ? catalog?.currentThinkingLevel ?? null
        : nextModel?.thinkingLevels?.includes("medium") ? "medium" : null;
    setModelId(nextModelId); setThinkingLevel(nextThinking); setQuery(""); setMenuView("thinking");
    selectionRef.current = { ...selectionRef.current, providerId, modelId: nextModelId, thinkingLevel: nextThinking };
    saveProviderSessionPreference(providerId, { modelId: nextModelId, thinkingLevel: nextThinking });
    onChange(selectionRef.current);
  };
  const chooseThinking = (nextLevel: string) => {
    setThinkingLevel(nextLevel);
    selectionRef.current = { ...selectionRef.current, providerId, modelId, thinkingLevel: nextLevel };
    saveProviderSessionPreference(providerId, { modelId: modelId ?? undefined, thinkingLevel: nextLevel });
    onChange(selectionRef.current);
  };
  const disabledReason = !supported ? i18n.t("当前 Host 尚未加载新建会话的模型选择功能，重启后即可使用") : undefined;

  return <div className={`session-controls draft-session-controls ${className}`} ref={controlsRef}>
    <button type="button" className="session-settings-trigger" aria-label={thinkingLevels.length ? i18n.t("模型与思考程度") : i18n.t("选择模型")} title={selectedModel && thinkingLevels.length ? thinkingLevelDisplay(thinkingLevels, thinkingLevel) : undefined} aria-haspopup="dialog" aria-expanded={menuOpen} aria-description={disabledReason ?? (catalog?.status === "ready" ? i18n.t("为新会话选择模型和思考程度") : i18n.t("正在读取模型目录"))} disabled={disabled || !providerId || !supported || catalog?.status !== "ready"} onClick={() => { setMenuView(thinkingLevels.length ? "thinking" : "models"); setMenuOpen((open) => !open); }}>
      <span className="session-setting-label">{!providerId ? i18n.t("请先选择框架") : selectedModel?.name ?? (catalog?.status === "error" ? i18n.t("模型不可用") : catalog?.status === "ready" ? i18n.t("选择模型") : i18n.t("读取模型…"))}</span>
      {selectedModel && thinkingLevels.length > 0 && <span className="session-settings-thinking-label">{thinkingLevelDisplay(thinkingLevels, thinkingLevel)}</span>}<ChevronDown size={12} />
    </button>
    {menuOpen && <div ref={menuRef} style={menuLayout} className="session-preferences-menu" role="dialog" aria-label={i18n.t("为新会话设置模型与思考程度")}>
      {menuView === "thinking" && thinkingLevels.length > 0 ? <>
        <div className="session-preferences-quick-heading"><strong>{thinkingLevelDisplay(thinkingLevels, thinkingLevel)}</strong></div>
        <button type="button" className="session-preferences-model-link" onClick={() => { setQuery(""); setMenuView("models"); }}>
          <span>{selectedModel?.name ?? i18n.t("选择模型")}</span><ChevronRight size={15} />
        </button>
        <ThinkingLevelSlider levels={thinkingLevels} value={thinkingLevel} onChange={chooseThinking} />
      </> : <>
        <div className="session-preferences-model-heading">{thinkingLevels.length > 0 && <button type="button" aria-label={i18n.t("返回思考程度")} onClick={() => setMenuView("thinking")}><ArrowLeft size={15} /></button>}<strong>{i18n.t("选择模型")}</strong><span>{selectedModel?.name ?? ""}</span></div>
        <label className="session-model-search"><Search size={15} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={i18n.t("搜索模型")} /></label>
        <div className="session-model-results" role="listbox" aria-label={i18n.t("可用模型")}>
          {catalog?.status === "loading" && <div className="session-model-empty">{i18n.t("正在读取模型…")}</div>}
          {catalog?.status === "error" && <div className="session-model-empty">{i18n.t("无法读取模型目录")}</div>}
          {modelGroups.map(({ source, models }) => <section className="session-model-group" key={source}>
            <div className="session-model-group-label">{source}</div>
            {models.map((model) => <button type="button" key={model.id} role="option" aria-selected={modelId === model.id} className="session-model-option" onClick={() => chooseModel(model.id)}>
              <span className="session-model-option-copy"><strong>{model.name}</strong><small>{model.id}</small></span>
              {modelId === model.id && <Check size={15} />}
            </button>)}
          </section>)}
          {filteredModels.length === 0 && <div className="session-model-empty">{catalog?.status === "error" ? i18n.t("无法读取模型目录") : i18n.t("没有匹配的可用模型")}</div>}
        </div>
      </>}
    </div>}
    {catalog?.status === "error" && <button type="button" className="draft-model-retry" disabled={disabled} onClick={() => setRetry((value) => value + 1)}>{i18n.t("重试")}</button>}
  </div>;
}

