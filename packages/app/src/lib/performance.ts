type Sample = { count: number; totalMs: number; maxMs: number; recentMs: number[] };
type MemorySnapshot = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
const samples = new Map<string, Sample>();
let enabled = false;
let observers: PerformanceObserver[] = [];
try { enabled = localStorage.getItem("vagus.profile") === "1"; } catch { /* Storage may be unavailable. */ }

function startObservers() {
  if (typeof PerformanceObserver === "undefined" || observers.length) return;
  for (const entryType of ["longtask", "gc"]) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entryType === "longtask") recordPerformance("browser.longtask", entry.duration);
          else {
            const kind = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind;
            recordPerformance(`browser.gc.${kind ?? "unknown"}`, entry.duration);
          }
        }
      });
      observer.observe({ entryTypes: [entryType] });
      observers.push(observer);
    } catch { /* Some WebView versions do not expose every entry type. */ }
  }
}

function stopObservers() {
  for (const observer of observers) observer.disconnect();
  observers = [];
}

export const appPerformance = {
  enable(value = true) {
    enabled = value;
    if (enabled) startObservers();
    else stopObservers();
  },
  reset() { samples.clear(); },
  snapshot() {
    const metrics = Object.fromEntries([...samples].map(([name, sample]) => {
      const sorted = [...sample.recentMs].sort((a, b) => a - b);
      return [name, { count: sample.count, meanMs: sample.totalMs / sample.count, maxMs: sample.maxMs, p95Ms: sorted[Math.floor((sorted.length - 1) * .95)] ?? 0 }];
    }));
    const memory = (performance as Performance & { memory?: MemorySnapshot }).memory;
    return {
      capturedAt: new Date().toISOString(),
      metrics,
      ...(memory ? { memory: { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit } } : {}),
    };
  },
};

export function recordPerformance(name: string, elapsed: number) {
  if (!enabled || !Number.isFinite(elapsed) || elapsed < 0 || (!samples.has(name) && samples.size >= 40)) return;
  const sample = samples.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, recentMs: [] };
  sample.count++; sample.totalMs += elapsed; sample.maxMs = Math.max(sample.maxMs, elapsed);
  sample.recentMs.push(elapsed);
  if (sample.recentMs.length > 120) sample.recentMs.shift();
  samples.set(name, sample);
}

/** Records animation-frame intervals only for the lifetime of an active pointer drag. */
export function beginFrameCapture(name: string): () => void {
  if (!enabled) return () => undefined;
  let frame = 0;
  let previous = 0;
  let stopped = false;
  const tick = (now: number) => {
    if (stopped) return;
    if (previous > 0) recordPerformance(`${name}.frame`, now - previous);
    previous = now;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => { stopped = true; cancelAnimationFrame(frame); };
}

declare global {
  interface Window { vagusPerformance: typeof appPerformance }
}
window.vagusPerformance = appPerformance;
if (enabled) startObservers();
