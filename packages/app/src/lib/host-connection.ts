import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { HostClient, type HostConnection } from "@vagus/client";

/** Credentials come from the trusted desktop bridge, never from a URL or storage. */
export function createDesktopHostClient() {
  const client = new HostClient(undefined, {
    autoReconnect: true, getConnection: async () => {
      if ("__TAURI_INTERNALS__" in window) return invoke<HostConnection>("host_connection");
      // Explicit browser-only development; production requires the desktop bridge.
      if (import.meta.env.DEV && import.meta.env.VITE_VAGUS_HOST_TOKEN) return { url: "ws://127.0.0.1:4317/rpc", token: import.meta.env.VITE_VAGUS_HOST_TOKEN };
      throw new Error("请从 Vagus 桌面应用连接本机 Host");
    }
  });
  if ("__TAURI_INTERNALS__" in window) {
    void listen<string>("host-lifecycle", event => {
      if (event.payload === "ready") void client.reconnect().catch(() => undefined);
    });
  }
  return client;
}
