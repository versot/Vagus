import { invoke } from "@tauri-apps/api/core";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { type ProviderModelCatalog, type WorkspaceSession, type WorkspaceSnapshot } from "@vagus/client";
import {
  AlertCircle,
  Archive,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Coffee,
  Database,
  Ellipsis,
  Folder,
  Globe,
  HardDrive,
  Keyboard,
  Languages,
  LoaderCircle,
  Palette,
  PanelTopClose,
  RefreshCw,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ClaudeIcon } from "../../components/icons/claude-icon.js";
import { CodexIcon } from "../../components/icons/codex-icon.js";
import { OpenCodeIcon } from "../../components/icons/opencode-icon.js";
import { PiIcon } from "../../components/icons/pi-icon.js";
import { QoderIcon } from "../../components/icons/qoder-icon.js";
import { ZCodeIcon } from "../../components/icons/zcode-icon.js";
import { createDesktopHostClient } from "../../lib/host-connection.js";
import i18n, { applyInterfaceLanguage } from "../../locales/i18n.js";
import { interfaceLanguages } from "../../locales/interface-languages.js";
import { ProviderExtensions } from "../providers/provider-extensions.js";
import { ProviderMcpServers } from "../providers/provider-mcp-servers.js";
import { ProviderPlugins } from "../providers/provider-plugins.js";
import { ProviderSetupGuide } from "../providers/provider-setup-guide.js";
import { useSessionSearch } from "../sessions/hooks/use-session-search.js";
import { defaultAppSettings, type AppSettings } from "./app-settings.js";
import { AppearanceSettingsPanel } from "./appearance-settings.js";
import { applyAppearance } from "./appearance.js";
import { KeyboardShortcutsSettings } from "./keyboard-shortcuts-settings.js";
import { applyShortcutOverrides } from "./keyboard-shortcuts.js";
import { SettingSelect } from "./setting-select.js";

type DeleteTarget = { kind: "project"; projectId: string } | { kind: "session"; sessionId: string } | { kind: "all" };
type DeleteSuccessNotice = { closing?: boolean };
export type SettingsPage = "general" | "appearance" | "browser" | "keyboard" | "providers" | "archive";
const settingsPageStorageKey = "vagus.settings.last-page.v1";
const archiveHost = createDesktopHostClient();

function readLastSettingsPage(): SettingsPage {
  try {
    const page = window.localStorage.getItem(settingsPageStorageKey);
    if (
      page === "general" ||
      page === "appearance" ||
      page === "browser" ||
      page === "keyboard" ||
      page === "providers" ||
      page === "archive"
    )
      return page;
  } catch {
    /* Open General when navigation storage is unavailable. */
  }
  return "general";
}

