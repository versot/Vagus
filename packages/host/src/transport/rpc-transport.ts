import { isRecord, parseRpcRequest, PROTOCOL_VERSION, RPC_LIMITS, RpcInputError, type RpcRequest } from "@vagus/protocol";
import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { WebSocketServer, type VerifyClientCallbackSync, type WebSocket } from "ws";

/** Bound queued output so a stalled local client cannot grow Host memory indefinitely. */
export function sendRpcMessage(client: WebSocket, encoded: string): boolean {
  if (client.readyState !== client.OPEN) return false;
  if (client.bufferedAmount + Buffer.byteLength(encoded) > RPC_LIMITS.outboundBufferedBytes) {
    client.close(1013, "Output backlog exceeded; reconnect to resync");
    return false;
  }
  client.send(encoded, error => { if (error) client.terminate(); });
  return true;
}

/** Share one encoded event across connections while isolating each output budget. */
export function broadcastRpcMessage(clients: Iterable<WebSocket>, encoded: string): void {
  for (const client of clients) sendRpcMessage(client, encoded);
}

export function hostAccess(environment: NodeJS.ProcessEnv = process.env) {
  const token = environment.VAGUS_HOST_TOKEN;
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) throw new Error("VAGUS_HOST_TOKEN must be a random 32-byte hexadecimal credential");
  const origins: unknown = JSON.parse(environment.VAGUS_ALLOWED_ORIGINS ?? '["http://tauri.localhost","https://tauri.localhost","tauri://localhost"]');
  if (!Array.isArray(origins) || !origins.length || !origins.every(value => typeof value === "string" && value !== "*" && value !== "null")) throw new Error("Invalid VAGUS_ALLOWED_ORIGINS");
  return { token, origins: new Set<string>(origins) };
}

export function createRpcTransport(server: Server, access: ReturnType<typeof hostAccess>, clients: Set<WebSocket>, handle: (client: WebSocket, request: RpcRequest) => Promise<void>) {
  const sockets = new Set<WebSocket>();
  const socketServer = new WebSocketServer({
    server, path: "/rpc", maxPayload: RPC_LIMITS.messageBytes, perMessageDeflate: false,
    verifyClient: (info: Parameters<VerifyClientCallbackSync>[0]) => sockets.size < RPC_LIMITS.connections && (!info.origin || access.origins.has(info.origin)),
  });
  socketServer.on("connection", client => {
    if (sockets.size >= RPC_LIMITS.connections) { client.close(1013, "Connection limit"); return; }
    sockets.add(client);
    let authenticated = false, inFlight = 0, invalid = 0, count = 0, windowStarted = Date.now();
    const replyError = (id: string | undefined, code: string, error: string) => {
      sendRpcMessage(client, JSON.stringify({ id, ok: false, code, error }));
    };
    const deadline = setTimeout(() => client.close(1008, "Authentication timeout"), RPC_LIMITS.authenticationMs);
    deadline.unref();
    client.on("error", () => { /* ws errors, including oversized frames, are isolated to this connection. */ });
    client.on("close", () => { clearTimeout(deadline); clients.delete(client); sockets.delete(client); });
    client.on("message", (raw, binary) => {
      let requestId: string | undefined;
      try {
        if (binary) throw new RpcInputError("INVALID_REQUEST", "Text requests required");
        if (Date.now() - windowStarted >= 1000) { windowStarted = Date.now(); count = 0; }
        if (++count > RPC_LIMITS.requestsPerSecond) { replyError(undefined, "OVERLOADED", "Request rate exceeded"); client.close(1008, "Request rate exceeded"); return; }
        const value: unknown = JSON.parse(raw.toString());
        if (isRecord(value) && typeof value.id === "string" && value.id.length <= 128) requestId = value.id;
        const request = parseRpcRequest(value);
        if (!authenticated) {
          if (request.type !== "host.authenticate") throw new RpcInputError("UNAUTHORIZED", "Authentication required");
          const supplied = Buffer.from(String(request.payload?.token ?? ""));
          const expected = Buffer.from(access.token);
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new RpcInputError("UNAUTHORIZED", "Authentication failed");
          if (request.payload?.version !== PROTOCOL_VERSION) throw new RpcInputError("INCOMPATIBLE_PROTOCOL", "Incompatible Host protocol");
          clearTimeout(deadline); authenticated = true; clients.add(client);
          sendRpcMessage(client, JSON.stringify({ id: request.id, ok: true, data: { authenticated: true, version: PROTOCOL_VERSION } }));
          return;
        }
        if (request.type === "host.authenticate") throw new RpcInputError("INVALID_REQUEST", "Already authenticated");
        if (inFlight >= RPC_LIMITS.inFlight) { replyError(request.id, "OVERLOADED", "Too many pending requests"); return; }
        inFlight++;
        void Promise.resolve().then(() => handle(client, request)).catch(() => replyError(request.id, "INTERNAL_ERROR", "Host request failed")).finally(() => { inFlight--; });
      } catch (error) {
        const code = error instanceof RpcInputError ? error.code : "INVALID_REQUEST";
        replyError(requestId, code, error instanceof RpcInputError ? error.message : "Invalid JSON");
        if (!authenticated || ++invalid >= 8) client.close(1008, "Request rejected");
      }
    });
  });
  return { close() { for (const socket of sockets) socket.terminate(); socketServer.close(); } };
}
