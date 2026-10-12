import type { TurnReviewSnapshot } from "@vagus/protocol";
import { FileDiff } from "lucide-react";
import { registerWorkspaceTab, type WorkspaceTabPageProps } from "../registry.js";
import { GitReviewContent, TurnReviewContent } from "./git-review.js";

function ReviewPage({ context, visible }: WorkspaceTabPageProps<null>) {
  return <GitReviewContent host={context.host} projectId={context.projectId} visible={visible} />;
}

function TurnReviewPage({ instance }: WorkspaceTabPageProps<TurnReviewSnapshot>) {
  return <TurnReviewContent key={instance.payload.turnId} snapshot={instance.payload} />;
}

registerWorkspaceTab({
  type: "review", titleKey: "审查", icon: FileDiff, instancePolicy: "single",
  closeLabelKey: "关闭审查标签", component: ReviewPage, createPayload: () => null,
});

registerWorkspaceTab({
  type: "turn-review", titleKey: "本轮审查", icon: FileDiff, instancePolicy: "single",
  closeLabelKey: "关闭临时审查标签", temporary: true, availableInPicker: false,
  component: TurnReviewPage,
  createPayload: (_context, input): TurnReviewSnapshot => {
    if (!input || typeof input !== "object" || !("turnId" in input) || typeof input.turnId !== "string" || !("files" in input) || !Array.isArray(input.files)) {
      throw new Error("A captured turn review snapshot is required");
    }
    return input as TurnReviewSnapshot;
  },
});
