import { SESSION_HISTORY_PAGE_BYTE_BUDGET, type ScheduledTask, type SessionHistoryPage, type SessionTimelineEntry } from "@vagus/protocol";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { boundedHistoryEntry } from "./session-history.js";
import { normalizeLegacySession, sessionMetadata, type Database, type Project, type SessionMetadata } from "./workspace-records.js";

const { dataDir } = workerData as { dataDir: string };
await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, "workspace.sqlite"));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS scheduled_tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, archived INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS entries (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL, sequence INTEGER NOT NULL, turn_id TEXT, kind TEXT NOT NULL, role TEXT, preview TEXT, occurred_at TEXT, data TEXT NOT NULL, PRIMARY KEY(session_id,id));
  CREATE INDEX IF NOT EXISTS entries_sequence ON entries(session_id,sequence);
  CREATE INDEX IF NOT EXISTS entries_user ON entries(session_id,role,sequence);
  CREATE TABLE IF NOT EXISTS documents (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, entry_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(session_id,entry_id));
  CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(body,content='documents',content_rowid='id',tokenize='trigram');
  CREATE TRIGGER IF NOT EXISTS documents_insert AFTER INSERT ON documents BEGIN INSERT INTO search_index(rowid,body) VALUES(new.id,new.body); END;
  CREATE TRIGGER IF NOT EXISTS documents_delete AFTER DELETE ON documents BEGIN INSERT INTO search_index(search_index,rowid,body) VALUES('delete',old.id,old.body); END;
  CREATE TRIGGER IF NOT EXISTS documents_update AFTER UPDATE OF body ON documents BEGIN INSERT INTO search_index(search_index,rowid,body) VALUES('delete',old.id,old.body); INSERT INTO search_index(rowid,body) VALUES(new.id,new.body); END;
