import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [mode, log, ...args] = process.argv.slice(2);
const phase = args.includes("--version") ? "version" : "app-server";
const record = (extra = {}) => appendFileSync(log, JSON.stringify({ mode, phase, pid: process.pid, ...extra }) + "\n");
record({ hostSecrets: Boolean(process.env.VAGUS_HOST_TOKEN || process.env.VAGUS_ALLOWED_ORIGINS) });
if (phase === "version") {
  if (mode === "hang-version") setInterval(() => {}, 1_000);
  else {
    console.log(mode === "invalid-version" ? "another-tool 1.0.0" : "codex-cli 0.159.1");
    process.exit(0);
  }
} else if (mode === "early-exit") {
  process.stderr.write("error: unrecognized subcommand 'app-server'\nACCESS_TOKEN=private-fixture-token\n");
  process.exit(1);
} else {
  if (mode === "hang") {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    record({ pid: descendant.pid, descendant: true });
  }
  const reply = (id, result) => console.log(JSON.stringify({ id, result }));
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    record({ method: message.method });
    if (message.method === "initialized") return;
    if (message.method === "initialize") {
      if (mode === "hang") return;
      if (mode === "auth-initialize") {
        console.log(
          JSON.stringify({
            id: message.id,
            error: { code: 401, message: "Not signed in. ACCESS_TOKEN=private-fixture-token" },
          }),
        );
        return;
      }
      reply(message.id, mode === "invalid-initialize" ? {} : { userAgent: "fixture-codex/0.159.1" });
    } else if (message.method === "model/list") {
      if (mode === "auth-model") {
        console.log(JSON.stringify({ id: message.id, error: { code: 401, message: "Authentication required" } }));
      } else reply(message.id, { data: [{ id: "fixture-model", displayName: "Fixture model", isDefault: true }] });
    } else if (message.method === "thread/start" || message.method === "thread/resume") {
      reply(message.id, { thread: { id: "fixture-thread" }, model: "fixture-model" });
    } else if (message.method === "test/ping") reply(message.id, { mode, pid: process.pid });
    else reply(message.id, {});
  });
}
