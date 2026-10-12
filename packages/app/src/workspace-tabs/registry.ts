import type { HostClient } from "@vagus/client";
import type { BrowserElementReference } from "@vagus/protocol";
import { useSyncExternalStore, type ComponentType, type MouseEvent as ReactMouseEvent } from "react";
import i18n from "../locales/i18n.js";

export type WorkspaceTabId = string;
export interface WorkspaceTabContext {
  sessionId: string | null;
  projectId: string | null;
  cwd: string | null;
  host: HostClient;
  openUrl?(url: string): void;
  attachBrowserElement?(input: { element: BrowserElementReference; imageDataUrl?: string; fileName?: string }): void;
}

export interface WorkspaceTabInstance {
  id: WorkspaceTabId;
  type: string;
  /** Tab-container state shared by the shell; feature payloads remain module-owned. */
  metadata: WorkspaceTabMetadata;
  payload: unknown;
}

export interface WorkspaceTabMetadata {
  /** Most recent page-provided title for definitions with dynamicTitle. */
  title?: string;
  /** Optional page-provided icon URL for definitions with dynamicIcon. */
  iconUrl?: string;
  /** User override for definitions with renameable enabled. */
  userTitle?: string;
}

export interface WorkspaceTabPageProps<T = unknown> {
  instance: WorkspaceTabInstance & { payload: T };
  context: WorkspaceTabContext;
  visible: boolean;
  title: string;
  onRename?(name: string): void;
  onUpdateTitle?(title: string): void;
  onUpdateFavicon?(faviconUrl: string | null): void;
  onShowTooltip?(event: ReactMouseEvent<HTMLElement>, label: string): void;
  onHideTooltip?(): void;
}

export interface WorkspaceTabDefinition<T = unknown> {
  type: string;
  titleKey: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  instancePolicy: "single" | "multiple";
  /** The page can publish a current title through the generic metadata callback. */
  dynamicTitle?: boolean;
  /** The page can publish a favicon or equivalent small icon URL. */
  dynamicIcon?: boolean;
  /** Allows the user to name this instance. */
  renameable?: boolean;
  component: ComponentType<WorkspaceTabPageProps<T>>;
  /** Validate external input and capture initial state, such as a terminal's directory. */
  createPayload(context: WorkspaceTabContext, input: unknown): T;
  closeLabelKey?: string;
  temporary?: boolean;
  availableInPicker?: boolean;
  panelClassName?: string;
}

// This registry contains trusted, bundled UI modules. It does not load executable packages.
const definitions = new Map<string, WorkspaceTabDefinition>();
const subscribers = new Set<() => void>();
let snapshot: readonly WorkspaceTabDefinition[] = [];

export function registerWorkspaceTab<T>(definition: WorkspaceTabDefinition<T>): void {
  if (!/^[a-z][a-z0-9-]*$/.test(definition.type) || ["chat", "picker"].includes(definition.type)) {
    throw new Error(`Invalid or reserved workspace tab type: ${definition.type}`);
  }
  if (definitions.has(definition.type)) throw new Error(`Workspace tab already registered: ${definition.type}`);
  // Payloads enter only through this definition's factory and reach its own component.
  definitions.set(definition.type, Object.freeze({ ...definition }) as WorkspaceTabDefinition);
  snapshot = [...definitions.values()];
  for (const subscriber of subscribers) subscriber();
}

export function getWorkspaceTabDefinition(type: string): WorkspaceTabDefinition {
  const definition = definitions.get(type);
  if (!definition) throw new Error(`Unknown workspace tab type: ${type}`);
  return definition;
}

export function useWorkspaceTabDefinitions() {
  return useSyncExternalStore(subscriber => {
    subscribers.add(subscriber);
    return () => { subscribers.delete(subscriber); };
  }, () => snapshot);
}

export interface WorkspaceTabItem {
  id: WorkspaceTabId;
  title: string;
  icon: WorkspaceTabDefinition["icon"];
  closeLabel: string;
  temporary?: boolean;
  faviconUrl?: string;
}

export function workspaceTabItems(instances: readonly WorkspaceTabInstance[]): WorkspaceTabItem[] {
  const items: WorkspaceTabItem[] = [];
  const typeCounts = new Map<string, number>();
  for (const instance of instances) {
    const definition = definitions.get(instance.type);
    if (!definition) continue;
    const index = (typeCounts.get(instance.type) ?? 0) + 1;
    typeCounts.set(instance.type, index);
    const suffix = definition.instancePolicy === "multiple" ? ` ${index}` : "";
    const userTitle = definition.renameable ? instance.metadata.userTitle : undefined;
    const pageTitle = definition.dynamicTitle ? instance.metadata.title : undefined;
    const title = (typeof userTitle === "string" && userTitle.trim() ? userTitle.trim()
      : typeof pageTitle === "string" && pageTitle.trim() ? pageTitle.trim()
        : i18n.t(definition.titleKey) + suffix);
    const faviconUrl = definition.dynamicIcon ? instance.metadata.iconUrl : undefined;
    items.push({
      id: instance.id, title, icon: definition.icon, temporary: definition.temporary,
      ...(typeof faviconUrl === "string" && faviconUrl ? { faviconUrl } : {}),
      closeLabel: definition.closeLabelKey ? i18n.t(definition.closeLabelKey) + suffix : `${i18n.t("关闭")} ${title}`,
    });
  }
  return items;
}
