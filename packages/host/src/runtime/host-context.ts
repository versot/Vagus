import type { ProviderCatalogServicesContract } from "../agent/provider-catalog.js";
import type { ProviderRequestHandlerContract } from "../agent/provider-requests.js";
import type { ProjectRequestHandlerContract } from "../projects/requests.js";
import type { ScheduledTaskRequestHandlerContract } from "../scheduling/requests.js";
import type { SchedulerServicesContract } from "../scheduling/task-scheduler.js";
import type { SessionControlRequestHandlerContract } from "../sessions/control-requests.js";
import type { SessionHistoryRequestHandlerContract } from "../sessions/history-requests.js";
import type { SessionLifecycleRequestHandlerContract } from "../sessions/lifecycle-requests.js";
import type { PromptContentServicesContract } from "../sessions/prompt-content.js";
import type { SessionEventServicesContract } from "../sessions/session-events.js";
import type { SessionRuntimeServicesContract } from "../sessions/session-runtime.js";
import type { HistoryServicesContract } from "../storage/workspace-history.js";
import type { MessagingServicesContract } from "../transport/messaging.js";
import type { WorkspaceRequestHandlerContract } from "../workspace/requests.js";
import type { HostState } from "./host-state.js";
import type { PerformanceServicesContract } from "./performance.js";
import type { RpcDispatcherContract } from "./rpc-dispatcher.js";
import type { SystemRequestHandlerContract } from "./system-requests.js";

/** Services share one Host state; each factory has an explicit contract and no startup side effects. */
export type HostContext = HostState
  & PerformanceServicesContract
  & HistoryServicesContract
  & ProviderCatalogServicesContract
  & SessionRuntimeServicesContract
  & SessionEventServicesContract
  & MessagingServicesContract
  & SchedulerServicesContract
  & PromptContentServicesContract
  & SystemRequestHandlerContract
  & WorkspaceRequestHandlerContract
  & ProviderRequestHandlerContract
  & ProjectRequestHandlerContract
  & ScheduledTaskRequestHandlerContract
  & SessionHistoryRequestHandlerContract
  & SessionLifecycleRequestHandlerContract
  & SessionControlRequestHandlerContract
  & RpcDispatcherContract
  & { shutdown(): Promise<void> };
