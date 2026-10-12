import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { createHost } from './runtime/create-host.js';
import { createRpcTransport } from "./transport/rpc-transport.js";

const ctx = createHost();

await ctx.loadDatabase();

await ctx.recoverScheduledTasks();

await ctx.loadProviderModelCache();

await ctx.loadProviderSettings();

const httpServer = createServer((request, response) => {
  if (request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ready: true })); return; }
  response.writeHead(404); response.end();
});

const socketServer = createRpcTransport(httpServer, ctx.access, ctx.clients, ctx.handle);
ctx.shutdown = shutdown;

httpServer.listen(ctx.port, "127.0.0.1", () => {
  process.stdout.write(`VAGUS_HOST_READY ${ctx.port}\n`);
  for (const provider of ctx.providers.values()) {
    if (provider.listModels) void ctx.refreshProviderModels(provider.descriptor.id).catch(() => undefined);
  }
});

let shutdownPromise: Promise<void> | undefined;

function shutdown(): Promise<void> {
  return shutdownPromise ??= finishShutdown();
}

async function finishShutdown(): Promise<void> {
  clearInterval(scheduledTaskRunner);
  for (const flush of ctx.sessionEmitterFlushers.values()) flush();
  await Promise.all([...ctx.liveAgents.values()].map((agent) => agent.dispose().catch(() => undefined)));
  if (ctx.writeTimer) { clearTimeout(ctx.writeTimer); ctx.writeTimer = undefined; }
  await ctx.persistNow();
  await ctx.writeQueue;
  await ctx.store.close();
  socketServer.close(); httpServer.close();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));

process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

if (process.env.VAGUS_MANAGED_HOST === "1") {
  const lifecycle = createInterface({ input: process.stdin });
  lifecycle.on("line", (line) => { if (line === "shutdown") void shutdown().finally(() => process.exit(0)); });
  lifecycle.on("close", () => void shutdown().finally(() => process.exit(0)));
}

const idleAgentReclaimer = setInterval(() => { void ctx.reclaimIdleAgents(); }, ctx.idleAgentSweepMs);

idleAgentReclaimer.unref?.();

const scheduledTaskRunner = setInterval(() => { void ctx.runDueScheduledTasks().catch((error) => process.stderr.write(`Vagus scheduled task scan failed: ${String(error)}\n`)); }, 10_000);

scheduledTaskRunner.unref?.();

void ctx.runDueScheduledTasks();
