import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runGit = (args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

const eventName = process.env.EVENT_NAME ?? process.env.GITHUB_EVENT_NAME;
const baseSha = process.env.BASE_SHA;
const baseRef = process.env.BASE_REF ?? process.env.GITHUB_BASE_REF;
let changed = [];

if (eventName === "pull_request" && baseRef) {
  changed = runGit(["diff", "--name-only", `origin/${baseRef}...HEAD`])
    .split(/\r?\n/)
    .filter(Boolean);
} else if (baseSha && !/^0+$/.test(baseSha)) {
  changed = runGit(["diff", "--name-only", `${baseSha}...HEAD`])
    .split(/\r?\n/)
    .filter(Boolean);
} else {
  changed = runGit(["diff", "--name-only", "HEAD"]).split(/\r?\n/).filter(Boolean);
  changed.push(...runGit(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean));
}

const unique = [...new Set(changed)].filter(
  (path) => existsSync(resolve(root, path)) && !path.replaceAll("\\", "/").includes("/gen/"),
);
const prettierExtensions = /\.(?:[cm]?[jt]sx?|jsonc?|mdx?|md|css|scss|html|ya?ml)$/i;
const lintExtensions = /\.(?:ts|tsx)$/i;
const prettierFiles = unique.filter((path) => prettierExtensions.test(path));
const lintFiles = unique.filter((path) => lintExtensions.test(path));

if (prettierFiles.length > 0) {
  execFileSync(
    process.execPath,
    [resolve(root, "node_modules/prettier/bin/prettier.cjs"), "--check", ...prettierFiles],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
}

if (lintFiles.length > 0) {
  execFileSync(process.execPath, [resolve(root, "node_modules/eslint/bin/eslint.js"), ...lintFiles], {
    cwd: root,
    stdio: "inherit",
  });
}

if (prettierFiles.length === 0 && lintFiles.length === 0) {
  console.log("No changed source or documentation files require style checks.");
} else {
  console.log(`Checked ${prettierFiles.length} formatted file(s) and ${lintFiles.length} TypeScript file(s).`);
}
