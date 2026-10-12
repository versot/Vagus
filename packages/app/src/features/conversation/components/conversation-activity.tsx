import { Brain, Check, ChevronDown, Circle, Eye, FileDiff, ListChecks, LoaderCircle, Pencil, Search, Square, SquareTerminal, TriangleAlert, Wrench } from "lucide-react";
import { useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CodeBlock, languageFromPath } from "../../../components/code-block.js";
import i18n from "../../../locales/i18n.js";
import { buildToolPresentation, formatToolValue, hasToolContent, hasToolInput, toolContentText, toolDiffBlocks, toolInputField, type ActivityIcon } from "../conversation-presentation.js";
import type { ChatPlan, ChatStatus, ChatTurnDiff, ToolActivity } from "../types.js";

const toolIcons = { search: Search, shell: SquareTerminal, read: Eye, edit: Pencil, write: Pencil, tool: Wrench };

function ActivityBadge({ label, summary, icon = "tool", thinking = false, active = false, failed = false, nested = false, lastInSequence = false, children, expanded: controlledExpanded, onToggle }: {
  label: string; summary?: string; icon?: ActivityIcon; thinking?: boolean; active?: boolean; failed?: boolean; nested?: boolean; lastInSequence?: boolean; children?: ReactNode; expanded?: boolean; onToggle?: () => void;
}) {
  useTranslation();
  const [localExpanded, setLocalExpanded] = useState(false);
  const detailId = useId();
  const Icon = failed ? TriangleAlert : thinking ? Brain : toolIcons[icon];
  const canExpand = Boolean(children || onToggle);
  const isExpanded = controlledExpanded ?? localExpanded;
  const toggle = onToggle ?? (() => setLocalExpanded((value) => !value));
  const classes = `conversation-activity${active ? " is-active" : ""}${failed ? " is-error" : ""}${nested ? " is-nested" : ""}${isExpanded ? " is-expanded" : ""}${lastInSequence ? " is-last-in-sequence" : ""}${canExpand ? " is-interactive" : ""}`;
  const state = i18n.t(failed ? "失败" : active ? "执行中" : "已完成");
  const shimmerDuration = Math.max(1, Math.min(2.3, 1.25 + (label.length + (summary?.length ?? 0)) * .008));
  const header = <>
    <span className="conversation-activity-icon" aria-hidden="true"><Icon className="activity-kind-icon" size={12} strokeWidth={1.5} /></span>
    <span className="conversation-activity-copy" style={{ "--activity-shimmer-duration": `${shimmerDuration}s` } as CSSProperties}>
      <span className="conversation-activity-label">{label}</span>{summary && <span className="conversation-activity-summary" title={summary}>{summary}</span>}
    </span>
  </>;
  return <div className={classes} role={thinking && active ? "status" : undefined}>
    {canExpand ? <button className="conversation-activity-header" aria-label={`${label}${summary ? ` ${summary}` : ""}，${state}`} aria-expanded={isExpanded} aria-controls={children ? detailId : undefined} onClick={toggle} onKeyDown={(event) => { if (event.key === "Escape" && isExpanded) { if (onToggle) onToggle(); else setLocalExpanded(false); } }}>{header}</button>
      : <div className="conversation-activity-header">{header}</div>}
    {children && isExpanded && <div className="conversation-activity-details" id={detailId}>{children}</div>}
  </div>;
}

export function ThinkingMarker({ status, active = false, lastInSequence = false, expanded, onToggle }: { status: ChatStatus; active?: boolean; lastInSequence?: boolean; expanded?: boolean; onToggle?: () => void }) {
  return <ActivityBadge label={status.text === "正在思考" ? "Thinking" : status.text} thinking active={active} lastInSequence={lastInSequence} expanded={expanded} onToggle={onToggle} />;
}