`);
const upsertSession = db.prepare("INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,archived=excluded.archived WHERE sessions.data<>excluded.data");
const upsertDocument = db.prepare("INSERT INTO documents(session_id,entry_id,body) VALUES(?,?,?) ON CONFLICT(session_id,entry_id) DO UPDATE SET body=excluded.body WHERE documents.body<>excluded.body");
const upsertEntry = db.prepare("INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET sequence=excluded.sequence,turn_id=excluded.turn_id,kind=excluded.kind,role=excluded.role,preview=excluded.preview,occurred_at=excluded.occurred_at,data=excluded.data");
const metadataCache = new Map<string, string>();
function putSession(session: SessionMetadata) {
  const data = JSON.stringify(session);
  if (metadataCache.get(session.id) === data) return;
  upsertSession.run(session.id, data, session.archivedAt ? 1 : 0);
  upsertDocument.run(session.id, "$title", session.title.toLocaleLowerCase());
  metadataCache.set(session.id, data);
}
function putEntry(sessionId: string, entry: SessionTimelineEntry) {
  const text = entry.kind === "message" ? entry.text : "";
  const preview = entry.kind === "message" ? (text || entry.attachments?.map((attachment) => attachment.name).join("、") || "图片消息").slice(0, 120) : null;
  upsertEntry.run(sessionId, entry.id, entry.sequence, entry.turnId ?? null, entry.kind, entry.kind === "message" ? entry.role : null, preview, entry.occurredAt, JSON.stringify(entry));
  if (entry.kind === "message") upsertDocument.run(sessionId, entry.id, text.toLocaleLowerCase());
}
function transaction(action: () => void) {
  db.exec("BEGIN IMMEDIATE");
  try { action(); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); metadataCache.clear(); throw error; }
}

// The legacy file is retained as a recovery copy. The marker and all imported
// records commit together; a failed or interrupted import is safe to retry.
if (!db.prepare("SELECT 1 FROM settings WHERE key='legacy_imported'").get()) {
  let legacy: Database = { projects: [], sessions: [] };
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, "workspace.json"), "utf8")) as Database;
    if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.sessions)) throw new Error("旧工作区文件格式无效，未迁移历史");
    legacy = parsed;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  transaction(() => {
    for (const original of legacy.sessions) {
      const session = normalizeLegacySession(original);
      putSession(sessionMetadata(session));
      for (const entry of session.timeline) putEntry(session.id, entry);
    }
    db.prepare("INSERT INTO settings VALUES('projects',?)").run(JSON.stringify(legacy.projects));
    db.prepare("INSERT INTO settings VALUES('legacy_imported','1')").run();
  });
}
// Interrupted controls are repaired on disk without reading every history into
// the Host. Live agent state is reset by the Host after reading metadata.
transaction(() => {
  for (const row of db.prepare("SELECT session_id,data FROM entries WHERE (kind='tool' AND json_extract(data,'$.state')='running') OR (kind='interaction' AND json_extract(data,'$.state')='pending')").all()) {
    const entry = JSON.parse(String(row.data)) as SessionTimelineEntry;
    if (entry.kind === "tool") { entry.state = "error"; entry.output = "Vagus 在此操作完成前关闭。"; }
    if (entry.kind === "interaction") { entry.state = "cancelled"; entry.response = null; entry.reason = "interrupted"; }
    putEntry(String(row.session_id), entry);
  }
});
const timings = new Map<string, { count: number; totalMs: number; maxMs: number }>();
function record(type: string, elapsed: number) { const value = timings.get(type) ?? { count: 0, totalMs: 0, maxMs: 0 }; value.count++; value.totalMs += elapsed; value.maxMs = Math.max(value.maxMs, elapsed); timings.set(type, value); }
function history(payload: { sessionId: string; limit?: number; beforeSequence?: number }): SessionHistoryPage {
  const limit = Number.isFinite(payload.limit) ? Math.max(1, Math.min(500, Math.floor(payload.limit!))) : 120;
  const end = payload.beforeSequence ?? Number.MAX_SAFE_INTEGER;
  const recent = db.prepare("SELECT sequence,data FROM entries WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?").all(payload.sessionId, end, limit);
  const selected: SessionTimelineEntry[] = [];
  let byteLength = 2;
  for (const row of recent) {
    const entry = boundedHistoryEntry(JSON.parse(String(row.data)) as SessionTimelineEntry);
    const nextLength = byteLength + Buffer.byteLength(JSON.stringify(entry)) + (selected.length ? 1 : 0);
    if (nextLength > SESSION_HISTORY_PAGE_BYTE_BUDGET) break;
    selected.push(entry);
    byteLength = nextLength;
  }
  selected.reverse();
  const entries = selected;
  const start = entries[0]?.sequence ?? end;
  byteLength = Buffer.byteLength(JSON.stringify(entries));
  const session = db.prepare("SELECT data FROM sessions WHERE id=?").get(payload.sessionId);
  return { entries, byteLength, beforeSequence: entries[0]?.sequence ?? null, hasMore: Boolean(entries.length && db.prepare("SELECT 1 FROM entries WHERE session_id=? AND sequence<? LIMIT 1").get(payload.sessionId, start)), eventSequence: session ? (JSON.parse(String(session.data)) as SessionMetadata).eventSequence : 0 };
}
function handle(type: string, payload: any): unknown {
  switch (type) {
    case "load": {
      const sessions = db.prepare("SELECT data FROM sessions ORDER BY json_extract(data,'$.createdAt') DESC").all().map((row) => JSON.parse(String(row.data)) as SessionMetadata);
      const assistantReplies = db.prepare(`
        SELECT entry.session_id AS sessionId, entry.data AS data
        FROM entries AS entry
        JOIN (
          SELECT session_id, MAX(sequence) AS sequence
          FROM entries
          WHERE kind='message' AND role='assistant' AND json_extract(data,'$.complete')=1
          GROUP BY session_id
        ) AS latest ON latest.session_id=entry.session_id AND latest.sequence=entry.sequence
      `).all();
      const latestAssistantAt = new Map(assistantReplies.map((row) => {
        const entry = JSON.parse(String(row.data)) as Extract<SessionTimelineEntry, { kind: "message" }>;
        return [String(row.sessionId), entry.completedAt ?? entry.occurredAt] as const;
      }));
      for (const session of sessions) {
        if (!session.lastAssistantAt) {
          const completedAt = latestAssistantAt.get(session.id);
          if (completedAt) session.lastAssistantAt = completedAt;
        }
      }
      return { projects: JSON.parse(String(db.prepare("SELECT value FROM settings WHERE key='projects'").get()?.value ?? "[]")), sessions };
    }
    case "scheduled-tasks.list": return db.prepare("SELECT data FROM scheduled_tasks ORDER BY rowid DESC").all().map((row) => JSON.parse(String(row.data)) as ScheduledTask);
    case "scheduled-tasks.put": {
      const task = payload as ScheduledTask;
      db.prepare("INSERT INTO scheduled_tasks(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(task.id, JSON.stringify(task));
      return task;
    }
    case "scheduled-tasks.delete": return db.prepare("DELETE FROM scheduled_tasks WHERE id=?").run(String(payload.id)).changes;
    case "save": {
      const { projects, sessions, entries } = payload as { projects: Project[]; sessions: SessionMetadata[]; entries: Array<{ sessionId: string; entry: SessionTimelineEntry }> };
      transaction(() => {
        const ids = new Set(sessions.map((session) => session.id));
        for (const row of db.prepare("SELECT id FROM sessions").all()) if (!ids.has(String(row.id))) { db.prepare("DELETE FROM sessions WHERE id=?").run(String(row.id)); metadataCache.delete(String(row.id)); }
        for (const session of sessions) putSession(session);
        for (const item of entries) if (ids.has(item.sessionId)) putEntry(item.sessionId, item.entry);
        db.prepare("INSERT INTO settings VALUES('projects',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value<>excluded.value").run(JSON.stringify(projects));
      });
      return null;
    }
    case "read": return db.prepare("SELECT data FROM entries WHERE session_id=? ORDER BY sequence").all(payload.sessionId).map((row) => JSON.parse(String(row.data)));
    case "history": return history(payload);
    case "entry": {
      const row = db.prepare("SELECT data FROM entries WHERE session_id=? AND id=?").get(payload.sessionId, payload.entryId);
      if (!row) throw new Error("历史条目不存在");
      return JSON.parse(String(row.data)) as SessionTimelineEntry;
    }
    case "markers": return db.prepare("SELECT id,sequence,preview AS text,occurred_at AS occurredAt FROM entries WHERE session_id=? AND role='user' ORDER BY sequence").all(payload.sessionId);
    case "search": {
      const query = String(payload.query).trim().toLocaleLowerCase();
      const limit = Number.isFinite(payload.limit) ? Math.max(1, Math.min(100, Math.floor(payload.limit))) : 100;
      const offset = Number.isSafeInteger(payload.offset) ? Math.max(0, Math.floor(payload.offset)) : 0;
      const archived = payload.archived ? 1 : 0;
      const rows = !query
        ? db.prepare("SELECT id FROM sessions WHERE archived=? ORDER BY id LIMIT ? OFFSET ?").all(archived, limit + 1, offset)
        : Array.from(query).length >= 3
          ? db.prepare("SELECT DISTINCT d.session_id AS id FROM search_index JOIN documents d ON d.id=search_index.rowid JOIN sessions s ON s.id=d.session_id WHERE search_index MATCH ? AND s.archived=? AND instr(d.body,?)>0 ORDER BY d.session_id LIMIT ? OFFSET ?").all(`"${query.replaceAll('"', '""')}"`, archived, query, limit + 1, offset)
          : db.prepare("SELECT DISTINCT d.session_id AS id FROM documents d JOIN sessions s ON s.id=d.session_id WHERE s.archived=? AND instr(d.body,?)>0 ORDER BY d.session_id LIMIT ? OFFSET ?").all(archived, query, limit + 1, offset);
      const ids = rows.slice(0, limit).map((row) => String(row.id));
      return { ids, nextOffset: offset + ids.length, hasMore: rows.length > limit };
    }
    case "performance": return Object.fromEntries(timings);
    case "close": db.close(); return null;
    default: throw new Error(`未知存储操作 ${type}`);
  }
}
parentPort!.on("message", ({ id, type, payload }: { id: number; type: string; payload: unknown }) => {
  const started = performance.now();
  try { parentPort!.postMessage({ id, data: handle(type, payload) }); }
  catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  finally { record(type, performance.now() - started); }
});
