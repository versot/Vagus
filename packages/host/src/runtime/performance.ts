
import type { HostContext } from "./host-context.js";

export interface PerformanceServicesContract {
  recordPerformance(name: string, elapsed: number): void;
}

type PerformanceServicesDependencies = Pick<HostContext, "performanceStats">;

export function createPerformanceServices(ctx: PerformanceServicesDependencies): PerformanceServicesContract {
  function recordPerformance(name: string, elapsed: number) {
    if (!ctx.performanceStats.has(name) && ctx.performanceStats.size >= 64) return;
    const stats = ctx.performanceStats.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    stats.count++; stats.totalMs += elapsed; stats.maxMs = Math.max(stats.maxMs, elapsed);
    ctx.performanceStats.set(name, stats);
  }
  return { recordPerformance };
}
