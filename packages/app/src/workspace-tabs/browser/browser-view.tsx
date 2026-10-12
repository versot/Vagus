import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { BrowserElementReference } from "@vagus/protocol";
import { ArrowLeft, ArrowRight, Camera, Globe, Monitor, MousePointer2, RotateCw, Smartphone, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import { AsyncScope } from "../../lib/async-scope.js";
import i18n from "../../locales/i18n.js";
import type { WorkspaceTabContext } from "../registry.js";
import "./browser-view.css";

function normalizeUrl(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

const devicePresets = [
  { id: "responsive", label: "自适应", shortLabel: "自适应", width: 0, height: 0 },
  { id: "iphone-se", label: "iPhone SE · 375 × 667", shortLabel: "iPhone SE", width: 375, height: 667 },
  { id: "iphone-14", label: "iPhone 14 · 390 × 844", shortLabel: "iPhone 14", width: 390, height: 844 },
  { id: "ipad-mini", label: "iPad mini · 768 × 1024", shortLabel: "iPad mini", width: 768, height: 1024 },
  { id: "desktop", label: "桌面 · 1440 × 900", shortLabel: "桌面", width: 1440, height: 900 },
] as const;
type PickerMode = "annotate" | "screenshot";
type ElementSelection = Omit<BrowserElementReference, "id"> & { rect: { x: number; y: number; width: number; height: number } };
export type BrowserViewProps = { browserId: string; initialUrl?: string | null; visible: boolean; onUpdateTitle?(title: string): void; onUpdateFavicon?(faviconUrl: string | null): void; onShowTooltip?(event: ReactMouseEvent<HTMLElement>, label: string): void; onHideTooltip?(): void; context: WorkspaceTabContext };

export function BrowserView({ browserId, initialUrl, visible, onUpdateTitle, onUpdateFavicon, onShowTooltip, onHideTooltip, context }: BrowserViewProps) {
  const profileId = `browser-${browserId.replace(/[^a-zA-Z0-9-]/g, "-")}`;
  const [childId] = useState(() => `${profileId}-${crypto.randomUUID()}`);
  const resourceScopeRef = useRef(new AsyncScope());
  const navigationQueueRef = useRef(Promise.resolve());
  const contentRef = useRef<HTMLDivElement>(null);
  const webviewCreatedRef = useRef(false);
  const onUpdateTitleRef = useRef(onUpdateTitle);
  const onUpdateFaviconRef = useRef(onUpdateFavicon);
  const scheduledPositionRef = useRef<number | null>(null);
  const positioningRef = useRef(false);
  const latestBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null | undefined>(undefined);
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null | undefined>(undefined);
  const positionWebviewRef = useRef<() => void>(() => undefined);
  const [address, setAddress] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const historyTraversalRef = useRef<{ url: string; index: number } | null>(null);
  const [error, setError] = useState("");
  const initialNavigationStartedRef = useRef(false);
  const [devicePreset, setDevicePreset] = useState<(typeof devicePresets)[number]["id"]>("responsive");
  const [pickerMode, setPickerMode] = useState<PickerMode | null>(null);
  const pickerModeRef = useRef<PickerMode | null>(null);
  const pickerListenersReadyRef = useRef<Promise<void>>(Promise.resolve());
  const contextRef = useRef(context);
  contextRef.current = context;
  const updatePickerMode = useCallback((mode: PickerMode | null) => {
    pickerModeRef.current = mode;
    setPickerMode(mode);
  }, []);
  useEffect(() => { onUpdateTitleRef.current = onUpdateTitle; onUpdateFaviconRef.current = onUpdateFavicon; }, [onUpdateTitle, onUpdateFavicon]);

  const recordNavigation = useCallback((url: string, kind: "load" | "push" | "replace" | "pop") => {
    setCurrentUrl(url); setAddress(url);
    const traversal = historyTraversalRef.current;
    if (traversal?.url === url) {
      historyIndexRef.current = traversal.index; historyTraversalRef.current = null;
      setHistoryIndex(traversal.index);
      return;
    }
    if (kind === "pop") {
      let index = -1;
      for (let candidate = Math.min(historyIndexRef.current - 1, historyRef.current.length - 1); candidate >= 0; candidate--) {
        if (historyRef.current[candidate] === url) { index = candidate; break; }
      }
      if (index < 0) index = historyRef.current.findIndex((item, candidate) => candidate > historyIndexRef.current && item === url);
      if (index === historyIndexRef.current && index > 0) index--;
      if (index >= 0) { historyIndexRef.current = index; setHistoryIndex(index); return; }
    }
    if (kind === "replace") {
      const index = Math.max(0, historyIndexRef.current);
      const next = historyRef.current.length ? [...historyRef.current] : [];
      if (next.length) next[index] = url; else next.push(url);
      historyRef.current = next; historyIndexRef.current = index;
      setHistory(next); setHistoryIndex(index);
      return;
    }
    if (kind === "load" && historyRef.current[historyIndexRef.current] === url) return;
    const next = [...historyRef.current.slice(0, historyIndexRef.current + 1), url];
    historyRef.current = next; historyIndexRef.current = next.length - 1;
    setHistory(next); setHistoryIndex(next.length - 1);
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<{ browserId: string; title: string }>("browser-title-changed", event => {
      if (event.payload.browserId !== childId) return;
      const title = event.payload.title.trim();
      if (active && title) onUpdateTitleRef.current?.(title);
    }).then(dispose => { if (active) unlisten = dispose; else dispose(); });
    return () => { active = false; unlisten?.(); };
  }, [childId]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<{ browserId: string; url: string; kind: "load" | "push" | "replace" | "pop" }>("browser-navigation-changed", event => {
      if (active && event.payload.browserId === childId) recordNavigation(event.payload.url, event.payload.kind);
    }).then(dispose => { if (active) unlisten = dispose; else dispose(); });
    return () => { active = false; unlisten?.(); };
  }, [childId, recordNavigation]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<{ browserId: string; faviconUrl: string }>("browser-favicon-changed", event => {
      if (event.payload.browserId !== childId || !active) return;
      const faviconUrl = event.payload.faviconUrl.trim();
      if (/^https?:\/\//i.test(faviconUrl)) onUpdateFaviconRef.current?.(faviconUrl);
    }).then(dispose => { if (active) unlisten = dispose; else dispose(); });
    return () => { active = false; unlisten?.(); };
  }, [childId]);

  const getBounds = useCallback(() => {
    const element = contentRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const panel = element.closest<HTMLElement>(".workspace-side-panel");
    if (panel) {
      const clip = panel.getBoundingClientRect();
      // Native child webviews do not inherit CSS clipping or opacity. Keep the
      // page hidden until its unchanged viewport fits inside the opening panel.
      if (rect.left < clip.left - .5 || rect.right > clip.right + .5) return null;
    }
    const preset = devicePresets.find(item => item.id === devicePreset);
    if (!preset || preset.id === "responsive") return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const width = Math.min(rect.width, preset.width);
    const height = Math.min(rect.height, preset.height);
    return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
  }, [devicePreset]);

  const positionWebview = useCallback(() => {
    if (!webviewCreatedRef.current || !resourceScopeRef.current.active) return;
    const measured = getBounds();
    latestBoundsRef.current = visible && measured && measured.width >= 1 && measured.height >= 1 ? measured : null;
    if (scheduledPositionRef.current !== null || positioningRef.current) return;
    scheduledPositionRef.current = requestAnimationFrame(() => {
      scheduledPositionRef.current = null;
      const next = latestBoundsRef.current;
      latestBoundsRef.current = undefined;
      if (next === undefined || positioningRef.current) return;
      const previous = lastBoundsRef.current;
      if (next === null && previous === null) return;
      if (next && previous && next.x === previous.x && next.y === previous.y && next.width === previous.width && next.height === previous.height) return;
      positioningRef.current = true;
      void invoke("browser_control", next
        ? { browserId: childId, action: "set-bounds", ...next, show: previous === null }
        : { browserId: childId, action: "hide" })
        .then(() => { lastBoundsRef.current = next; })
        .catch(() => undefined)
        .finally(() => {
          positioningRef.current = false;
          if (latestBoundsRef.current !== undefined) positionWebviewRef.current();
        });
    });
  }, [childId, getBounds, visible]);
  positionWebviewRef.current = positionWebview;

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { void positionWebview(); });
    observer.observe(element);
    const panel = element.closest<HTMLElement>(".workspace-side-panel");
    if (panel) observer.observe(panel);
    window.addEventListener("resize", positionWebview);
    void positionWebview();
    return () => {
      observer.disconnect(); window.removeEventListener("resize", positionWebview);
      if (scheduledPositionRef.current !== null) cancelAnimationFrame(scheduledPositionRef.current);
      scheduledPositionRef.current = null;
    };
  }, [positionWebview]);
  useEffect(() => {
    if (visible) void positionWebview();
    else if (webviewCreatedRef.current) void invoke("browser_control", { browserId: childId, action: "hide" }).catch(() => undefined);
  }, [visible, positionWebview, childId]);
  useEffect(() => {
    const scope = new AsyncScope(); resourceScopeRef.current = scope;
    return () => { webviewCreatedRef.current = false; void scope.dispose(); };
  }, [childId]);

  const navigate = useCallback((input: string) => {
    const url = normalizeUrl(input);
    if (!url) { setError(i18n.t("请输入有效的网址")); return; }
    setError("");
    setCurrentUrl(url); setAddress(url);
    onUpdateFaviconRef.current?.(null);
    const scope = resourceScopeRef.current;
    const navigation = navigationQueueRef.current.catch(() => { }).then(async () => {
      if (!scope.active) return;
      try {
        const bounds = getBounds();
        if (!bounds) return;
        if (webviewCreatedRef.current) await invoke("browser_control", { browserId: childId, action: "navigate", url });
        else {
          await scope.acquire(() => invoke("browser_create", { windowLabel: getCurrentWindow().label, browserId: childId, profileId, url, ...bounds }), () => invoke("browser_control", { browserId: childId, action: "close" }).catch(() => undefined));
          if (!scope.active) return;
          webviewCreatedRef.current = true;
        }
        if (!scope.active) return;
        requestAnimationFrame(() => { void positionWebview(); });
      } catch (reason) { if (scope.active) setError(reason instanceof Error ? reason.message : String(reason)); }
    });
    navigationQueueRef.current = navigation;
    return navigation;
  }, [childId, profileId, getBounds, positionWebview]);

  useEffect(() => {
    if (!initialUrl || !visible || initialNavigationStartedRef.current) return;
    let active = true;
    let frame = 0;
    let attempts = 0;
    const openWhenReady = () => {
      if (!active) return;
      if (!getBounds()) {
        if (attempts++ < 60) frame = requestAnimationFrame(openWhenReady);
        else setError(i18n.t("浏览器面板尚未准备好，请重试"));
        return;
      }
      initialNavigationStartedRef.current = true;
      void navigate(initialUrl);
    };
    frame = requestAnimationFrame(openWhenReady);
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [getBounds, initialUrl, navigate, visible]);

  useEffect(() => {
    let active = true;
    let unlistenSelected: (() => void) | undefined;
    let unlistenCancelled: (() => void) | undefined;
    const ready = (async () => {
      unlistenSelected = await listen<{ browserId: string; data: string }>("browser-element-selected", event => {
        if (!active || event.payload.browserId !== childId) return;
        const mode = pickerModeRef.current;
        if (!mode) return;
        try {
          const item = JSON.parse(event.payload.data) as ElementSelection;
          const element: BrowserElementReference = { id: crypto.randomUUID(), url: item.url, selector: item.selector, tag: item.tag, text: item.text, html: item.html, ...(item.note ? { note: item.note } : {}) };
          updatePickerMode(null);
          if (mode === "screenshot") {
            const scope = resourceScopeRef.current;
            void invoke<string>("browser_capture_element", { browserId: childId, ...item.rect })
              .then(imageDataUrl => { if (scope.active) contextRef.current.attachBrowserElement?.({ element, imageDataUrl, fileName: "browser-element.png" }); })
              .catch(reason => { if (scope.active) setError(reason instanceof Error ? reason.message : String(reason)); });
          } else contextRef.current.attachBrowserElement?.({ element });
        } catch { setError(i18n.t("无法读取所选元素")); updatePickerMode(null); }
      });
      if (!active) { unlistenSelected(); return; }
      unlistenCancelled = await listen<{ browserId: string }>("browser-element-cancelled", event => {
        if (active && event.payload.browserId === childId) updatePickerMode(null);
      });
      if (!active) { unlistenSelected(); unlistenCancelled(); }
    })().catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    });
    pickerListenersReadyRef.current = ready;
    // Picker scripts can emit immediately after a click; keep both event handlers mounted
    // and wait for them before starting the native page-side picker.
    void ready.catch(() => undefined);
    return () => { active = false; unlistenSelected?.(); unlistenCancelled?.(); };
  }, [childId, updatePickerMode]);

  const startPicker = async (mode: PickerMode) => {
    if (!currentUrl) { setError(i18n.t("请先打开网页")); return; }
    setError("");
    updatePickerMode(mode);
    try {
      await pickerListenersReadyRef.current;
      await invoke("browser_control", { browserId: childId, action: "pick-element", mode });
    }
    catch (reason) { updatePickerMode(null); setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void navigate(address); };
  const goHistory = (step: -1 | 1) => {
    const nextIndex = historyIndexRef.current + step;
    if (nextIndex < 0 || nextIndex >= historyRef.current.length) return;
    const nextUrl = historyRef.current[nextIndex]!;
    historyTraversalRef.current = { url: nextUrl, index: nextIndex };
    void invoke("browser_control", { browserId: childId, action: step < 0 ? "back" : "forward" }).then(() => {
      onUpdateFaviconRef.current?.(null);
      historyTraversalRef.current = null;
      historyIndexRef.current = nextIndex;
      setHistoryIndex(nextIndex); setCurrentUrl(nextUrl); setAddress(nextUrl);
    }).catch(reason => { historyTraversalRef.current = null; setError(reason instanceof Error ? reason.message : String(reason)); });
  };

  return <div className="browser-view">
    <div className="browser-toolbar">
      <div className="browser-navigation">
        <button type="button" aria-label={i18n.t("后退")} disabled={historyIndex <= 0} onMouseEnter={event => onShowTooltip?.(event, i18n.t("后退"))} onMouseLeave={onHideTooltip} onClick={() => goHistory(-1)}><ArrowLeft size={17} /></button>
        <button type="button" aria-label={i18n.t("前进")} disabled={historyIndex < 0 || historyIndex >= history.length - 1} onMouseEnter={event => onShowTooltip?.(event, i18n.t("前进"))} onMouseLeave={onHideTooltip} onClick={() => goHistory(1)}><ArrowRight size={17} /></button>
        <button type="button" aria-label={i18n.t("刷新")} disabled={!currentUrl} onMouseEnter={event => onShowTooltip?.(event, i18n.t("刷新"))} onMouseLeave={onHideTooltip} onClick={() => void invoke("browser_control", { browserId: childId, action: "reload" }).catch(reason => setError(String(reason)))}><RotateCw size={16} /></button>
        <form className="browser-address-form" onSubmit={submit}>
          <Globe size={16} aria-hidden="true" />
          <input value={address} onChange={event => setAddress(event.target.value)} placeholder={i18n.t("输入网址后回车")} aria-label={i18n.t("网址")} spellCheck={false} />
        </form>
      </div>
      <div className="browser-tools">
        <label className="browser-device-select" onMouseEnter={event => onShowTooltip?.(event, i18n.t("设备尺寸"))} onMouseLeave={onHideTooltip}><Smartphone size={15} aria-hidden="true" /><select aria-label={i18n.t("设备尺寸")} value={devicePreset} onChange={event => setDevicePreset(event.target.value as typeof devicePreset)}>{devicePresets.map(preset => <option key={preset.id} value={preset.id}>{preset.shortLabel}</option>)}</select></label>
        <span className="browser-tool-divider" aria-hidden="true" />
        <button type="button" aria-label={i18n.t("打开调试工具")} disabled={!currentUrl} onMouseEnter={event => onShowTooltip?.(event, i18n.t("打开调试工具"))} onMouseLeave={onHideTooltip} onClick={() => void invoke("browser_control", { browserId: childId, action: "devtools" }).catch(reason => setError(String(reason)))}><Wrench size={16} /></button>
        <button type="button" className={pickerMode === "annotate" ? "is-active" : ""} aria-label={i18n.t("标注网页元素")} disabled={!currentUrl} onMouseEnter={event => onShowTooltip?.(event, i18n.t("标注网页元素"))} onMouseLeave={onHideTooltip} onClick={() => void startPicker("annotate")}><MousePointer2 size={16} /></button>
        <button type="button" className={pickerMode === "screenshot" ? "is-active" : ""} aria-label={i18n.t("截图网页元素")} disabled={!currentUrl} onMouseEnter={event => onShowTooltip?.(event, i18n.t("截图网页元素"))} onMouseLeave={onHideTooltip} onClick={() => void startPicker("screenshot")}><Camera size={16} /></button>
      </div>
    </div>
    {pickerMode && <div className="browser-picker-banner" role="status"><MousePointer2 size={15} />{i18n.t("点击网页中的元素以选择，按 Esc 取消")}<button type="button" onClick={() => { void invoke("browser_control", { browserId: childId, action: "cancel-element-picker" }); updatePickerMode(null); }} aria-label={i18n.t("取消")}><X size={15} /></button></div>}
    {error && <div className="browser-error" role="alert">{error}</div>}
    <div ref={contentRef} className={`browser-content${currentUrl ? " has-page" : ""}${devicePreset !== "responsive" ? " is-device-preview" : ""}`}>
      {!currentUrl && <div className="browser-empty"><Monitor size={62} strokeWidth={1.4} /><strong>{i18n.t("浏览器")}</strong><span>{i18n.t("粘贴或输入 URL 以打开网页。")}</span></div>}
    </div>
  </div>;
}
