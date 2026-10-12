/** Owns asynchronous acquisitions even when their page is disposed before completion. */
export class AsyncScope {
  private disposed = false;
  private cleanups = new Set<() => void | Promise<unknown>>();
  get active() { return !this.disposed; }
  add(cleanup: () => void | Promise<unknown>) {
    if (this.disposed) { void Promise.resolve().then(cleanup).catch(() => { }); return false; }
    this.cleanups.add(cleanup); return true;
  }
  async acquire<T>(create: () => Promise<T>, release: (value: T) => void | Promise<unknown>): Promise<T | undefined> {
    if (this.disposed) return undefined;
    const value = await create();
    if (this.disposed) { await release(value); return undefined; }
    this.add(() => release(value)); return value;
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const cleanups = [...this.cleanups]; this.cleanups.clear();
    await Promise.allSettled(cleanups.map(cleanup => Promise.resolve().then(cleanup)));
  }
}
