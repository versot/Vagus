import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexProvider } from "../packages/host/dist/agent/providers/codex/codex-provider.js";
import { npmCodexArm64Binaries } from "../packages/host/dist/agent/providers/codex/executable.js";
import { CodexAppServer, resolveCodexExecutableDetails } from "../packages/host/dist/agent/providers/codex/runtime.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-runtime.mjs", import.meta.url));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function setup(t, modes) {
  const directory = await mkdtemp(join(tmpdir(), "vagus-codex-runtime-"));
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    assert.equal(join(tmpdir(), directory.split(/[\\/]/).at(-1)), directory);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const log = join(directory, "processes.jsonl");
  const paths = [];
  for (const [index, mode] of modes.entries()) {
    const bin = join(directory, `cli ${index}`);
    await mkdir(bin);
    const path = join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
    const script =
      process.platform === "win32"
        ? `@"${process.execPath}" "${fixture}" "${mode}" "${log}" %*\r\n`
        : `#!/bin/sh\nexec ${[process.execPath, fixture, mode, log].map(shellQuote).join(" ")} "$@"\n`;
    await writeFile(path, script, { mode: 0o755 });
    paths.push(path);
  }
  const environment = {
    ...process.env,
    PATH: [
      ...paths.map((path) => path.slice(0, path.lastIndexOf(process.platform === "win32" ? "\\" : "/"))),
      process.env.PATH ?? "",
    ].join(delimiter),
    VAGUS_HOST_TOKEN: "fixture-host-token",
    VAGUS_ALLOWED_ORIGINS: "fixture-host-origin",
  };
  delete environment.VAGUS_CODEX_EXECUTABLE;
  return { directory, log, paths, environment, cleanup };
}

