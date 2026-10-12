import { createProviderCatalogServices } from "../agent/provider-catalog.js";
import { createProviderRequestHandler } from "../agent/provider-requests.js";
import { createProjectRequestHandler } from "../projects/requests.js";
import { createPerformanceServices } from "../runtime/performance.js";
import { createRpcDispatcher } from "../runtime/rpc-dispatcher.js";
import { createSystemRequestHandler } from "../runtime/system-requests.js";
import { createScheduledTaskRequestHandler } from "../scheduling/requests.js";
import { createSchedulerServices } from "../scheduling/task-scheduler.js";
import { createSessionControlRequestHandler } from "../sessions/control-requests.js";
import { createSessionHistoryRequestHandler } from "../sessions/history-requests.js";
import { createSessionLifecycleRequestHandler } from "../sessions/lifecycle-requests.js";
import { createPromptContentServices } from "../sessions/prompt-content.js";
import { createSessionEventServices } from "../sessions/session-events.js";
import { createSessionRuntimeServices } from "../sessions/session-runtime.js";
import { createHistoryServices } from "../storage/workspace-history.js";
import { createMessagingServices } from "../transport/messaging.js";
import { createWorkspaceRequestHandler } from "../workspace/requests.js";
import type { HostContext } from "./host-context.js";
import { createHostState } from "./host-state.js";

export function createHost(): HostContext {
  const ctx = createHostState() as HostContext;
  Object.assign(
    ctx,
    createPerformanceServices(ctx),
    createHistoryServices(ctx),
    createProviderCatalogServices(ctx),
    createSessionRuntimeServices(ctx),
    createSessionEventServices(ctx),
    createMessagingServices(ctx),
    createSchedulerServices(ctx),
    createPromptContentServices(),
    createSystemRequestHandler(ctx),
    createWorkspaceRequestHandler(ctx),
    createProviderRequestHandler(ctx),
    createProjectRequestHandler(ctx),
    createScheduledTaskRequestHandler(ctx),
    createSessionHistoryRequestHandler(ctx),
    createSessionLifecycleRequestHandler(ctx),
    createSessionControlRequestHandler(ctx),
    createRpcDispatcher(ctx),
  );

  return ctx;
}