function SettingToggle({
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <div className="general-setting-row">
      <span className="general-setting-icon">{icon}</span>
      <span className="general-setting-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className={`general-setting-toggle ${checked ? "is-enabled" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

type UnarchiveNotice = ({ kind: "pending" } | { kind: "success"; session: WorkspaceSession }) & { closing?: boolean };

function archivedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return i18n.t("归档时间未知");
  return new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function modelCatalogUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? i18n.t("更新时间未知")
    : `${i18n.t("更新于")} ${new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, { hour: "2-digit", minute: "2-digit" }).format(date)}`;
}

export function ArchiveSettingsApp({
  onViewSession,
  initialPage,
}: {
  onViewSession(session: WorkspaceSession): void;
  initialPage?: SettingsPage;
}) {
  const { i18n: translation } = useTranslation();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>({ projects: [], sessions: [], providers: [] });
  const [settingsPage, setSettingsPage] = useState<SettingsPage>(() => initialPage ?? readLastSettingsPage());
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings);
  const [runtimeAppSettings, setRuntimeAppSettings] = useState<AppSettings>(defaultAppSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const appSettingsRef = useRef(defaultAppSettings);
  const settingsSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const settingsSaveRevisionRef = useRef(0);
  const settingsSaveTimerRef = useRef<number | undefined>(undefined);
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, ProviderModelCatalog>>({});
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({});
  const [modelsErrors, setModelsErrors] = useState<Record<string, string | null>>({});
  const [modelSearch, setModelSearch] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [providerTab, setProviderTab] = useState<"models" | "extensions" | "plugins" | "mcp">("models");
  const modelFetchStarted = useRef(new Set<string>());
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [projectFilterOpen, setProjectFilterOpen] = useState(false);
  const projectFilterRef = useRef<HTMLDivElement>(null);
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unarchiveNotice, setUnarchiveNotice] = useState<UnarchiveNotice | null>(null);
  const [deleteSuccessNotice, setDeleteSuccessNotice] = useState<DeleteSuccessNotice | null>(null);
  const unarchiveNoticeTimer = useRef<number | undefined>(undefined);
  const deleteSuccessNoticeTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    try {
      window.localStorage.setItem(settingsPageStorageKey, settingsPage);
    } catch {
      /* Keep navigation working when storage is unavailable. */
    }
  }, [settingsPage]);

  const refresh = useCallback(async () => {
    const next = await archiveHost.request("workspace.snapshot");
    setSnapshot(next);
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    const unconnect = archiveHost.onConnection((connected) => {
      if (active && connected)
        void refresh()
          .then(() => {
            if (active) setError(null);
          })
          .catch((reason: unknown) => {
            if (active) setError(reason instanceof Error ? reason.message : String(reason));
          });
    });
    const unlisten = archiveHost.onEvent((event) => {
      if (event.type === "provider.models.updated") {
        setModelCatalogs((current) => ({ ...current, [event.catalog.providerId]: event.catalog }));
        setModelsErrors((current) => ({ ...current, [event.catalog.providerId]: event.catalog.error ?? null }));
      }
      if (event.type === "provider.enabled.updated") {
        setSnapshot((current) => ({
          ...current,
          providers: current.providers.map((provider) =>
            provider.id === event.providerId ? { ...provider, enabled: event.enabled } : provider,
          ),
        }));
      }
      if (event.type === "workspace.changed" || event.type === "message.completed" || event.type === "session.state")
        void refresh().catch(() => undefined);
    });
    void archiveHost.connect().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
      unconnect();
      unlisten();
      archiveHost.close();
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    void invoke<AppSettings>("get_app_settings")
      .then((settings) => {
        if (!active) return;
        appSettingsRef.current = settings;
        setAppSettings(settings);
        setRuntimeAppSettings(settings);
        setSettingsLoaded(true);
      })
      .catch((reason: unknown) => {
        if (active) {
          setSettingsError(reason instanceof Error ? reason.message : String(reason));
          setSettingsLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const saveGeneralSettings = async (next: AppSettings) => {
    const revision = ++settingsSaveRevisionRef.current;
    setSettingsSaving(true);
    setSettingsError(null);
    setSettingsNotice(null);
    const operation = settingsSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const saved = await invoke<AppSettings>("save_app_settings", { settings: next });
          if (revision === settingsSaveRevisionRef.current) {
            appSettingsRef.current = saved;
            setAppSettings(saved);
            applyShortcutOverrides(saved.shortcutOverrides);
          }
        } catch (reason) {
          if (revision === settingsSaveRevisionRef.current)
            setSettingsError(reason instanceof Error ? reason.message : String(reason));
        } finally {
          if (revision === settingsSaveRevisionRef.current) setSettingsSaving(false);
        }
      });
    settingsSaveQueueRef.current = operation;
  };

  const updateAppSetting = (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => {
    ++settingsSaveRevisionRef.current;
    const next = { ...appSettingsRef.current, [key]: value };
    appSettingsRef.current = next;
    setAppSettings(next);
    setSettingsNotice(null);
    setSettingsError(null);
    if (settingsSaveTimerRef.current !== undefined) window.clearTimeout(settingsSaveTimerRef.current);
    if (key === "httpProxy" || key === "dataDirectory") {
      settingsSaveTimerRef.current = window.setTimeout(() => {
        settingsSaveTimerRef.current = undefined;
        void saveGeneralSettings(appSettingsRef.current);
      }, 350);
    } else void saveGeneralSettings(next);
  };

  const chooseDataDirectory = async () => {
    try {
      const selected = await openFolderDialog({
        directory: true,
        multiple: false,
        title: i18n.t("选择应用数据根目录"),
      });
      if (typeof selected === "string") updateAppSetting("dataDirectory", selected);
    } catch (reason) {
      setSettingsError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const restartRequired =
    appSettings.httpProxy !== runtimeAppSettings.httpProxy ||
    appSettings.dataDirectory !== runtimeAppSettings.dataDirectory ||
    appSettings.browserIgnoreCertificateErrors !== runtimeAppSettings.browserIgnoreCertificateErrors;
  const clearBrowserData = async () => {
    if (!window.confirm(i18n.t("确定清除所有内置浏览器数据吗？"))) return;
    setSettingsError(null);
    setSettingsNotice(null);
    try {
      await invoke("browser_clear_data");
      setSettingsNotice(i18n.t("内置浏览器数据已清除"));
    } catch (reason) {
      setSettingsError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  useEffect(() => {
    if (settingsLoaded) applyAppearance(appSettings);
  }, [
    settingsLoaded,
    appSettings.interfaceTheme,
    appSettings.uiFontSize,
    appSettings.codeFontSize,
    appSettings.lightCodeTheme,
    appSettings.darkCodeTheme,
    appSettings.showCodeLineNumbers,
    appSettings.wrapCodeLines,
  ]);
  useEffect(() => {
    if (settingsLoaded) void applyInterfaceLanguage(appSettings.interfaceLanguage);
  }, [settingsLoaded, appSettings.interfaceLanguage]);

  useEffect(() => {
    if (!projectFilterOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!projectFilterRef.current?.contains(event.target as Node)) setProjectFilterOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectFilterOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [projectFilterOpen]);

  useEffect(
    () => () => {
      if (unarchiveNoticeTimer.current !== undefined) window.clearTimeout(unarchiveNoticeTimer.current);
      if (deleteSuccessNoticeTimer.current !== undefined) window.clearTimeout(deleteSuccessNoticeTimer.current);
    },
    [],
  );

  const allArchived = useMemo(
    () => snapshot.sessions.filter((session) => Boolean(session.archivedAt) && !session.scheduledTaskId),
    [snapshot.sessions],
  );
  const searchResults = useSessionSearch(archiveHost, search, settingsPage === "archive", true, allArchived.length);
  const filteredArchived = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return allArchived
      .filter((session) => projectFilter === "all" || session.projectId === projectFilter)
      .filter((session) => !query || searchResults.ids?.has(session.id))
      .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  }, [allArchived, projectFilter, search, searchResults.ids]);

  const groupedArchived = useMemo(() => {
    const groups = new Map<string, WorkspaceSession[]>();
    for (const session of filteredArchived) {
      const projectId = session.projectId ?? "";
      const group = groups.get(projectId) ?? [];
      group.push(session);
      groups.set(projectId, group);
    }
    return [...groups.entries()].map(([projectId, sessions]) => ({
      projectId,
      project: snapshot.projects.find((item) => item.id === projectId),
      sessions,
    }));
  }, [filteredArchived, snapshot.projects]);

  const refreshModels = useCallback(async (providerId: string, force = false) => {
    if (force) setModelsLoading((current) => ({ ...current, [providerId]: true }));
    setModelsErrors((current) => ({ ...current, [providerId]: null }));
    try {
      const catalog = await archiveHost.request(force ? "providers.models.refresh" : "providers.models", {
        providerId,
      });
      setModelCatalogs((current) => ({ ...current, [providerId]: catalog }));
      setModelsErrors((current) => ({ ...current, [providerId]: catalog.error ?? null }));
    } catch (reason) {
      setModelsErrors((current) => ({
        ...current,
        [providerId]: reason instanceof Error ? reason.message : String(reason),
      }));
    } finally {
      if (force) setModelsLoading((current) => ({ ...current, [providerId]: false }));
    }
  }, []);

  const setProviderEnabled = async (providerId: string, enabled: boolean) => {
    setError(null);
    try {
      const updated = await archiveHost.request("providers.set-enabled", { providerId, enabled });
      setSnapshot((current) => ({
        ...current,
        providers: current.providers.map((provider) =>
          provider.id === providerId ? { ...provider, enabled: updated.enabled } : provider,
        ),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const ensureProviderModels = useCallback(
    (providerId: string) => {
      if (modelFetchStarted.current.has(providerId)) return;
      modelFetchStarted.current.add(providerId);
      void refreshModels(providerId);
    },
    [refreshModels],
  );

  useEffect(() => {
    if (settingsPage === "providers") {
      for (const provider of snapshot.providers) ensureProviderModels(provider.id);
    }
  }, [ensureProviderModels, settingsPage, snapshot.providers]);

  useEffect(() => {
    if (!selectedProviderId) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedProviderId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [selectedProviderId]);

  const selectedProvider = snapshot.providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const selectedCatalog = selectedProviderId ? (modelCatalogs[selectedProviderId] ?? null) : null;
  const selectedModelsLoading = selectedProviderId ? modelsLoading[selectedProviderId] === true : false;
  const selectedModelsError = selectedProviderId ? (modelsErrors[selectedProviderId] ?? null) : null;
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLocaleLowerCase();
    const models = selectedCatalog?.models ?? [];
    if (!query) return models;
    return models.filter((model) => `${model.name} ${model.id} ${model.source}`.toLocaleLowerCase().includes(query));
  }, [modelSearch, selectedCatalog?.models]);
  const groupedModels = useMemo(() => {
    const groups = new Map<string, typeof filteredModels>();
    for (const model of filteredModels) {
      const source = model.source.trim() || i18n.t("其他");
      const group = groups.get(source) ?? [];
      group.push(model);
      groups.set(source, group);
    }
    return [...groups.entries()].map(([source, models]) => ({ source, models }));
  }, [filteredModels, translation.language]);

  const unarchiveSession = async (session: WorkspaceSession) => {
    if (unarchiveNoticeTimer.current !== undefined) window.clearTimeout(unarchiveNoticeTimer.current);
    setUnarchiveNotice({ kind: "pending" });
    setBusy(true);
    setError(null);
    try {
      await archiveHost.request("sessions.unarchive", { sessionId: session.id });
      await refresh();
      setUnarchiveNotice({ kind: "success", session });
      unarchiveNoticeTimer.current = window.setTimeout(dismissUnarchiveNotice, 3000);
    } catch (reason) {
      setUnarchiveNotice(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const dismissUnarchiveNotice = () => {
    if (unarchiveNoticeTimer.current !== undefined) window.clearTimeout(unarchiveNoticeTimer.current);
    setUnarchiveNotice((current) => (current ? { ...current, closing: true } : null));
    unarchiveNoticeTimer.current = window.setTimeout(() => setUnarchiveNotice(null), 180);
  };

  const dismissDeleteSuccessNotice = () => {
    if (deleteSuccessNoticeTimer.current !== undefined) window.clearTimeout(deleteSuccessNoticeTimer.current);
    setDeleteSuccessNotice((current) => (current ? { closing: true } : null));
    deleteSuccessNoticeTimer.current = window.setTimeout(() => setDeleteSuccessNotice(null), 180);
  };

  const showDeleteSuccessNotice = () => {
    if (deleteSuccessNoticeTimer.current !== undefined) window.clearTimeout(deleteSuccessNoticeTimer.current);
    setDeleteSuccessNotice({});
    deleteSuccessNoticeTimer.current = window.setTimeout(dismissDeleteSuccessNotice, 3000);
  };

  const deleteArchived = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setError(null);
    try {
      if (deleteTarget.kind === "session") {
        await archiveHost.request("sessions.delete-archived", { sessionId: deleteTarget.sessionId });
      } else if (deleteTarget.kind === "project") {
        await archiveHost.request("sessions.delete-archived-in-project", { projectId: deleteTarget.projectId });
      } else {
        await archiveHost.request("sessions.delete-archived-all");
      }
      await refresh();
      setDeleteTarget(null);
      showDeleteSuccessNotice();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const getDeleteCount = (target: DeleteTarget): number => {
    if (target.kind === "all") return allArchived.length;
    if (target.kind === "session") return allArchived.some((session) => session.id === target.sessionId) ? 1 : 0;
    return allArchived.filter((session) => session.projectId === target.projectId).length;
  };

  const getDeleteTitle = (target: DeleteTarget): string => {
    if (target.kind === "all") return i18n.t("删除所有已归档的聊天？");
    if (target.kind === "session") return i18n.t("删除这条聊天？");
    return i18n.t("删除该项目中的所有聊天？");
  };

  const getDeleteDescription = (target: DeleteTarget): string => {
    const count = getDeleteCount(target);
    if (target.kind === "all")
      return i18n.t("这将永久删除 {{count}} 条 Vagus 聊天记录及其对应的 Pi 原生会话文件，无法撤销。", { count });
    if (target.kind === "session") return i18n.t("这将永久删除 Vagus 聊天记录及对应的 Pi 原生会话文件，无法撤销。");
    return i18n.t("这将永久删除此项目中的 {{count}} 条 Vagus 聊天记录及其对应的 Pi 原生会话文件，无法撤销。", {
      count,
    });
  };

  return (
    <div className="archive-settings-shell">
      <aside className="archive-settings-sidebar">
        <div className="archive-settings-heading">
          <h1>{i18n.t("设置")}</h1>
        </div>
        <div className="archive-settings-nav-group">
          <span>{i18n.t("基础设置")}</span>
          <button
            className={settingsPage === "general" ? "is-active" : ""}
            aria-current={settingsPage === "general" ? "page" : undefined}
            onClick={() => setSettingsPage("general")}
          >
            <Settings2 size={17} />
            <span>{i18n.t("常规")}</span>
          </button>
          <button
            className={settingsPage === "appearance" ? "is-active" : ""}
            aria-current={settingsPage === "appearance" ? "page" : undefined}
            onClick={() => setSettingsPage("appearance")}
          >
            <Palette size={17} />
            <span>{i18n.t("外观")}</span>
          </button>
          <button
            className={settingsPage === "browser" ? "is-active" : ""}
            aria-current={settingsPage === "browser" ? "page" : undefined}
            onClick={() => setSettingsPage("browser")}
          >
            <Globe size={17} />
            <span>{i18n.t("浏览器设置")}</span>
          </button>
          <button
            className={settingsPage === "keyboard" ? "is-active" : ""}
            aria-current={settingsPage === "keyboard" ? "page" : undefined}
            onClick={() => setSettingsPage("keyboard")}
          >
            <Keyboard size={17} />
            <span>{i18n.t("键盘快捷键")}</span>
          </button>
        </div>
        <div className="archive-settings-nav-group">
          <span>Agent</span>
          <button
            className={settingsPage === "providers" ? "is-active" : ""}
            aria-current={settingsPage === "providers" ? "page" : undefined}
            onClick={() => setSettingsPage("providers")}
          >
            <Bot size={17} />
            <span>{i18n.t("提供方")}</span>
          </button>
        </div>
        <div className="archive-settings-nav-group">
          <span>{i18n.t("已归档")}</span>
          <button
            className={settingsPage === "archive" ? "is-active" : ""}
            aria-current={settingsPage === "archive" ? "page" : undefined}
            onClick={() => setSettingsPage("archive")}
          >
            <Archive size={17} />
            <span>{i18n.t("已归档的聊天")}</span>
          </button>
        </div>
      </aside>

      <main className="archive-settings-main">
        {settingsPage === "general" ? (
          <div className="archive-settings-content general-settings-content">
            <div className="archive-page-heading">
              <div>
                <h2>{i18n.t("常规")}</h2>
                <p className="general-settings-intro">{i18n.t("管理界面语言、网络连接、桌面行为和本地数据。")}</p>
              </div>
            </div>
            {!settingsLoaded ? (
              <div className="general-settings-loading">
                <LoaderCircle className="archive-toast-spinner" size={17} />
                {i18n.t("正在读取设置…")}
              </div>
            ) : (
              <>
                <section className="general-settings-section" aria-label={i18n.t("语言与网络")}>
                  <header>
                    <span>{i18n.t("语言与网络")}</span>
                  </header>
                  <div className="general-setting-row">
                    <span className="general-setting-icon">
                      <Languages size={17} />
                    </span>
                    <span className="general-setting-copy">
                      <strong>{i18n.t("界面语言")}</strong>
                      <small>{i18n.t("选择 Vagus 所有界面文案的显示语言。Agent 生成的消息保持原有语言。")}</small>
                    </span>
                    <SettingSelect
                      label={i18n.t("界面语言")}
                      value={appSettings.interfaceLanguage}
                      onChange={(value) => updateAppSetting("interfaceLanguage", value)}
                      options={[{ value: "system", label: i18n.t("系统默认") }, ...interfaceLanguages]}
                    />
                  </div>
                  <div className="general-setting-row general-setting-proxy">
                    <span className="general-setting-icon">
                      <Globe size={17} />
                    </span>
                    <label className="general-setting-copy" htmlFor="general-http-proxy">
                      <strong>{i18n.t("HTTP 代理")}</strong>
                      <small>
                        {i18n.t(
                          "模型、MCP、命令工具与应用渲染层的出口流量将经此代理，不读取系统环境变量。留空时这些流量直连，内置浏览器则跟随系统代理设置。修改后需重启应用生效。",
                        )}
                      </small>
                      <input
                        id="general-http-proxy"
                        value={appSettings.httpProxy}
                        onChange={(event) => updateAppSetting("httpProxy", event.target.value)}
                        placeholder="http://127.0.0.1:7890"
                        spellCheck={false}
                      />
                    </label>
                  </div>
                </section>

                <section className="general-settings-section" aria-label={i18n.t("桌面行为")}>
                  <header>
                    <span>{i18n.t("桌面行为")}</span>
                  </header>
                  <SettingToggle
                    icon={<Bell size={17} />}
                    title={i18n.t("任务通知")}
                    description={i18n.t("Agent 完成任务或遇到错误时发送桌面通知。")}
                    checked={appSettings.taskNotifications}
                    onChange={(value) => updateAppSetting("taskNotifications", value)}
                  />
                  <SettingToggle
                    icon={<Volume2 size={17} />}
                    title={i18n.t("通知声音")}
                    description={i18n.t("收到任务通知时播放提示音。")}
                    checked={appSettings.notificationSound}
                    onChange={(value) => updateAppSetting("notificationSound", value)}
                  />
                  <SettingToggle
                    icon={<PanelTopClose size={17} />}
                    title={i18n.t("关闭窗口时隐藏到托盘")}
                    description={i18n.t("关闭窗口后继续在后台运行，可从系统托盘重新打开。")}
                    checked={appSettings.closeToTray}
                    onChange={(value) => updateAppSetting("closeToTray", value)}
                  />
                  <SettingToggle
                    icon={<Coffee size={17} />}
                    title={i18n.t("保持电脑运行")}
                    description={i18n.t("Vagus 运行期间阻止 Windows 自动进入睡眠。")}
                    checked={appSettings.keepAwake}
                    onChange={(value) => updateAppSetting("keepAwake", value)}
                  />
                </section>

                <section className="general-settings-section general-data-section" aria-label={i18n.t("数据存储")}>
                  <header>
                    <span>{i18n.t("数据存储")}</span>
                  </header>
                  <div className="general-setting-row general-data-row">
                    <span className="general-setting-icon">
                      <HardDrive size={17} />
                    </span>
                    <div className="general-setting-copy">
                      <strong>{i18n.t("数据存储路径")}</strong>
                      <small>
                        {i18n.t(
                          "应用数据根目录（默认为用户主目录）。修改后，现有数据会在重启时复制到该目录下固定的 .vagus/ 文件夹中。",
                        )}
                      </small>
                      <div className="general-path-control">
                        <div className="general-path-input-wrap">
                          <input
                            value={appSettings.dataDirectory}
                            onChange={(event) => updateAppSetting("dataDirectory", event.target.value)}
                            spellCheck={false}
                            aria-label={i18n.t("数据根目录")}
                          />
                          <span className="general-path-suffix" aria-hidden="true">
                            .vagus
                          </span>
                        </div>
                        <button
                          type="button"
                          className="general-secondary-button"
                          onClick={() => void chooseDataDirectory()}
                        >
                          {i18n.t("选择文件夹")}
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
                {settingsError && (
                  <div className="archive-error" role="alert">
                    <AlertCircle size={16} />
                    <span>{settingsError}</span>
                  </div>
                )}
                <footer className="general-settings-footer">
                  {settingsNotice && (
                    <span className="general-settings-saved">
                      <CheckCircle2 size={15} />
                      {settingsNotice}
                    </span>
                  )}
                  {restartRequired && (
                    <>
                      <span className="general-settings-restart-hint">{i18n.t("重启应用以使此更改生效。")}</span>
                      <button
                        type="button"
                        className="general-restart-button"
                        disabled={settingsSaving || settingsSaveTimerRef.current !== undefined}
                        onClick={() => void invoke("restart_app")}
                      >
                        {i18n.t("立即重启")}
                        <RotateCw size={14} />
                      </button>
                    </>
                  )}
                </footer>
              </>
            )}
          </div>
        ) : settingsPage === "appearance" ? (
          <div className="archive-settings-content general-settings-content appearance-settings-content">
            <div className="archive-page-heading">
              <div>
                <h2>{i18n.t("外观")}</h2>
                <p className="general-settings-intro">{i18n.t("设置界面主题、文字大小和代码显示方式。")}</p>
              </div>
            </div>
            {!settingsLoaded ? (
              <div className="general-settings-loading">
                <LoaderCircle size={17} className="archive-toast-spinner" />
                {i18n.t("正在读取设置…")}
              </div>
            ) : (
              <>
                <AppearanceSettingsPanel settings={appSettings} onChange={updateAppSetting} />
                {settingsError && (
                  <div className="archive-error" role="alert">
                    <AlertCircle size={16} />
                    <span>{settingsError}</span>
                  </div>
                )}
              </>
            )}
          </div>
        ) : settingsPage === "browser" ? (
          <div className="archive-settings-content general-settings-content browser-settings-content">
            <div className="archive-page-heading">
              <div>
                <h2>{i18n.t("浏览器设置")}</h2>
                <p className="general-settings-intro">{i18n.t("管理内置浏览器的安全选项和站点数据。")}</p>
              </div>
            </div>
            {!settingsLoaded ? (
              <div className="general-settings-loading">
                <LoaderCircle size={17} className="archive-toast-spinner" />
                {i18n.t("正在读取设置…")}
              </div>
            ) : (
              <>
                <section className="general-settings-section" aria-label={i18n.t("安全")}>
                  <header>
                    <span>{i18n.t("安全")}</span>
                  </header>
                  <SettingToggle
                    icon={<ShieldCheck size={17} />}
                    title={i18n.t("忽略证书校验")}
                    description={i18n.t(
                      "开启后内置浏览器不再校验 HTTPS 证书，仅影响内置浏览器。降低连接安全性，修改后需重启应用。",
                    )}
                    checked={appSettings.browserIgnoreCertificateErrors}
                    onChange={(value) => updateAppSetting("browserIgnoreCertificateErrors", value)}
                  />
                </section>
                <section className="general-settings-section" aria-label={i18n.t("浏览器数据")}>
                  <header>
                    <span>{i18n.t("浏览器数据")}</span>
                  </header>
                  <div className="general-setting-row">
                    <span className="general-setting-icon">
                      <Database size={17} />
                    </span>
                    <span className="general-setting-copy">
                      <strong>{i18n.t("清除所有浏览器数据")}</strong>
                      <small>{i18n.t("删除内置浏览器中的 Cookie、站点数据和缓存。此操作不可撤销。")}</small>
                    </span>
                    <button type="button" className="general-secondary-button" onClick={() => void clearBrowserData()}>
                      {i18n.t("清除全部")}
                    </button>
                  </div>
                </section>
                {settingsError && (
                  <div className="archive-error" role="alert">
                    <AlertCircle size={16} />
                    <span>{settingsError}</span>
                  </div>
                )}
                <footer className="general-settings-footer">
                  {settingsNotice && (
                    <span className="general-settings-saved">
                      <CheckCircle2 size={15} />
                      {settingsNotice}
                    </span>
                  )}
                  {restartRequired && (
                    <>
                      <span className="general-settings-restart-hint">{i18n.t("重启应用以使此更改生效。")}</span>
                      <button
                        type="button"
                        className="general-restart-button"
                        disabled={settingsSaving || settingsSaveTimerRef.current !== undefined}
                        onClick={() => void invoke("restart_app")}
                      >
                        {i18n.t("立即重启")}
                        <RotateCw size={14} />
                      </button>
                    </>
                  )}
                </footer>
              </>
            )}
          </div>
        ) : settingsPage === "keyboard" ? (
          <KeyboardShortcutsSettings
            overrides={appSettings.shortcutOverrides ?? {}}
            onChange={(overrides) => updateAppSetting("shortcutOverrides", overrides)}
            saving={settingsSaving}
            loaded={settingsLoaded}
            error={settingsError}
            notice={settingsNotice}
          />
        ) : settingsPage === "providers" ? (
          <>
            <div className="archive-settings-content provider-settings-content">
              <div className="archive-page-heading">
                <h2>{i18n.t("Agent 提供方")}</h2>
              </div>
              <section className="provider-settings-list" aria-label={i18n.t("Agent 提供方")}>
                {snapshot.providers.map((provider) => {
                  const catalog = modelCatalogs[provider.id];
                  const loading = modelsLoading[provider.id] || catalog?.status === "loading";
                  const hasError = Boolean(modelsErrors[provider.id] || catalog?.error || catalog?.status === "error");
                  const healthy =
                    (catalog?.status === "ready" && !catalog.stale && !hasError) || provider.health === "healthy";
                  const unavailable = hasError || provider.health === "unavailable";
                  const status =
                    loading || (!healthy && !unavailable)
                      ? i18n.t("正在检测")
                      : unavailable
                        ? i18n.t("检测异常")
                        : i18n.t("{{count}} 个模型", { count: catalog?.models.length ?? 0 });
                  return (
                    <div className="provider-list-row" key={provider.id}>
                      <button
                        className="provider-list-main"
                        onClick={() => {
                          ensureProviderModels(provider.id);
                          setModelSearch("");
                          setProviderTab("models");
                          setSelectedProviderId(provider.id);
                        }}
                      >
                        <span className="provider-settings-logo">
                          {provider.id === "pi" ? (
                            <PiIcon size={23} />
                          ) : provider.id === "claude" ? (
                            <ClaudeIcon size={23} />
                          ) : provider.id === "codex" ? (
                            <CodexIcon size={23} />
                          ) : provider.id === "opencode" ? (
                            <OpenCodeIcon size={23} />
                          ) : provider.id === "qoder" ? (
                            <QoderIcon size={23} />
                          ) : provider.id === "zcode" ? (
                            <ZCodeIcon size={23} />
                          ) : (
                            <Bot size={20} />
                          )}
                        </span>
                        <span className="provider-list-copy">
                          <strong>{provider.displayName}</strong>
                          <span className="provider-list-meta">Agent</span>
                        </span>
                        <span className={`provider-status ${healthy ? "is-connected" : unavailable ? "is-error" : ""}`}>
                          <i />
                          {status}
                        </span>
                      </button>
                      <button
                        className={`provider-enabled-toggle ${provider.enabled ? "is-enabled" : ""}`}
                        role="switch"
                        aria-checked={provider.enabled}
                        aria-label={`${i18n.t(provider.enabled ? "禁用" : "启用")} ${provider.displayName}`}
                        onClick={() => void setProviderEnabled(provider.id, !provider.enabled)}
                      >
                        <span />
                      </button>
                    </div>
                  );
                })}
                {snapshot.providers.length === 0 && (
                  <div className="provider-list-empty">{i18n.t("Host 尚未提供可用的 Agent。")}</div>
                )}
              </section>
              {error && (
                <div className="archive-error">
                  <AlertCircle size={16} />
                  <span>{error}</span>
                </div>
              )}
            </div>
            {selectedProvider && (
              <div
                className="provider-model-overlay"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) setSelectedProviderId(null);
                }}
              >
                <section
                  className="provider-model-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="provider-model-dialog-title"
                >
                  <header className="provider-dialog-header">
                    <div className="provider-dialog-brand">
                      <span className="provider-dialog-logo">
                        {selectedProvider.id === "pi" ? (
                          <PiIcon size={23} />
                        ) : selectedProvider.id === "claude" ? (
                          <ClaudeIcon size={23} />
                        ) : selectedProvider.id === "codex" ? (
                          <CodexIcon size={23} />
                        ) : selectedProvider.id === "opencode" ? (
                          <OpenCodeIcon size={23} />
                        ) : selectedProvider.id === "qoder" ? (
                          <QoderIcon size={23} />
                        ) : selectedProvider.id === "zcode" ? (
                          <ZCodeIcon size={23} />
                        ) : (
                          <Bot size={20} />
                        )}
                      </span>
                      <div>
                        <h2 id="provider-model-dialog-title">{selectedProvider.displayName}</h2>
                        <span>{i18n.t("本机配置")}</span>
                      </div>
                    </div>
                    <button
                      className="provider-dialog-close"
                      aria-label={i18n.t("关闭")}
                      onClick={() => setSelectedProviderId(null)}
                    >
                      <X size={18} />
                    </button>
                  </header>
                  {(selectedProvider.id === "pi" ||
                    selectedProvider.id === "claude" ||
                    selectedProvider.id === "codex") && (
                    <div className="provider-dialog-tabs" role="tablist" aria-label={i18n.t("提供方详情")}>
                      {(selectedProvider.id === "pi"
                        ? ["models", "extensions"]
                        : selectedProvider.id === "claude"
                          ? ["models", "plugins", "mcp"]
                          : ["models", "plugins"]
                      ).map((tab) => (
                        <button
                          type="button"
                          key={tab}
                          id={`provider-${tab}-tab`}
                          role="tab"
                          aria-selected={providerTab === tab}
                          aria-controls={`provider-${tab}-panel`}
                          tabIndex={providerTab === tab ? 0 : -1}
                          onClick={() => setProviderTab(tab as typeof providerTab)}
                          onKeyDown={(event) => {
                            if (
                              event.key === "ArrowLeft" ||
                              event.key === "ArrowRight" ||
                              event.key === "Home" ||
                              event.key === "End"
                            ) {
                              event.preventDefault();
                              const tabs: Array<typeof providerTab> =
                                selectedProvider.id === "pi"
                                  ? ["models", "extensions"]
                                  : selectedProvider.id === "claude"
                                    ? ["models", "plugins", "mcp"]
                                    : ["models", "plugins"];
                              const index = tabs.indexOf(providerTab);
                              const next =
                                event.key === "Home"
                                  ? tabs[0]!
                                  : event.key === "End"
                                    ? tabs[tabs.length - 1]!
                                    : tabs[
                                        (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length
                                      ]!;
                              setProviderTab(next);
                              document.getElementById(`provider-${next}-tab`)?.focus();
                            }
                          }}
                        >
                          {i18n.t(
                            tab === "models"
                              ? "模型"
                              : tab === "extensions"
                                ? "扩展"
                                : tab === "plugins"
                                  ? "插件"
                                  : "MCP 服务",
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  {providerTab === "extensions" && selectedProvider.id === "pi" ? (
                    <ProviderExtensions client={archiveHost} providerId={selectedProvider.id} />
                  ) : providerTab === "plugins" &&
                    (selectedProvider.id === "claude" || selectedProvider.id === "codex") ? (
                    <ProviderPlugins client={archiveHost} providerId={selectedProvider.id} />
                  ) : providerTab === "mcp" && selectedProvider.id === "claude" ? (
                    <ProviderMcpServers client={archiveHost} providerId={selectedProvider.id} />
                  ) : (
                    <section
                      className="provider-model-panel"
                      id="provider-models-panel"
                      role="tabpanel"
                      aria-labelledby="provider-models-tab"
                    >
                      <div className="provider-dialog-controls">
                        <label className="provider-model-search">
                          <Search size={16} />
                          <input
                            autoFocus
                            value={modelSearch}
                            onChange={(event) => setModelSearch(event.target.value)}
                            placeholder={i18n.t("搜索模型名称或 ID")}
                            aria-label={i18n.t("搜索模型")}
                          />
                        </label>
                        <button
                          className="provider-refresh-button"
                          disabled={selectedModelsLoading}
                          onClick={() => void refreshModels(selectedProvider.id, true)}
                          title={i18n.t("刷新模型目录")}
                        >
                          <RefreshCw size={14} className={selectedModelsLoading ? "is-spinning" : ""} />
                          <span>{i18n.t("刷新")}</span>
                        </button>
                      </div>
                      {selectedModelsError && (
                        <div className="provider-model-error" role="alert">
                          <AlertCircle size={15} />
                          <span>
                            {selectedCatalog?.models.length ? (
                              <>
                                {i18n.t("目录暂时无法更新，仍显示上次结果")}
                                <br />
                                <small>{selectedModelsError}</small>
                              </>
                            ) : (
                              selectedModelsError
                            )}
                          </span>
                          <button
                            disabled={selectedModelsLoading}
                            onClick={() => void refreshModels(selectedProvider.id, true)}
                          >
                            {i18n.t("重试")}
                          </button>
                        </div>
                      )}
                      {selectedCatalog?.executablePath && (
                        <div className="provider-executable-location">
                          <span>{i18n.t(selectedCatalog.stale ? "上次成功的可执行文件" : "当前可执行文件")}</span>
                          <code title={selectedCatalog.executablePath}>{selectedCatalog.executablePath}</code>
                          {selectedCatalog.executableSource && <small>{selectedCatalog.executableSource}</small>}
                        </div>
                      )}
                      <div className="provider-dialog-list-label">
                        <span>{i18n.t("已发现")}</span>
                        <span>{selectedCatalog?.status === "ready" ? selectedCatalog.models.length : "—"}</span>
                      </div>
                      <div className="provider-model-list" aria-live="polite">
                        {(!selectedCatalog || selectedCatalog.status === "loading") &&
                        !selectedCatalog?.models.length ? (
                          <div className="provider-model-empty">
                            <LoaderCircle className="archive-toast-spinner" size={17} />
                            <span>
                              {i18n.t("正在连接")}
                              {selectedProvider.displayName}…
                            </span>
                          </div>
                        ) : filteredModels.length === 0 && !modelSearch.trim() ? (
                          <ProviderSetupGuide providerId={selectedProvider.id} />
                        ) : filteredModels.length === 0 ? (
                          <div className="provider-model-empty">
                            <span>
                              {modelSearch.trim()
                                ? i18n.t("没有匹配的模型。")
                                : (selectedModelsError ?? i18n.t("当前没有可显示的模型。"))}
                            </span>
                          </div>
                        ) : (
                          groupedModels.map((group) => (
                            <section className="provider-model-group" key={group.source}>
                              <header className="provider-model-group-heading">
                                <strong>{group.source}</strong>
                                <span>{group.models.length}</span>
                              </header>
                              {group.models.map((model) => (
                                <article className="provider-model-row" key={model.id}>
                                  <div className="provider-model-row-main">
                                    <strong>{model.name}</strong>
                                  </div>
                                  <code title={model.id}>{model.id}</code>
                                </article>
                              ))}
                            </section>
                          ))
                        )}
                      </div>
                      <footer className="provider-model-footer">
                        <span>
                          {selectedCatalog?.fetchedAt
                            ? modelCatalogUpdatedAt(selectedCatalog.fetchedAt)
                            : i18n.t("模型由 Agent 本地配置提供")}
                        </span>
                        {selectedCatalog?.stale && <span className="provider-cache-label">{i18n.t("缓存目录")}</span>}
                        {selectedModelsLoading && <span className="provider-syncing">{i18n.t("同步中")}</span>}
                      </footer>
                    </section>
                  )}
                </section>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="archive-settings-content">
              <div className="archive-page-heading">
                <h2>{i18n.t("已归档的聊天")}</h2>
                <button
                  className="archive-delete-all"
                  disabled={busy || allArchived.length === 0}
                  onClick={() => setDeleteTarget({ kind: "all" })}
                >
                  <Trash2 size={16} />
                  {i18n.t("全部删除")}
                </button>
              </div>
              <div className="archive-filters">
                <label className="archive-search">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={i18n.t("搜索已归档的聊天")}
                  />
                </label>
                <div className="archive-project-filter" ref={projectFilterRef}>
                  <button
                    className="archive-project-filter-trigger"
                    aria-label={i18n.t("按项目筛选")}
                    aria-haspopup="listbox"
                    aria-expanded={projectFilterOpen}
                    onClick={() => setProjectFilterOpen((open) => !open)}
                  >
                    <Folder size={17} />
                    <span>
                      {snapshot.projects.find((project) => project.id === projectFilter)?.name ?? i18n.t("所有项目")}
                    </span>
                    <ChevronDown size={15} />
                  </button>
                  {projectFilterOpen && (
                    <div className="archive-project-filter-menu" role="listbox" aria-label={i18n.t("选择项目")}>
                      <button
                        role="option"
                        aria-selected={projectFilter === "all"}
                        onClick={() => {
                          setProjectFilter("all");
                          setProjectFilterOpen(false);
                        }}
                      >
                        <span>{i18n.t("所有项目")}</span>
                        {projectFilter === "all" && <Check size={17} />}
                      </button>
                      <button
                        role="option"
                        aria-selected={projectFilter === ""}
                        onClick={() => {
                          setProjectFilter("");
                          setProjectFilterOpen(false);
                        }}
                      >
                        <span>{i18n.t("不在项目中")}</span>
                        {projectFilter === "" && <Check size={17} />}
                      </button>
                      {snapshot.projects.map((project) => (
                        <button
                          key={project.id}
                          role="option"
                          aria-selected={projectFilter === project.id}
                          onClick={() => {
                            setProjectFilter(project.id);
                            setProjectFilterOpen(false);
                          }}
                        >
                          <Folder size={17} />
                          <span>{project.name}</span>
                          {projectFilter === project.id && <Check size={17} />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {error && (
                <div className="archive-error">
                  <AlertCircle size={16} />
                  <span>{error}</span>
                </div>
              )}
              <div className="archive-project-list">
                {searchResults.loading ? (
                  <div className="archive-empty">
                    <LoaderCircle className="archive-toast-spinner" size={20} />
                    <strong>{i18n.t("搜索中…")}</strong>
                  </div>
                ) : groupedArchived.length === 0 ? (
                  <div className="archive-empty">
                    <Archive size={23} />
                    <strong>{allArchived.length ? i18n.t("没有符合条件的聊天") : i18n.t("没有已归档的聊天")}</strong>
                    <span>
                      {allArchived.length ? i18n.t("尝试更改搜索内容或筛选条件。") : i18n.t("归档的聊天会显示在这里。")}
                    </span>
                  </div>
                ) : (
                  groupedArchived.map(({ projectId, project, sessions }) => (
                    <section className="archive-project-group" key={projectId}>
                      <header className="archive-project-heading">
                        <Folder size={18} />
                        <strong>{project?.name ?? i18n.t("无项目")}</strong>
                        <span>{i18n.t("{{count}} 个聊天", { count: sessions.length })}</span>
                        {project && (
                          <div className="archive-project-menu-wrap">
                            <button
                              className="archive-project-menu-trigger"
                              aria-label={i18n.t("{{name}} 的归档选项", { name: project.name })}
                              aria-expanded={projectMenuId === project.id}
                              onClick={() =>
                                setProjectMenuId((current) => (current === project.id ? null : project.id))
                              }
                            >
                              <Ellipsis size={15} />
                            </button>
                            {projectMenuId === project.id && (
                              <>
                                <button
                                  className="archive-menu-dismiss"
                                  aria-label={i18n.t("关闭菜单")}
                                  onClick={() => setProjectMenuId(null)}
                                />
                                <div className="archive-project-menu">
                                  <button
                                    onClick={() => {
                                      setProjectMenuId(null);
                                      setDeleteTarget({ kind: "project", projectId: project.id });
                                    }}
                                  >
                                    <Trash2 size={16} />
                                    <span>{i18n.t("删除项目中的全部内容")}</span>
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </header>
                      <div className="archive-chat-list">
                        {sessions.map((session) => (
                          <article className="archive-chat-row" key={session.id}>
                            <div className="archive-chat-copy">
                              <strong>{session.title}</strong>
                              <time dateTime={session.archivedAt}>{archivedDate(session.archivedAt ?? "")}</time>
                            </div>
                            <div className="archive-chat-actions">
                              <button
                                className="archive-chat-delete-icon"
                                title={i18n.t("永久删除聊天")}
                                aria-label={i18n.t("永久删除：{{title}}", { title: session.title })}
                                disabled={busy}
                                onClick={() => setDeleteTarget({ kind: "session", sessionId: session.id })}
                              >
                                <Trash2 size={17} />
                              </button>
                              <button
                                className="archive-chat-restore"
                                disabled={busy}
                                onClick={() => void unarchiveSession(session)}
                              >
                                {i18n.t("取消归档")}
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>
                  ))
                )}
                {searchResults.hasMore && (
                  <button
                    className="archive-search-load-more"
                    disabled={searchResults.loadingMore}
                    onClick={searchResults.loadMore}
                  >
                    {i18n.t(searchResults.loadingMore ? "正在加载…" : "加载更多结果")}
                  </button>
                )}
              </div>
            </div>
            {unarchiveNotice && (
              <div
                className={`archive-toast ${unarchiveNotice.kind === "success" ? "is-success" : "is-pending"} ${unarchiveNotice.closing ? "is-exiting" : ""}`}
                role="status"
                aria-live="polite"
              >
                {unarchiveNotice.kind === "pending" ? (
                  <>
                    <LoaderCircle className="archive-toast-spinner" size={17} />
                    <span>{i18n.t("正在取消聊天归档…")}</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={17} />
                    <span>{i18n.t("聊天已恢复")}</span>
                    <button
                      className="archive-toast-view"
                      onClick={() => {
                        const session = unarchiveNotice.session;
                        dismissUnarchiveNotice();
                        onViewSession(session);
                      }}
                    >
                      {i18n.t("查看")}
                    </button>
                    <button
                      className="archive-toast-close"
                      aria-label={i18n.t("关闭")}
                      title={i18n.t("关闭")}
                      onClick={dismissUnarchiveNotice}
                    >
                      <X size={15} />
                    </button>
                  </>
                )}
              </div>
            )}
            {deleteSuccessNotice && (
              <div
                className={`archive-toast is-success ${deleteSuccessNotice.closing ? "is-exiting" : ""}`}
                role="status"
                aria-live="polite"
              >
                <CheckCircle2 size={17} />
                <span>{i18n.t("已删除已归档的聊天")}</span>
                <button
                  className="archive-toast-close"
                  aria-label={i18n.t("关闭")}
                  title={i18n.t("关闭")}
                  onClick={dismissDeleteSuccessNotice}
                >
                  <X size={15} />
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {settingsPage === "archive" && deleteTarget && (
        <div
          className="overlay archive-confirm-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setDeleteTarget(null);
          }}
        >
          <section
            className="archive-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="archive-delete-title"
            aria-describedby="archive-delete-description"
          >
            <header>
              <h2 id="archive-delete-title">{getDeleteTitle(deleteTarget)}</h2>
              <button
                title={i18n.t("关闭")}
                aria-label={i18n.t("关闭")}
                disabled={busy}
                onClick={() => setDeleteTarget(null)}
              >
                <X size={18} />
              </button>
            </header>
            <p id="archive-delete-description">{getDeleteDescription(deleteTarget)}</p>
            <footer>
              <button className="cancel-button" disabled={busy} onClick={() => setDeleteTarget(null)}>
                {i18n.t("取消")}
              </button>
              <button
                className="archive-delete-confirm"
                disabled={busy || getDeleteCount(deleteTarget) === 0}
                onClick={() => void deleteArchived()}
              >
                {busy ? i18n.t("正在删除…") : i18n.t("删除")}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
