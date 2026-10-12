import { cp, mkdir, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const outdir = fileURLToPath(new URL("../dist/standalone/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
await rm(outdir, { recursive: true, force: true });
await mkdir(join(outdir, "node_modules"), { recursive: true });
await build({
  entryPoints: {
    server: fileURLToPath(new URL("../src/server.ts", import.meta.url)),
    "workspace-store-worker": fileURLToPath(new URL("../src/storage/workspace-store-worker.ts", import.meta.url)),
  },
  outdir,
  bundle: true,
  packages: "bundle",
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node:*", "cross-spawn", "undici", "ws"],
  sourcemap: false,
  banner: { js: "// Bundled by Vagus for the desktop installer." },
});

for (const packageName of ["@agentclientprotocol/claude-agent-acp", "@agentclientprotocol/sdk", "zod", "diff", "cross-spawn", "path-key", "shebang-command", "shebang-regex", "which", "isexe", "undici", "ws"]) {
  await cp(
    join(repoRoot, "node_modules", packageName),
    join(outdir, "node_modules", packageName),
    {
      recursive: true,
      dereference: true,
      // The ACP bridge must use the user's installed Claude Code CLI, not ship a second runtime binary.
      filter: (source) => !source.split(sep).some((part) => part.startsWith("claude-agent-sdk-") && part !== "claude-agent-sdk"),
    },
  );
}