async function records(log) {
  return (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertEnded(log, mode, phase = "app-server") {
  const pids = [
    ...new Set(
      (await records(log)).filter((entry) => entry.mode === mode && entry.phase === phase).map((entry) => entry.pid),
    ),
  ];
  assert.ok(pids.length, "the fixture process must have started");
  const deadline = Date.now() + 3_000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(
    pids.every((pid) => !alive(pid)),
    "failed and closed CLI processes must be terminated",
  );
}

function setEnvironment(t, environment) {
  const names = ["PATH", "VAGUS_CODEX_EXECUTABLE"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    if (environment[name] === undefined) delete process.env[name];
    else process.env[name] = environment[name];
  }
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
}

test(
  "Codex skips a different executable and keeps the validated server without duplicate initialization",
  { timeout: 15_000 },
  async (t) => {
    const data = await setup(t, ["invalid-version", "good"]);
    const first = await resolveCodexExecutableDetails(data.environment);
    assert.equal(first.path, data.paths[0]);
    const server = new CodexAppServer(first.path, data.directory, first.source, {
      environment: data.environment,
      automaticDiscovery: true,
    });
    data.cleanup.push(() => server.close());
    await server.start();
    assert.equal(server.executablePath, data.paths[1]);
    assert.equal(server.executableSource, "environment");
    assert.equal((await server.request("test/ping", {})).mode, "good");
    await server.close();
    const entries = await records(data.log);
    assert.equal(entries.filter((entry) => entry.mode === "invalid-version" && entry.phase === "app-server").length, 0);
    assert.equal(entries.filter((entry) => entry.mode === "good" && entry.method === "initialize").length, 1);
    assert.equal(
      entries.some((entry) => entry.hostSecrets),
      false,
    );
    await assertEnded(data.log, "good");
  },
);

test(
  "Codex falls back after an incompatible app-server exits without reporting a session exit",
  { timeout: 15_000 },
  async (t) => {
    const data = await setup(t, ["early-exit", "good"]);
    const server = new CodexAppServer(data.paths[0], data.directory, "environment", {
      environment: data.environment,
      automaticDiscovery: true,
    });
    const exits = [];
    server.setHandlers({
      notification() {},
      serverRequest() {},
      exit(error) {
        exits.push(error);
      },
    });
    data.cleanup.push(() => server.close());
    await server.start();
    assert.equal(server.executablePath, data.paths[1]);
    assert.equal(exits.length, 0);
    await assertEnded(data.log, "early-exit");
  },
);

for (const [mode, options, failure] of [
  ["hang", { startupTimeoutMs: 500 }, /initialization timed out/],
  ["hang-version", { versionTimeoutMs: 500 }, /Version check timed out/],
  ["invalid-initialize", {}, /invalid initialization response/],
]) {
  test(
    `Codex rejects a configured ${mode} CLI and cleans it up without selecting another installation`,
    { timeout: 15_000 },
    async (t) => {
      const data = await setup(t, [mode, "good"]);
      data.environment.VAGUS_CODEX_EXECUTABLE = data.paths[0];
      const server = new CodexAppServer(data.paths[0], data.directory, "setting VAGUS_CODEX_EXECUTABLE", {
        environment: data.environment,
        ...options,
      });
      data.cleanup.push(() => server.close());
      await assert.rejects(server.start(), failure);
      assert.equal(
        (await records(data.log)).some((entry) => entry.mode === "good"),
        false,
      );
      await assertEnded(data.log, mode, mode === "hang-version" ? "version" : "app-server");
    },
  );
}

test(
  "closing Codex during version discovery cancels the probe and prevents another process from starting",
  { timeout: 10_000 },
  async (t) => {
    const data = await setup(t, ["hang-version", "good"]);
    const server = new CodexAppServer(data.paths[0], data.directory, "environment", {
      environment: data.environment,
      automaticDiscovery: true,
    });
    data.cleanup.push(() => server.close());
    const rejected = assert.rejects(server.start(), /startup was cancelled/);
    const deadline = Date.now() + 3_000;
    while (!(await readFile(data.log, "utf8").catch(() => "")) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    await server.close();
    await rejected;
    const entries = await records(data.log);
    assert.equal(
      entries.some((entry) => entry.phase === "app-server" || entry.mode === "good"),
      false,
    );
    await assertEnded(data.log, "hang-version", "version");
  },
);

test("an explicit missing command cannot silently fall back to codex on PATH", { timeout: 10_000 }, async (t) => {
  const data = await setup(t, ["good"]);
  data.environment.VAGUS_CODEX_EXECUTABLE = `missing-codex-${Date.now()}`;
  await assert.rejects(resolveCodexExecutableDetails(data.environment), /configured command is missing or unusable/);
});

test(
  "Codex stops discovery on an authentication error without exposing CLI credentials",
  { timeout: 15_000 },
  async (t) => {
    const data = await setup(t, ["auth-initialize", "good"]);
    const server = new CodexAppServer(data.paths[0], data.directory, "environment", {
      environment: data.environment,
      automaticDiscovery: true,
    });
    data.cleanup.push(() => server.close());
    await assert.rejects(
      server.start(),
      (error) => /authentication failed/i.test(error.message) && !error.message.includes("private-fixture-token"),
    );
    assert.equal(
      (await records(data.log)).some((entry) => entry.mode === "good"),
      false,
    );
    await assertEnded(data.log, "auth-initialize");
  },
);

test("model refresh and session startup select the same compatible Codex CLI", { timeout: 20_000 }, async (t) => {
  const data = await setup(t, ["invalid-version", "good"]);
  setEnvironment(t, data.environment);
  const provider = new CodexProvider();
  const catalog = await provider.listModels();
  assert.equal(catalog.executablePath, data.paths[1]);
  const events = [];
  const session = await provider.startSession(
    { sessionId: "fixture-session", workingDirectory: data.directory },
    (event) => events.push(event),
  );
  data.cleanup.push(() => session.dispose());
  assert.equal(
    events.some((event) => event.type === "session.state" && event.state === "idle"),
    true,
  );
  await session.dispose();
  const entries = await records(data.log);
  assert.equal(
    entries.some((entry) => entry.mode === "invalid-version" && entry.phase === "app-server"),
    false,
  );
  assert.equal(entries.filter((entry) => entry.mode === "good" && entry.method === "initialize").length, 2);
  await assertEnded(data.log, "good");
});

test("a model catalog authentication failure does not trigger executable fallback", { timeout: 15_000 }, async (t) => {
  const data = await setup(t, ["auth-model", "good"]);
  setEnvironment(t, data.environment);
  await assert.rejects(new CodexProvider().listModels(), /Authentication required/);
  assert.equal(
    (await records(data.log)).some((entry) => entry.mode === "good"),
    false,
  );
  await assertEnded(data.log, "auth-model");
});

test("npm ARM64 discovery accepts current and legacy layouts only when versions match", async (t) => {
  const data = await setup(t, []);
  const root = join(data.directory, "codex-package");
  const launcher = join(root, "bin", "codex.js");
  const nativeRoot = join(root, "node_modules", "@openai", "codex-darwin-arm64");
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(nativeRoot, { recursive: true });
  await writeFile(launcher, "#!/usr/bin/env node\n", { mode: 0o755 });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.159.1" }));
  const metadata = join(nativeRoot, "package.json");
  await writeFile(metadata, JSON.stringify({ name: "@openai/codex", version: "0.159.1-darwin-arm64" }));
  const expected = [];
  for (const layout of ["bin", "codex"]) {
    const directory = join(nativeRoot, "vendor", "aarch64-apple-darwin", layout);
    await mkdir(directory, { recursive: true });
    const binary = join(directory, "codex");
    await writeFile(binary, "fixture native binary", { mode: 0o755 });
    expected.push(binary);
  }
  assert.deepEqual(await npmCodexArm64Binaries(launcher), expected);
  await writeFile(metadata, JSON.stringify({ version: "0.159.0-darwin-arm64" }));
  assert.deepEqual(await npmCodexArm64Binaries(launcher), []);
  assert.deepEqual(await npmCodexArm64Binaries(expected[0]), []);
});
