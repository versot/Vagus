import { createPatch } from "diff";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const maxFiles = 5_000;
const maxFileBytes = 512 * 1024;
const maxSnapshotBytes = 64 * 1024 * 1024;
const maxDiffChars = 500_000;
const ignoredDirectories = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", "vendor",
  ".next", ".nuxt", ".turbo", ".cache", ".tmp", "coverage", "dist", "build", "target",
  ".venv", "venv", "__pycache__",
]);

export interface WorkspaceFileSnapshot {
  files: Map<string, string>;
  complete: boolean;
}

export async function captureWorkspaceFileSnapshot(root: string): Promise<WorkspaceFileSnapshot> {
  const files = new Map<string, string>();
  let totalBytes = 0;
  let complete = true;
  const visit = async (directory: string): Promise<void> => {
    if (!complete) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name.toLowerCase())) await visit(path);
        if (!complete) return;
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(path).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > maxFileBytes) continue;
      if (files.size >= maxFiles || totalBytes + info.size > maxSnapshotBytes) {
        complete = false;
        return;
      }
      totalBytes += info.size;
      const bytes = await readFile(path).catch(() => null);
      if (!bytes) continue;
      if (bytes.length > maxFileBytes || bytes.includes(0)) continue;
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) continue;
      files.set(relative(root, path).split(sep).join("/"), text.replace(/\r\n?/gu, "\n"));
    }
  };
  await visit(root);
  return { files, complete };
}

export function diffWorkspaceFileSnapshots(before: WorkspaceFileSnapshot | undefined, after: WorkspaceFileSnapshot): { diff: string; truncated: boolean } | null {
  if (!before?.complete || !after.complete) return null;
  const paths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort((a, b) => a.localeCompare(b));
  const patches: string[] = [];
  let length = 0;
  for (const path of paths) {
    const oldText = before.files.get(path);
    const newText = after.files.get(path);
    if (oldText === newText) continue;
    const patch = createPatch(path, oldText ?? "", newText ?? "", "", "", { context: 3 });
    const prefix = `diff --git a/${path} b/${path}\n`;
    const next = `${prefix}${patch}`;
    if (length + next.length > maxDiffChars) {
      const remaining = maxDiffChars - length;
      if (remaining > 0) patches.push(next.slice(0, remaining));
      return { diff: patches.join("\n"), truncated: true };
    }
    patches.push(next);
    length += next.length + 1;
  }
  const diff = patches.join("\n");
  return diff ? { diff, truncated: false } : null;
}
