import type { GitReview, GitReviewScope, ReviewFile, ReviewPatch } from "@vagus/protocol";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const maxFileBytes = 512 * 1024;
async function git(root: string, args: string[]) {
  const { stdout } = await execute("git", ["--no-optional-locks", "-C", root, "-c", "core.quotepath=false", ...args], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
  });
  return stdout;
}
function diffArgs(scope: GitReviewScope) { return ["diff", ...(scope === "staged" ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules", "--no-color"]; }
async function untrackedFile(root: string, path: string): Promise<ReviewPatch> {
  const target = resolve(root, path);
  const info = await lstat(target);
  // Never follow links outside a repository or read devices/special files.
  if (!info.isFile() || info.isSymbolicLink()) return { path, patch: "", unavailable: "unsupported" };
  const realTarget = await realpath(target);
  const inside = relative(await realpath(root), realTarget);
  if (isAbsolute(inside) || inside === ".." || inside.startsWith("../") || inside.startsWith("..\\")) return { path, patch: "", unavailable: "unsupported" };
  if (info.size > maxFileBytes) return { path, patch: "", unavailable: "too-large" };
  const bytes = await readFile(realTarget);
  if (bytes.length > maxFileBytes) return { path, patch: "", unavailable: "too-large" };
  if (bytes.includes(0)) return { path, patch: "", unavailable: "binary" };
  const text = bytes.toString("utf8");
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  return { path, patch: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +${lines.length ? 1 : 0},${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}${text && !text.endsWith("\n") ? "\n\\ No newline at end of file" : ""}` };
}

export async function readGitReview(projectRoot: string | undefined, scope: GitReviewScope): Promise<GitReview> {
  if (!projectRoot) return { state: "no-project", scope, files: [] };
  let root: string;
  try { root = (await git(projectRoot, ["rev-parse", "--show-toplevel"])).trimEnd(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "git-unavailable", scope, files: [] };
    if (/not a git repository/i.test(String((error as { stderr?: string }).stderr))) return { state: "not-repository", scope, files: [] };
    throw error;
  }
  const args = diffArgs(scope);
  const [names, stats, untracked] = await Promise.all([
    git(root, [...args, "--name-status", "-z", "--"]),
    git(root, [...args, "--numstat", "-z", "--"]),
    scope === "unstaged" ? git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"]) : Promise.resolve(""),
  ]);
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const row of stats.split("\0").filter(Boolean)) {
    const first = row.indexOf("\t"), second = row.indexOf("\t", first + 1);
    counts.set(row.slice(second + 1), { additions: row.slice(0, first) === "-" ? null : Number(row.slice(0, first)), deletions: row.slice(first + 1, second) === "-" ? null : Number(row.slice(first + 1, second)) });
  }
  const entries = names.split("\0");
  const files: ReviewFile[] = [];
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const status = entries[index], path = entries[index + 1]!;
    if (status && path) files.push({ path, status: status === "A" ? "added" : status === "D" ? "deleted" : "modified", ...(counts.get(path) ?? { additions: null, deletions: null }) });
  }
  for (const path of untracked.split("\0").filter(Boolean)) files.push({ path, status: "untracked", additions: null, deletions: 0 });
  return { state: "ready", root, scope, files };
}

export async function readGitPatch(projectRoot: string | undefined, scope: GitReviewScope, path: string): Promise<ReviewPatch> {
  const review = await readGitReview(projectRoot, scope);
  const file = review.files.find((item) => item.path === path);
  if (!file || !review.root) return { path, patch: "", unavailable: "changed" };
  if (file.status === "untracked") return untrackedFile(review.root, path);
  if (file.additions === null) return { path, patch: "", unavailable: "binary" };
  try {
    return { path, patch: await git(review.root, [...diffArgs(scope), "--src-prefix=a/", "--dst-prefix=b/", "--", `:(literal)${path}`]) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { path, patch: "", unavailable: "too-large" };
    throw error;
  }
}
