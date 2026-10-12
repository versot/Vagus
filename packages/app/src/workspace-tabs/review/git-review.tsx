import type { HostClient } from "@vagus/client";
import type { GitReview, GitReviewScope, ReviewFile, ReviewPatch, TurnReviewSnapshot } from "@vagus/protocol";
import { ChevronDown, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingSelect } from "../../features/settings/setting-select.js";
import i18n from "../../locales/i18n.js";

type DiffRow = { kind: "added" | "deleted" | "context" | "hunk" | "fold"; text: string; oldNumber?: number; newNumber?: number; hiddenCount?: number };

function parseDiffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNumber = 1, newNumber = 1, previousHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      const oldStart = Number(hunk[1]), newStart = Number(hunk[3]);
      const gap = Math.max(0, oldStart - oldNumber, newStart - newNumber);
      if (gap) rows.push({ kind: "fold", text: "", hiddenCount: gap });
      oldNumber = oldStart; newNumber = newStart; previousHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!previousHunk || line.startsWith("\\ No newline at end of file") || line === "") continue;
    if (line.startsWith("+")) rows.push({ kind: "added", text: line.slice(1), newNumber: newNumber++ });
    else if (line.startsWith("-")) rows.push({ kind: "deleted", text: line.slice(1), oldNumber: oldNumber++ });
    else if (line.startsWith(" ")) rows.push({ kind: "context", text: line.slice(1), oldNumber: oldNumber++, newNumber: newNumber++ });
  }
  return rows;
}

function DiffContent({ data }: { data: ReviewPatch }) {
  const notices = { binary: "二进制文件，无法显示文本差异", "too-large": "文件差异过大，无法在此展开", unsupported: "此文件类型暂不支持预览", changed: "文件状态已变化，请刷新列表" };
  const rows = parseDiffRows(data.patch);
  return data.unavailable ? <p className="git-review-notice">{i18n.t(notices[data.unavailable])}</p> : data.patch ? <>
    <div className="git-review-diff" role="table" aria-label={i18n.t("文件差异")}>
      {rows.slice(0, 3000).map((row, index) => row.kind === "fold"
        ? <div className="git-review-diff-fold" role="row" key={`fold-${index}`}><span role="cell">{i18n.t("{{count}} 行未修改", { count: row.hiddenCount })}</span></div>
        : <div className={`git-review-diff-row is-${row.kind}`} role="row" key={`line-${index}`}>
          <span className="git-review-line-number" role="cell">{row.kind === "deleted" ? row.oldNumber ?? "" : row.newNumber ?? row.oldNumber ?? ""}</span>
          <span className="git-review-line-marker" role="cell">{row.kind === "added" ? "+" : row.kind === "deleted" ? "−" : row.kind === "context" ? " " : ""}</span><code role="cell">{row.text || " "}</code>
        </div>)}
    </div>
    {rows.length > 3000 && <p className="git-review-notice">{i18n.t("差异较长，仅展示前 3000 行")}</p>}
  </> : <p className="git-review-notice">{i18n.t("无文本差异")}</p>;
}

