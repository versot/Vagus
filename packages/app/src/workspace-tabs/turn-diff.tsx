import type { TurnReviewSnapshot } from "@vagus/protocol";
import { FileDiff } from "lucide-react";
import type { TurnChangedFile } from "../features/conversation/components/conversation-activity.js";
import { registerWorkspaceTab, type WorkspaceTabPageProps } from "./registry.js";
import { TurnReviewContent } from "./review/git-review.js";

type TurnDiffPayload = { snapshot: TurnReviewSnapshot; selectedPath?: string; truncated?: boolean };

function changedTextPatch(file: TurnChangedFile): string {
  const patches = [...(file.patch ? [file.patch] : []), ...(file.patches ?? [])];
  if (patches.length) return patches.join("\n");
  return (file.details ?? []).map((change) => {
    const oldLines = change.oldText ? change.oldText.split(/\r?\n/u) : [];
    const newLines = change.newText ? change.newText.split(/\r?\n/u) : [];
    const oldStart = oldLines.length ? 1 : 0;
    const newStart = newLines.length ? 1 : 0;
    return [
      `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ].join("\n");
  }).join("\n");
}

function TurnDiffPage({ instance }: WorkspaceTabPageProps<TurnDiffPayload>) {
  const { snapshot, selectedPath, truncated } = instance.payload;
  return <TurnReviewContent key={snapshot.turnId} snapshot={snapshot} selectedPath={selectedPath} truncated={truncated} />;
}

registerWorkspaceTab({
  type: "turn-diff", titleKey: "本轮文件变更", icon: FileDiff, instancePolicy: "single",
  closeLabelKey: "关闭临时差异标签", temporary: true, availableInPicker: false,
  component: TurnDiffPage,
  createPayload: (_context, input): TurnDiffPayload => {
    if (!input || typeof input !== "object" || typeof (input as { turnId?: unknown }).turnId !== "string" || !Array.isArray((input as { files?: unknown }).files)) throw new Error("A captured turn diff is required");
    const source = input as { turnId: string; files: TurnChangedFile[]; selectedPath?: string; truncated?: boolean };
    const snapshot: TurnReviewSnapshot = {
      turnId: source.turnId,
      files: source.files.map((file) => ({
        path: file.path,
        status: "modified",
        additions: file.additions,
        deletions: file.removals,
        patch: changedTextPatch(file),
      })),
    };
    return { snapshot, selectedPath: source.selectedPath, truncated: source.truncated };
  },
});
