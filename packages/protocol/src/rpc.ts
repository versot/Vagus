import type { RpcCommand, RpcInput, RpcRequest } from "./workspace.js";
export type { RpcCommand, RpcInput, RpcOutput, RpcRequest } from "./workspace.js";

/** Limits apply to incoming requests, including base64 image attachments. */
export const RPC_LIMITS = Object.freeze({ messageBytes: 16 * 1024 * 1024, outboundBufferedBytes: 32 * 1024 * 1024, connections: 32, inFlight: 16, authenticationMs: 8_000, requestsPerSecond: 120 });
export type RpcErrorCode = "INVALID_REQUEST" | "UNKNOWN_COMMAND" | "UNAUTHORIZED" | "INCOMPATIBLE_PROTOCOL" | "OVERLOADED" | "INTERNAL_ERROR";
export interface RpcSuccessResponse<T> { id: string; ok: true; data: T }
/** Business failures may omit code until they are mapped to a stable domain error. */
export interface RpcFailureResponse { id: string; ok: false; error: string; code?: RpcErrorCode }
export interface RpcEventEnvelope<T> { type: "event"; event: T }
export class RpcInputError extends Error {
  constructor(readonly code: RpcErrorCode, message: string) { super(message); }
}
export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
type Field = (value: unknown) => boolean;
const string = (max: number): Field => value => typeof value === "string" && value.length <= max;
const id: Field = value => typeof value === "string" && value.length > 0 && value.length <= 180;
const scheduleTime: Field = value => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const boolean: Field = value => typeof value === "boolean";
const integer: Field = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullable = (field: Field): Field => value => value === null || field(value);
const oneOf = (...values: string[]): Field => value => typeof value === "string" && values.includes(value);
const matches = (pattern: RegExp, max: number): Field => value => typeof value === "string" && value.length <= max && pattern.test(value);
const array = (max: number, field: Field): Field => value => Array.isArray(value) && value.length <= max && value.every(field);
interface Schema { required?: readonly string[]; fields: Record<string, Field> }
type SchemaFor<K extends RpcCommand> = {
  required?: readonly (keyof RpcInput<K> & string)[];
  fields: Record<keyof RpcInput<K> & string, Field>;
};
const session = { required: ["sessionId"] as const, fields: { sessionId: id } };
const provider = { required: ["providerId"] as const, fields: { providerId: id } };
const project = { required: ["projectId"] as const, fields: { projectId: id } };
const schemas = {
  "host.authenticate": { required: ["token", "version"], fields: { token: string(256), version: integer } },
  "host.capabilities": { fields: {} }, "host.performance": { fields: { enabled: boolean } }, "host.shutdown": { fields: {} },
  "workspace.snapshot": { fields: {} },
  "workspace.git-review": { required: ["projectId", "scope"], fields: { projectId: id, scope: oneOf("staged", "unstaged") } },
  "workspace.git-patch": { required: ["projectId", "scope", "path"], fields: { projectId: id, scope: oneOf("staged", "unstaged"), path: string(32768) } },
  "providers.set-enabled": { required: ["providerId", "enabled"], fields: { providerId: id, enabled: boolean } },
  "providers.models": provider, "providers.models.refresh": provider, "providers.extensions": provider, "providers.plugins": provider, "providers.mcp": provider,
  "providers.plugins.install": { required: ["providerId", "pluginId"], fields: { providerId: id, pluginId: matches(/^[\w.-]+(?:@[\w.-]+)?$/u, 300), scope: oneOf("user", "project", "local"), acceptCommandSha256: matches(/^[a-f0-9]{64}$/iu, 64) } },
  "providers.plugins.manage": { required: ["providerId", "pluginId", "action"], fields: { providerId: id, pluginId: matches(/^[\w.-]+(?:@[\w.-]+)?$/u, 300), action: oneOf("enable", "disable", "uninstall"), scope: oneOf("user", "project", "local") } },
  "providers.plugins.marketplace": { required: ["providerId", "action"], fields: { providerId: id, action: oneOf("add", "update", "remove"), source: string(4096), name: string(200), scope: oneOf("user", "project", "local") } },
  "providers.mcp.detail": { required: ["providerId", "serverName"], fields: { providerId: id, serverName: string(128) } },
  "providers.packages.install": { required: ["providerId", "source"], fields: { providerId: id, source: string(32768) } },
  "providers.sessions.importable": provider,
  "projects.create": { required: ["name"], fields: { name: string(180), root: string(32768), roots: array(32, string(32768)) } },
  "projects.update": { required: ["projectId", "name"], fields: { projectId: id, name: string(180), root: string(32768), roots: array(32, string(32768)) } },
  "projects.remove": project,
  "sessions.create": { fields: { projectId: nullable(id), providerId: id, modelId: nullable(string(1024)), thinkingLevel: nullable(string(128)), modeId: nullable(string(128)) } },
  "scheduled-tasks.list": { fields: {} },
  "scheduled-tasks.create": { required: ["projectId", "prompt", "providerId", "modelId", "frequency", "weekday", "time", "timeZone", "enabled"], fields: { projectId: nullable(id), prompt: string(1024 * 1024), providerId: id, modelId: string(1024), thinkingLevel: nullable(string(128)), modeId: nullable(string(128)), frequency: oneOf("once", "daily", "weekdays", "weekly"), weekday: nullable((value): value is number => typeof value === "number" && integer(value) && value <= 6), time: scheduleTime, timeZone: string(128), enabled: boolean } },
  "scheduled-tasks.update": { required: ["taskId", "prompt", "frequency", "weekday", "time", "timeZone"], fields: { taskId: id, prompt: string(1024 * 1024), frequency: oneOf("once", "daily", "weekdays", "weekly"), weekday: nullable((value): value is number => typeof value === "number" && integer(value) && value <= 6), time: scheduleTime, timeZone: string(128) } },
  "scheduled-tasks.set-enabled": { required: ["taskId", "enabled"], fields: { taskId: id, enabled: boolean } },
  "scheduled-tasks.run-now": { required: ["taskId"], fields: { taskId: id } },
  "scheduled-tasks.delete": { required: ["taskId"], fields: { taskId: id } },
  "sessions.import": { required: ["providerId", "sourceId"], fields: { providerId: id, sourceId: id } },
  "sessions.open": { ...session, fields: { sessionId: id, historyLimit: integer } },
  "sessions.history": { ...session, fields: { sessionId: id, limit: integer, beforeSequence: integer } },
  "sessions.entry": { required: ["sessionId", "entryId"], fields: { sessionId: id, entryId: id } },
  "sessions.subscribe": { required: ["sessionId"], fields: { sessionId: nullable(id) } },
  "sessions.search": { fields: { query: string(4096), archived: boolean, limit: integer, offset: integer } },
  "sessions.branch": { ...session, fields: { sessionId: id, messageId: string(180) } },
  "sessions.archive": session, "sessions.unarchive": session,
  "sessions.rename": { required: ["sessionId", "title"], fields: { sessionId: id, title: string(180) } },
  "sessions.archive-in-project": project, "sessions.delete-archived": session, "sessions.delete-permanent": session,
  "sessions.delete-archived-in-project": project, "sessions.delete-archived-all": { fields: {} },
  "sessions.send": { ...session, fields: { sessionId: id, text: string(1024 * 1024), clientMessageId: string(128), deliveryMode: oneOf("immediate", "steer", "follow-up"), attachments: array(4, isRecord), browserElements: array(20, isRecord) } },
  "sessions.clear-queue": session, "sessions.cancel": session, "sessions.cancel-subagent": { required: ["sessionId", "subagentSessionId"], fields: { sessionId: id, subagentSessionId: id } }, "sessions.get-settings": session,
  "sessions.get-commands": session, "sessions.get-usage": session,
  "sessions.execute-command": { ...session, fields: { sessionId: id, action: oneOf("goal", "review", "mcp-status", "fast-mode", "feedback"), input: string(4000) } },
  "sessions.compact": { ...session, fields: { sessionId: id, instructions: string(4000) } },
  "sessions.set-auto-compaction": { required: ["sessionId", "enabled"], fields: { sessionId: id, enabled: boolean } },
  "sessions.set-model": { required: ["sessionId", "modelId"], fields: { sessionId: id, modelId: string(1024) } },
  "sessions.set-thinking-level": { required: ["sessionId", "level"], fields: { sessionId: id, level: string(128) } },
  "sessions.set-mode": { required: ["sessionId", "modeId"], fields: { sessionId: id, modeId: string(128) } },
  "interactions.respond": { required: ["sessionId", "interactionId", "value"], fields: { sessionId: id, interactionId: id, value: value => value === null || boolean(value) || string(1024 * 1024)(value) } },
  "sessions.ui-input": { required: ["sessionId", "widgetKey", "input"], fields: { sessionId: id, widgetKey: string(1024), input: string(65536) } },
  "sessions.editor-text.dismiss": { required: ["sessionId", "requestId"], fields: { sessionId: id, requestId: id } },
} satisfies { [K in RpcCommand]: SchemaFor<K> };
export function parseRpcRequest(value: unknown): RpcRequest {
  if (!isRecord(value) || !id(value.id) || String(value.id).length > 128 || typeof value.type !== "string" || value.type.length > 80) throw new RpcInputError("INVALID_REQUEST", "Invalid request envelope");
  const schema: Schema | undefined = Object.hasOwn(schemas, value.type) ? schemas[value.type as RpcCommand] : undefined;
  if (!schema) throw new RpcInputError("UNKNOWN_COMMAND", "Unknown command");
  if (value.payload !== undefined && !isRecord(value.payload)) throw new RpcInputError("INVALID_REQUEST", "Invalid payload");
  const payload = value.payload as Record<string, unknown> | undefined ?? {};
  if (Object.keys(value).some(key => !["id", "type", "payload"].includes(key)) || Object.keys(payload).some(key => !Object.hasOwn(schema.fields, key))) throw new RpcInputError("INVALID_REQUEST", "Unknown request field");
  for (const key of schema.required ?? []) if (!Object.hasOwn(payload, key)) throw new RpcInputError("INVALID_REQUEST", `Missing ${key}`);
  for (const [key, field] of Object.entries(schema.fields)) if (Object.hasOwn(payload, key) && !field(payload[key])) throw new RpcInputError("INVALID_REQUEST", `Invalid ${key}`);
  return { id: value.id as string, type: value.type, payload } as RpcRequest;
}
