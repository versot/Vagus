import { type SessionTimelineEntry } from "@vagus/protocol";
import i18n from "../../locales/i18n.js";

export function fencedMarkdown(value: string): string {
  let longestRun = 0;
  for (const match of value.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${value}\n${fence}`;
}

export function stringifyMarkdownValue(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? String(value); }
  catch { return String(value); }
}

export function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function timelineToMarkdown(timeline: readonly SessionTimelineEntry[]): string {
  const output: string[] = [];
  for (const entry of timeline) {
    if (entry.kind === "message") {
      output.push(`## ${entry.role === "user" ? i18n.t("用户") : i18n.t("Agent")}`, "", entry.text);
      for (const attachment of entry.attachments ?? []) {
        output.push("", `![${attachment.name.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${attachment.dataUrl})`);
      }
    } else if (entry.kind === "tool") {
      const state = i18n.t(entry.state === "error" ? "失败" : entry.state === "running" ? "执行中" : "已完成");
      output.push("", `<details><summary>${escapeHtmlText(entry.name)} · ${state}</summary>`, "");
      if (entry.input !== undefined) output.push(i18n.t("输入："), "", fencedMarkdown(stringifyMarkdownValue(entry.input)), "");
      if (entry.output !== undefined) output.push(i18n.t("输出："), "", fencedMarkdown(stringifyMarkdownValue(entry.output)), "");
      output.push("</details>");
    } else if (entry.kind === "status") {
      output.push("", `> **${entry.text === "正在思考" ? i18n.t("正在思考") : `${i18n.t("状态：")}${entry.text}`}**`);
    } else if (entry.kind === "plan") {
      output.push("", `### ${i18n.t("执行计划")}`, ...(entry.explanation ? ["", entry.explanation] : []), "", ...entry.steps.map((step) => `- [${step.status === "completed" ? "x" : " "}] ${step.step}`));
    } else if (entry.kind === "turnDiff") {
      output.push("", `### ${i18n.t("本轮文件变更")}`, "", fencedMarkdown(entry.diff));
    } else if (entry.kind === "interaction") {
      const title = entry.interaction.title ?? i18n.t("等待你的回复");
      output.push("", `<details><summary>${escapeHtmlText(title)}</summary>`, "");
      if (entry.interaction.message) output.push(entry.interaction.message, "");
      if (entry.interaction.kind === "choice") output.push(...entry.interaction.options.map((option) => `- ${option}`), "");
      if (entry.response !== undefined && entry.response !== null) output.push(`${i18n.t("回答：")}${typeof entry.response === "boolean" ? i18n.t(entry.response ? "是" : "否") : entry.response}`, "");
      output.push("</details>");
    } else {
      output.push("", `> **${i18n.t(entry.level === "error" ? "错误" : entry.level === "warning" ? "提示" : "通知：")}** ${entry.message}`);
    }
  }

  return output.join("\n").trimEnd();
}