export function SubagentActivityLine({ status, lastInSequence = false, onCancel }: { status: ChatStatus; lastInSequence?: boolean; onCancel: (subagentSessionId: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [cancelling, setCancelling] = useState(false);
  const running = status.subagentState === "running";
  const canCancel = running && status.subagentCancellable && status.subagentSessionId;
  return <div className={`conversation-subagent${running ? " is-active" : ""}${lastInSequence ? " is-last-in-sequence" : ""}`}>
    <span className="conversation-activity-icon" aria-hidden="true"><Brain size={12} strokeWidth={1.5} /></span>
    <span className="conversation-subagent-text">{status.text}</span>
    {canCancel && <button type="button" className="conversation-subagent-cancel" aria-label={t("停止当前 Agent")} disabled={cancelling} onClick={() => {
      setCancelling(true);
      void onCancel(status.subagentSessionId!).finally(() => setCancelling(false));
    }}>{cancelling ? <span className="conversation-subagent-spinner" /> : <Square size={12} fill="currentColor" />}</button>}
  </div>;
}

export function PlanActivityLine({ plan }: { plan: ChatPlan }) {
  const { t } = useTranslation();
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  return <section className="conversation-plan" aria-label={t("执行计划")}>
    <header><ListChecks size={15} aria-hidden="true" /><strong>{t("执行计划")}</strong><span>{t("计划进度", { completed, total: plan.steps.length })}</span></header>
    {plan.explanation && <p className="conversation-plan-explanation">{plan.explanation}</p>}
    <ol>{plan.steps.map((step, index) => <li className={`is-${step.status}`} key={`${index}-${step.step}`}>
      <span className="conversation-plan-step-icon" aria-hidden="true">{step.status === "completed" ? <Check size={13} /> : step.status === "inProgress" ? <LoaderCircle size={13} className="conversation-plan-spinner" /> : <Circle size={12} />}</span>
      <span>{step.step}</span>
    </li>)}</ol>
  </section>;
}

export function TurnDiffActivityLine({ diff, active = false }: { diff: ChatTurnDiff; active?: boolean }) {
  const { t } = useTranslation();
  const lines = diff.diff.split("\n");
  const files = lines.filter((line) => line.startsWith("diff --git ") || line.startsWith("Index: ")).length || (diff.diff.trim() ? 1 : 0);
  const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removals = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const summary = diff.diff.trim() ? t("{{files}} 个文件 · +{{additions}} −{{removals}}", { files, additions, removals }) : t("没有文件差异");
  return <ActivityBadge label={t("本轮文件变更")} summary={summary} icon="edit" active={active} />;
}

export type TurnChangedFile = { path: string; additions: number; removals: number; patch?: string; patches?: string[]; details?: Array<{ oldText?: string; newText: string }> };

function unifiedTurnChanges(diff: ChatTurnDiff): TurnChangedFile[] {
  const files: TurnChangedFile[] = [];
  let current: TurnChangedFile | null = null;
  let patch: string[] = [];
  const finish = () => {
    if (!current) return;
    current.patch = patch.join("\n");
    files.push(current);
    current = null;
    patch = [];
  };
  for (const line of diff.diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = { path: match?.[2] ?? "文件变更", additions: 0, removals: 0 };
    }
    if (!current && (line.startsWith("Index: ") || line.startsWith("--- ") || line.startsWith("+++ "))) {
      const path = line.startsWith("Index: ") ? line.slice(7) : line.slice(6).replace(/^[ab]\//, "");
      if (path && path !== "/dev/null") current = { path, additions: 0, removals: 0 };
    }
    if (!current) continue;
    patch.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) current.removals++;
  }
  finish();
  if (!files.length && diff.diff.trim()) {
    const lines = diff.diff.split("\n");
    files.push({ path: "文件变更", additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length, removals: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length, patch: diff.diff });
  }
  return files;
}

function lineChangeCounts(oldText: string | undefined, newText: string): { additions: number; removals: number } {
  if (oldText === undefined) return { additions: newText.split("\n").length, removals: 0 };
  const before = oldText.split("\n");
  const after = newText.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { additions: after.length - prefix - suffix, removals: before.length - prefix - suffix };
}

export function turnChangedFiles(turnId: string, diff: ChatTurnDiff | undefined, activities: ToolActivity[]): TurnChangedFile[] {
  const fromTurnDiff = diff ? unifiedTurnChanges(diff) : [];
  if (fromTurnDiff.length) return fromTurnDiff;
  const files = new Map<string, TurnChangedFile>();
  const addChange = (path: string, oldText: string | undefined, newText: string) => {
    const counts = lineChangeCounts(oldText, newText);
    const file = files.get(path) ?? { path, additions: 0, removals: 0, details: [] };
    file.additions += counts.additions;
    file.removals += counts.removals;
    file.details!.push({ ...(oldText !== undefined ? { oldText } : {}), newText });
    files.set(path, file);
  };
  for (const activity of activities) {
    if (activity.turnId !== turnId || activity.state !== "done") continue;
    const blocks = toolDiffBlocks(activity);
    const structuredPaths = new Set(blocks.map((block) => block.path));
    for (const block of blocks) {
      addChange(block.path, block.oldText, block.newText);
    }
    const name = activity.name.toLowerCase().split(/[.:/]/).at(-1) ?? "";
    if (!/^(edit|edit_file|write|write_file|create|create_file|apply_patch|patch|filechange|file_change)$/.test(name) && activity.toolKind !== "edit") continue;
    const path = toolInputField(activity, ["path", "file_path", "filePath", "file"]);
    if (!path) continue;
    if (structuredPaths.has(path)) continue;
    const oldText = toolInputField(activity, ["oldText", "old_text", "old_string", "oldString"]);
    const newText = toolInputField(activity, ["newText", "new_text", "new_string", "newString", "content", "text"]);
    if (newText !== undefined) {
      addChange(path, oldText, newText);
      continue;
    }
    const input = typeof activity.input === "object" && activity.input !== null && !Array.isArray(activity.input) ? activity.input as Record<string, unknown> : undefined;
    const edits = input && Array.isArray(input.edits) ? input.edits : [];
    for (const edit of edits) {
      if (typeof edit !== "object" || edit === null || Array.isArray(edit)) continue;
      const row = edit as Record<string, unknown>;
      const next = typeof row.newText === "string" ? row.newText : typeof row.new_text === "string" ? row.new_text : typeof row.new_string === "string" ? row.new_string : undefined;
      if (next === undefined) continue;
      const previous = typeof row.oldText === "string" ? row.oldText : typeof row.old_text === "string" ? row.old_text : typeof row.old_string === "string" ? row.old_string : undefined;
      addChange(path, previous, next);
    }
    const patch = toolInputField(activity, ["patch", "diff"]);
    if (patch) {
      const lines = patch.replace(/\r\n?/gu, "\n").split("\n");
      const file = files.get(path) ?? { path, additions: 0, removals: 0, patches: [] };
      file.additions += lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
      file.removals += lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
      file.patches ??= [];
      file.patches.push(patch);
      files.set(path, file);
    }
  }
  return [...files.values()];
}

export function TurnChangesCard({ turnId, diff, activities, onOpenDiff }: { turnId: string; diff?: ChatTurnDiff; activities: ToolActivity[]; onOpenDiff?(files: TurnChangedFile[], selectedPath: string): void }) {
  const { t } = useTranslation();
  const [showAllFiles, setShowAllFiles] = useState(false);
  const files = useMemo(() => turnChangedFiles(turnId, diff, activities), [turnId, diff, activities]);
  if (!files.length) return null;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const removals = files.reduce((sum, file) => sum + file.removals, 0);
  const visibleFiles = showAllFiles ? files : files.slice(0, 3);
  return <section className="turn-changes-card" aria-label={t("本轮文件变更")}>
    <header className="turn-changes-header"><span className="turn-changes-icon"><FileDiff size={18} aria-hidden="true" /></span><span className="turn-changes-summary"><strong>{t("已编辑 {{count}} 个文件", { count: files.length })}</strong><span><b>+{additions}</b><i>−{removals}</i></span></span></header>
    <div className="turn-changes-files">{visibleFiles.map((file) => <button type="button" className="turn-changes-file" key={file.path} onClick={() => onOpenDiff?.(files, file.path)} title={t("查看变更")}><span title={file.path}>{file.path}</span><span><b>+{file.additions}</b><i>−{file.removals}</i></span></button>)}</div>
    {files.length > 3 && <button type="button" className="turn-changes-more" onClick={() => setShowAllFiles((value) => !value)}>{t(showAllFiles ? "收起" : "还有 {{count}} 个文件", { count: files.length - 3 })}<ChevronDown size={13} className={showAllFiles ? "is-open" : ""} aria-hidden="true" /></button>}
  </section>;
}

export function ToolActivityLine({ activity, lastInSequence = false, expanded, onToggle, onLoadDeferred }: { activity: ToolActivity; lastInSequence?: boolean; expanded?: boolean; onToggle?: () => void; onLoadDeferred?(activity: ToolActivity): Promise<void> }) {
  const [loadingDeferred, setLoadingDeferred] = useState(false);
  const [deferredLoadFailed, setDeferredLoadFailed] = useState(false);
  const presentation = buildToolPresentation(activity);
  const oldText = toolInputField(activity, ["oldText", "old_text", "old_string"]);
  const newText = toolInputField(activity, ["newText", "new_text", "new_string"]);
  const content = toolInputField(activity, ["content", "text"]);
  const diffs = toolDiffBlocks(activity);
  const contentText = toolContentText(activity);
  const hasInput = hasToolInput(activity);
  const contentBlocks = Array.isArray(activity.content) ? activity.content : typeof activity.content === "object" && activity.content !== null && Array.isArray((activity.content as { content?: unknown }).content) ? (activity.content as { content: unknown[] }).content : [];
  const terminalReferenceOnly = contentBlocks.length > 0 && contentBlocks.every((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "terminal");
  const language = languageFromPath(diffs[0]?.path ?? toolInputField(activity, ["path", "file_path", "filePath"]) ?? "");
  const hasContent = hasToolContent(activity.content);
  const hasOutput = hasToolContent(activity.output);
  const hasDetails = hasInput || hasContent || hasOutput || Boolean(activity.contentDeferred);
  return <ActivityBadge {...presentation} label={activity.parentToolCallId ? `↳ ${presentation.label}` : presentation.label} nested={Boolean(activity.parentToolCallId)} active={activity.state === "running"} failed={activity.state === "error"} lastInSequence={lastInSequence} expanded={expanded} onToggle={hasDetails ? onToggle : undefined}>
    {hasDetails ? <>
      {activity.contentDeferred && <section className="activity-detail-section"><button type="button" className="message-content-retry" disabled={loadingDeferred} onClick={() => { setLoadingDeferred(true); setDeferredLoadFailed(false); void onLoadDeferred?.(activity).catch(() => setDeferredLoadFailed(true)).finally(() => setLoadingDeferred(false)); }}>{deferredLoadFailed ? i18n.t("重试加载完整内容") : i18n.t(loadingDeferred ? "正在加载完整内容…" : "加载完整结果")}</button></section>}
      {hasInput && <section className="activity-detail-section"><h4>{presentation.icon === "shell" ? i18n.t("命令") : i18n.t("输入")}</h4>
        {oldText !== undefined && newText !== undefined ? <div className="tool-file-diff">
          <div className="tool-file-diff-block"><span className="tool-file-diff-label removed">{i18n.t("原内容")}</span><CodeBlock className="removed" text={oldText} language={language} /></div>
          <div className="tool-file-diff-block"><span className="tool-file-diff-label added">{i18n.t("新内容")}</span><CodeBlock className="added" text={newText} language={language} /></div>
        </div>
          : <CodeBlock className={presentation.icon === "shell" ? "is-wrapped" : undefined} text={presentation.icon === "shell" ? toolInputField(activity, ["command", "cmd", "script"]) ?? formatToolValue(activity.input) : presentation.icon === "write" && content !== undefined ? content : formatToolValue(activity.input)} language={presentation.icon === "shell" ? "bash" : content !== undefined ? language : "json"} />}
      </section>}
      {diffs.map((diff, index) => <section className="activity-detail-section tool-acp-diff" key={`${diff.path}-${index}`}>
        <h4 title={diff.path}>{diff.path}</h4>
        <div className="tool-file-diff">
          {diff.oldText !== undefined && diff.oldText !== diff.newText && <div className="tool-file-diff-block"><span className="tool-file-diff-label removed">{i18n.t("原内容")}</span><CodeBlock className="removed" text={diff.oldText} language={languageFromPath(diff.path)} /></div>}
          <div className="tool-file-diff-block"><span className="tool-file-diff-label added">{i18n.t("新内容")}</span><CodeBlock className="added" text={diff.newText} language={languageFromPath(diff.path)} /></div>
        </div>
      </section>)}
      {contentText.length > 0 && <section className="activity-detail-section"><h4>{i18n.t("结果")}</h4>{contentText.map((text, index) => <CodeBlock key={index} text={text} />)}</section>}
      {hasContent && diffs.length === 0 && contentText.length === 0 && !(terminalReferenceOnly && hasOutput) && <section className="activity-detail-section"><h4>{i18n.t("结果")}</h4><CodeBlock text={formatToolValue(activity.content)} /></section>}
      {hasOutput && <section className={`activity-detail-section${activity.state === "error" ? " is-error" : ""}`}><h4>{activity.state === "error" ? i18n.t("错误") : i18n.t("结果")}</h4><CodeBlock text={formatToolValue(activity.output)} /></section>}
      {presentation.icon === "shell" && activity.terminalExitCode !== undefined && <p className="activity-terminal-exit">{i18n.t("退出状态")}: {activity.terminalExitCode === null ? i18n.t("未知") : activity.terminalExitCode}</p>}
    </> : null}
  </ActivityBadge>;
}
