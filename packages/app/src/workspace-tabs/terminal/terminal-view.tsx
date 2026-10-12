import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Check, LoaderCircle, Pencil, RefreshCw, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AsyncScope } from "../../lib/async-scope.js";
import i18n from "../../locales/i18n.js";

type TerminalPayload = { terminalId: string; data: string };
type TerminalExitPayload = { terminalId: string; code: number | null };

function getTerminalTheme(): ITheme {
  const root = document.documentElement;
  const terminalSurface = getComputedStyle(root).getPropertyValue("--surface").trim() || "#151619";
  return root.dataset.theme === "light"
    ? { background: terminalSurface, foreground: "#252a32", cursor: "#394757", selectionBackground: "#dce5ee", black: "#242831", red: "#c33f46", green: "#21804c", yellow: "#987015", blue: "#3269bd", magenta: "#8751a7", cyan: "#197c91", white: "#606b7a", brightBlack: "#6e7581", brightRed: "#dc555b", brightGreen: "#35a66a", brightYellow: "#b78b21", brightBlue: "#5486d3", brightMagenta: "#a86ac7", brightCyan: "#28a1b6", brightWhite: "#465160" }
    : { background: terminalSurface, foreground: "#e4e6eb", cursor: "#72a3ff", selectionBackground: "#315d9a", black: "#17181c", red: "#e35d66", green: "#49bd7c", yellow: "#dfb84c", blue: "#70a0f4", magenta: "#c27dd8", cyan: "#5fc4d4", white: "#d8dbe2", brightBlack: "#858a96", brightRed: "#f17880", brightGreen: "#62d390", brightYellow: "#f0cb67", brightBlue: "#8ab4ff", brightMagenta: "#d997eb", brightCyan: "#79d7e4", brightWhite: "#ffffff" };
}

export type TerminalViewProps = { terminalId: string; label: string; cwd: string | null; visible: boolean; onRename?(name: string): void; onShowTooltip?(event: React.MouseEvent<HTMLElement>, label: string): void; onHideTooltip?(): void };
export function TerminalView({ terminalId, label, cwd, visible, onRename, onShowTooltip, onHideTooltip }: TerminalViewProps) {
  useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<"starting" | "ready" | "error" | "exited">("starting");
  const [error, setError] = useState("");
  const [restart, setRestart] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(label);
  const [mountId] = useState(() => crypto.randomUUID());
  const processId = `${terminalId}-${restart}-${mountId}`;

  useEffect(() => { if (!renaming) setDraftName(label); }, [label, renaming]);
  const saveName = () => { onRename?.(draftName); setRenaming(false); };
  const cancelRename = () => { setDraftName(label); setRenaming(false); };

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    const processId = `${terminalId}-${restart}-${crypto.randomUUID()}`;
    let disposed = false;
    const scope = new AsyncScope();
    let observer: ResizeObserver | undefined;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: getTerminalTheme(),
    });
    const themeObserver = new MutationObserver(() => { terminal.options.theme = getTerminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const fitTerminal = () => {
      if (!container.clientWidth || !container.clientHeight) return;
      try {
        fit.fit();
        void invoke("terminal_resize", { terminalId: processId, cols: terminal.cols, rows: terminal.rows }).catch(() => { });
      } catch { /* The terminal will fit on the next visible resize. */ }
    };
    observer = new ResizeObserver(fitTerminal);
    observer.observe(container);
    const input = terminal.onData((data) => { void invoke("terminal_write", { terminalId: processId, data }).catch((reason: unknown) => { if (!disposed) { setError(String(reason)); setStatus("error"); } }); });
    const start = async () => {
      try {
        await scope.acquire(() => listen<TerminalPayload>("terminal-output", (event) => {
          if (!disposed && event.payload.terminalId === processId) terminal.write(event.payload.data);
        }), unlisten => unlisten());
        if (disposed) return;
        await scope.acquire(() => listen<TerminalExitPayload>("terminal-exit", (event) => {
          if (event.payload.terminalId === processId && !disposed) { setStatus("exited"); terminal.write(`\r\n\x1b[90m${i18n.t("终端进程已退出（代码 {{code}}）", { code: event.payload.code ?? "?" })}\x1b[0m\r\n`); }
        }), unlisten => unlisten());
        if (disposed) return;
        await scope.acquire(() => invoke("terminal_create", { terminalId: processId, cwd, cols: 100, rows: 30 }), () => invoke("terminal_close", { terminalId: processId }).catch(() => { }));
        if (disposed) return;
        setStatus("ready");
        fitTerminal();
        terminal.focus();
      } catch (reason) {
        if (!disposed) { setError(String(reason)); setStatus("error"); }
        await scope.dispose();
      }
    };
    void start();
    return () => {
      disposed = true;
      observer?.disconnect();
      themeObserver.disconnect();
      input.dispose();
      void scope.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [processId, cwd]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch { /* Retry automatically when the terminal host resizes. */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return <div className="workspace-terminal-content">
    <div className="terminal-toolbar"><div className="terminal-toolbar-title"><SquareTerminal size={15} />{renaming ? <form className="terminal-name-editor" onSubmit={event => { event.preventDefault(); saveName(); }}><input autoFocus value={draftName} maxLength={40} aria-label={i18n.t("终端名称")} placeholder={i18n.t("终端名称")} onChange={event => setDraftName(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancelRename(); } }} /><button type="submit" aria-label={i18n.t("保存")} title={i18n.t("保存")}><Check size={14} /></button><button type="button" aria-label={i18n.t("取消")} title={i18n.t("取消")} onClick={cancelRename}><X size={14} /></button></form> : <><span className="terminal-title-name">{label}</span><button type="button" className="terminal-rename-button" aria-label={i18n.t("重命名终端")} onMouseEnter={event => onShowTooltip?.(event, i18n.t("重命名终端"))} onMouseLeave={onHideTooltip} onClick={() => { onHideTooltip?.(); setRenaming(true); }}><Pencil size={13} /></button>{cwd && <span className="terminal-cwd" title={cwd}>· {cwd}</span>}</>}</div><div className="terminal-toolbar-actions"><span className={`terminal-status is-${status}`} aria-live="polite">{status === "starting" ? <><LoaderCircle size={13} />{i18n.t("正在启动")}</> : status === "ready" ? i18n.t("运行中") : status === "exited" ? i18n.t("已退出") : i18n.t("启动失败")}</span><button type="button" aria-label={i18n.t("重启终端")} title={i18n.t("重启终端")} onClick={() => { setError(""); setStatus("starting"); setRestart((value) => value + 1); }}><RefreshCw size={14} /></button></div></div>
    {status === "error" && <div className="terminal-error" role="alert">{error}</div>}
    <div ref={hostRef} className="terminal-host" onMouseDown={() => terminalRef.current?.focus()} />
  </div>;
}
