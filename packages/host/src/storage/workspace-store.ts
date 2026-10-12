import type { ScheduledTask, SessionHistoryPage, SessionQueryMarker, SessionTimelineEntry } from "@vagus/protocol";
import { Worker } from "node:worker_threads";
import type { Project, SessionMetadata } from "./workspace-records.js";

const MAX_PENDING_STORE_REQUESTS = 128;

export class WorkspaceStore {
  private readonly worker: Worker;
  private nextId = 0;
  private failure: Error | undefined;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>();
  constructor(dataDir: string) {
    this.worker = new Worker(new URL("./workspace-store-worker.js", import.meta.url), { workerData: { dataDir } });
    this.worker.on("message", (reply: { id: number; data?: unknown; error?: string }) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply.data);
    });
    const fail = (error: Error) => { this.failure = error; for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); };
    this.worker.on("error", fail);
    this.worker.on("exit", (code) => { if (code !== 0 || this.pending.size) fail(new Error(`历史存储进程已退出 (${code})`)); });
  }
  request<T>(type: string, payload?: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= MAX_PENDING_STORE_REQUESTS) return Promise.reject(new Error("历史存储请求队列已满"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try { this.worker.postMessage({ id, type, payload }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  load() { return this.request<{ projects: Project[]; sessions: SessionMetadata[] }>("load"); }
  save(projects: Project[], sessions: SessionMetadata[], entries: Array<{ sessionId: string; entry: SessionTimelineEntry }>) { return this.request<void>("save", { projects, sessions, entries }); }
  read(sessionId: string) { return this.request<SessionTimelineEntry[]>("read", { sessionId }); }
  history(sessionId: string, options: { limit?: number; beforeSequence?: number }) { return this.request<SessionHistoryPage>("history", { sessionId, ...options }); }
  entry(sessionId: string, entryId: string) { return this.request<SessionTimelineEntry>("entry", { sessionId, entryId }); }
  markers(sessionId: string) { return this.request<SessionQueryMarker[]>("markers", { sessionId }); }
  search(query: string, archived: boolean, options: { limit?: number; offset?: number } = {}) { return this.request<import("@vagus/protocol").SessionSearchPage>("search", { query, archived, ...options }); }
  scheduledTasks() { return this.request<ScheduledTask[]>("scheduled-tasks.list"); }
  putScheduledTask(task: ScheduledTask) { return this.request<ScheduledTask>("scheduled-tasks.put", task); }
  deleteScheduledTask(id: string) { return this.request<number>("scheduled-tasks.delete", { id }); }
  async close() { await this.request("close"); await this.worker.terminate(); }
}