function ReviewFileRow({ file, load, initiallyOpen = false, selected = false }: { file: ReviewFile; load(): Promise<ReviewPatch>; initiallyOpen?: boolean; selected?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [mounted, setMounted] = useState(initiallyOpen);
  const [contentHeight, setContentHeight] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [patch, setPatch] = useState<ReviewPatch | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!initiallyOpen) return;
    setOpen(true);
    setMounted(true);
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [initiallyOpen]);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!mounted || !content) return;
    // Measure the natural body, including the asynchronous loading-to-diff change.
    const measure = () => setContentHeight(Math.ceil(content.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [mounted]);
  useEffect(() => {
    if (!open || patch) return;
    let active = true;
    void load().then((data) => { if (active) setPatch(data); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [open]);
  const separator = file.path.lastIndexOf("/");
  const basename = file.path.slice(separator + 1);
  const extension = basename.includes(".") ? basename.split(".").at(-1)!.slice(0, 4).toUpperCase() : "FILE";
  const typeClass = extension.toLowerCase().replace(/[^a-z0-9-]/g, "") || "file";
  return <div ref={rowRef} className={`git-review-file${selected ? " is-selected" : ""}`}>
    <button className="git-review-file-heading" aria-expanded={open} aria-controls={contentId} onClick={() => { if (!open) setMounted(true); setError(false); setOpen((value) => !value); }} title={file.path}>
      <span className={`git-review-file-type is-${typeClass}`} aria-hidden="true">{extension}</span><span className="git-review-file-path"><span className="git-review-file-directory">{file.path.slice(0, separator + 1)}</span><span className="git-review-file-name">{basename}</span></span>
      <span className="git-review-counts">{file.status === "untracked" ? <small>{i18n.t("新文件")}</small> : file.additions === null ? <small>{i18n.t("二进制")}</small> : <><b className="is-added">+{file.additions}</b><b className="is-deleted">-{file.deletions}</b></>}</span><ChevronDown size={13} className={open ? "is-open" : ""} />
    </button>
    <div id={contentId} className={`git-review-file-reveal${open ? " is-open" : ""}`} style={{ height: open ? contentHeight : 0 }} aria-hidden={!open} inert={!open} onTransitionEnd={(event) => { if (event.target === event.currentTarget && event.propertyName === "height" && !open) setMounted(false); }}>
      {mounted && <div ref={contentRef} className="git-review-file-reveal-content">{patch ? <DiffContent data={patch} /> : <p className="git-review-notice" role={error ? "alert" : "status"}>{error ? i18n.t("读取差异失败，请收起后重试") : i18n.t("正在读取差异…")}</p>}</div>}
    </div>
  </div>;
}

export function GitReviewContent({ host, projectId, visible }: { host: HostClient; projectId: string | null; visible: boolean }) {
  useTranslation();
  const [scope, setScope] = useState<GitReviewScope>("unstaged");
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<GitReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!visible) return;
    if (!projectId) { setData({ state: "no-project", scope, files: [] }); setLoading(false); setFailed(false); return; }
    let active = true;
    setLoading(true); setFailed(false); setData(null);
    void host.request("workspace.git-review", { projectId, scope }).then((result) => { if (active) setData(result); }).catch(() => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [host, projectId, scope, revision, visible]);
  const message = failed ? "读取 Git 改动失败，请刷新重试" : loading ? "正在读取 Git 改动…" : data?.state === "no-project" ? "此会话未关联项目" : data?.state === "not-repository" ? "此项目不是 Git 仓库" : data?.state === "git-unavailable" ? "未找到 Git，请安装后重启应用" : scope === "staged" ? "没有已暂存的改动" : "没有未暂存的改动";
  return <div className="git-review-content">
    <div className="git-review-toolbar"><SettingSelect<GitReviewScope> value={scope} onChange={(value) => { if (value !== scope) { setData(null); setLoading(true); setScope(value); } }} label={i18n.t("Git 改动范围")} options={[{ value: "unstaged", label: i18n.t("未暂存") }, { value: "staged", label: i18n.t("已暂存") }]} /><button className="git-review-refresh" disabled={loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} /><span>{i18n.t("刷新")}</span></button></div>
    <div className="git-review-files" aria-busy={loading}>
      {data?.state === "ready" && data.files.length ? data.files.map((file) => <ReviewFileRow key={`${projectId}:${scope}:${revision}:${file.path}`} file={file} load={() => host.request("workspace.git-patch", { projectId: projectId!, scope, path: file.path })} />) : <div className="git-review-empty" role={failed ? "alert" : "status"}>{loading && <LoaderCircle size={16} className="archive-toast-spinner" />}<span>{i18n.t(message)}</span></div>}
    </div>
  </div>;
}

/** Only renders captured turn data; no Git requests or index/worktree selectors. */
export function TurnReviewContent({ snapshot, selectedPath, truncated = false }: { snapshot: TurnReviewSnapshot; selectedPath?: string; truncated?: boolean }) {
  useTranslation();
  return <div className="git-review-content"><div className="git-review-toolbar"><span>{i18n.t("本轮 Agent 改动")}</span></div><div className="git-review-files">{snapshot.files.map((file) => <ReviewFileRow key={`${snapshot.turnId}:${file.path}`} file={file} load={() => Promise.resolve(file)} initiallyOpen={file.path === selectedPath} selected={file.path === selectedPath} />)}{truncated && <p className="git-review-notice">{i18n.t("差异过长，已截取前 500,000 个字符")}</p>}</div></div>;
}
