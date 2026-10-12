import { type AgentEvent } from "@vagus/protocol";
import type { WebSocket } from "ws";
import type { HostContext } from "../runtime/host-context.js";
import { broadcastRpcMessage, sendRpcMessage } from "./rpc-transport.js";

export interface MessagingServicesContract {
  send(client: WebSocket, value: unknown): void;
  broadcast(event: AgentEvent): void;
  respond(client: WebSocket, id: string, data?: unknown, error?: string): void;
}

type MessagingServicesDependencies = Pick<HostContext, "clients" | "recordPerformance" | "sessionSubscriptions">;

export function createMessagingServices(ctx: MessagingServicesDependencies): MessagingServicesContract {
  function send(client: WebSocket, value: unknown): void {
    const started = performance.now();
    const encoded = JSON.stringify(value);
    ctx.recordPerformance("response.serialize", performance.now() - started);
    sendRpcMessage(client, encoded);
  }

  function broadcast(event: AgentEvent): void {
    const started = performance.now();
    const encoded = JSON.stringify({ type: "event", event });
    ctx.recordPerformance("event.serialize", performance.now() - started);
    const sessionId = "sessionId" in event ? event.sessionId : undefined;
    const isHighFrequency = event.type === "message.delta" || event.type === "tool.updated"
      || (event.type === "message.started" && Boolean(event.attachments?.length));
    broadcastRpcMessage(isHighFrequency && sessionId ? [...ctx.clients].filter((client) => ctx.sessionSubscriptions.get(client) === sessionId) : ctx.clients, encoded);
  }

  function respond(client: WebSocket, id: string, data?: unknown, error?: string): void {
    send(client, error ? { id, ok: false, error } : { id, ok: true, data });
  }
  return { send, broadcast, respond };
}
