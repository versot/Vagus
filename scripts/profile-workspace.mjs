// Read-only profiling of a copied workspace. Never opens the user's database.
import { readFile, mkdtemp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceStore } from "../packages/host/dist/storage/workspace-store.js";
import { normalizeLegacySession } from "../packages/host/dist/storage/workspace-records.js";

if (!process.argv[2]) throw new Error("请提供旧 workspace.json 路径；采样只操作临时副本。");
const source = resolve(process.argv[2]);
const copy = await mkdtemp(join(tmpdir(), "vagus-profile-"));
await copyFile(source, join(copy, "workspace.json"));
const raw = await readFile(join(copy, "workspace.json"), "utf8");
let started = performance.now();
const legacy = JSON.parse(raw);
const jsonParseMs = performance.now() - started;
const copies = Math.max(1, Math.min(100, Number(process.argv.find((value) => value.startsWith("--copies="))?.slice(9)) || 1));
if (copies > 1) {
  const originals = legacy.sessions;
  legacy.sessions = Array.from({ length: copies }, (_, index) => originals.map((session) => ({ ...structuredClone(session), id: `sample-${index}-${session.id}` }))).flat();
  // Generated scale data is only written to the disposable copy.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(copy, "workspace.json"), JSON.stringify(legacy));
}
const normalized = legacy.sessions.map(normalizeLegacySession);
started = performance.now();
const store = new WorkspaceStore(copy);
try {
  const metadata = await store.load();
  const importMs = performance.now() - started;
  const sizes = [];
  let entries = 0;
  let changedHistories = 0;
  let searchDifferences = 0;
  let pageDifferences = 0;
  const { readHistoryPage } = await import("../packages/host/dist/storage/session-history.js");
  for (const session of normalized) {
    const history = await store.read(session.id);
    entries += history.length;
    if (JSON.stringify(history) !== JSON.stringify(session.timeline)) changedHistories++;
    started = performance.now();
    const page = await store.history(session.id, { limit: 120 });
    const elapsedMs = performance.now() - started;
    const expected = readHistoryPage(session.timeline, session.eventSequence, { limit: 120 });
    if (JSON.stringify(page) !== JSON.stringify(expected)) pageDifferences++;
    sizes.push({ ms: elapsedMs, fullBytes: Buffer.byteLength(JSON.stringify(history)), pageBytes: Buffer.byteLength(JSON.stringify(page)) });
  }
  const queries = new Set(["a", "项目", "Pi", "/", '"', "Markdown", "abc def"]);
  for (const session of normalized) {
    const text = session.messages.find((message) => message.text.trim().length >= 8)?.text.trim();
    if (text) { queries.add(Array.from(text).slice(0, 7).join("")); queries.add(Array.from(text).slice(0, 3).join("")); }
    if (queries.size > 80) break;
  }
  for (const query of queries) for (const archived of [false, true]) {
    const ids = [];
    let offset = 0;
    while (true) {
      const page = await store.search(query, archived, { limit: 100, offset });
      ids.push(...page.ids);
      if (!page.hasMore) break;
      offset = page.nextOffset;
    }
    const needle = query.trim().toLocaleLowerCase();
    const expected = normalized.filter((session) => Boolean(session.archivedAt) === archived && (session.title.toLocaleLowerCase().includes(needle) || session.messages.some((message) => message.text.toLocaleLowerCase().includes(needle)))).map((session) => session.id).sort();
    if (JSON.stringify(ids.sort()) !== JSON.stringify(expected)) searchDifferences++;
  }
  const times = sizes.map((item) => item.ms).sort((a, b) => a - b);
  // Warm unchanged metadata, then measure one changed entry in the copy.
  await store.save(metadata.projects, metadata.sessions, []);
  const exampleSession = normalized.find((session) => session.timeline.some((entry) => entry.kind === "message" && entry.text.length > 2000));
  const exampleEntry = exampleSession?.timeline.find((entry) => entry.kind === "message" && entry.text.length > 2000);
  let incrementalSaveMs = null;
  if (exampleEntry) {
    started = performance.now();
    await store.save(metadata.projects, metadata.sessions, [{ sessionId: exampleSession.id, entry: { ...exampleEntry, text: `${exampleEntry.text}\nStorage profiling marker.` } }]);
    incrementalSaveMs = performance.now() - started;
  }
  console.log(JSON.stringify({
    copiedDataDir: copy, sessions: metadata.sessions.length, projects: metadata.projects.length, entries,
    copies,
    legacyJsonBytes: Buffer.byteLength(raw), sampledJsonBytes: Buffer.byteLength(JSON.stringify(legacy)), metadataBytes: Buffer.byteLength(JSON.stringify(metadata)),
    legacyJsonParseMs: jsonParseMs, sqliteFirstImportMs: importMs,
    historyQueryP95Ms: times[Math.floor((times.length - 1) * .95)] ?? 0,
    incrementalSaveMs,
    historyFullBytes: sizes.reduce((sum, value) => sum + value.fullBytes, 0),
    historyPageBytes: sizes.reduce((sum, value) => sum + value.pageBytes, 0),
    changedHistories, pageDifferences, searchDifferences, sampledQueries: queries.size,
    storageOperations: await store.request("performance"),
  }, null, 2));
} finally { await store.close(); }
