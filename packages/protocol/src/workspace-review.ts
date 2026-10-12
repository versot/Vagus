/** Workspace Git review is independent of Agent turn snapshots. */
export type GitReviewScope = "unstaged" | "staged";
export interface ReviewFile {
  path: string;
  status: "added" | "modified" | "deleted" | "untracked";
  additions: number | null;
  deletions: number | null;
}
export interface GitReview {
  state: "ready" | "no-project" | "not-repository" | "git-unavailable";
  root?: string;
  scope: GitReviewScope;
  files: ReviewFile[];
}
export interface ReviewPatch { path: string; patch: string; unavailable?: "binary" | "too-large" | "unsupported" | "changed"; }
/** Captured data for a selected turn, never read from the current Git index/worktree. */
export interface TurnReviewSnapshot { turnId: string; files: Array<ReviewFile & ReviewPatch>; }
