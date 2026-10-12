import type { UserInteraction } from "@vagus/protocol";
import { type CodexElicitationMapping, type CodexUserInputFieldMapping, type PendingInteraction } from "./types.js";
import { isRecord } from "./utils.js";

export const CODEX_OTHER_OPTION_VALUE = "__vagus_other__";

export function mapCodexUserInputQuestions(questions: unknown): { interaction: Extract<UserInteraction, { kind: "form" }>; mappings: CodexUserInputFieldMapping[] } | null {
  if (!Array.isArray(questions) || questions.length < 1) return null;
  const rows = questions.filter(isRecord);
  if (rows.length !== questions.length || rows.some((question) => question.isSecret === true || typeof question.id !== "string" || !question.id.trim())) return null;
  const ids = new Set(rows.map((question) => String(question.id)));
  if (ids.size !== rows.length) return null;
  const fields: Extract<UserInteraction, { kind: "form" }>['fields'] = [];
  const mappings: CodexUserInputFieldMapping[] = [];
  for (const [index, question] of rows.entries()) {
    const questionId = String(question.id);
    const options = Array.isArray(question.options) ? question.options.flatMap((option) => isRecord(option) && typeof option.label === "string" ? [{ value: option.label, label: option.label, ...(typeof option.description === "string" && option.description ? { description: option.description } : {}) }] : []) : [];
    const field: Extract<UserInteraction, { kind: "form" }>['fields'][number] = {
      id: questionId,
      label: typeof question.header === "string" && question.header.trim() ? question.header : `问题 ${index + 1}`,
      ...(typeof question.question === "string" && question.question ? { description: question.question } : {}),
      type: options.length ? "choice" : "text",
      required: true,
      ...(options.length ? { options } : {}),
    };
    const mapping: CodexUserInputFieldMapping = { questionId };
    if (options.length && question.isOther === true) {
      let otherFieldId = `${questionId}__vagus_other`;
      while (ids.has(otherFieldId)) otherFieldId = `${otherFieldId}_`;
      ids.add(otherFieldId);
      field.options = [...options, { value: CODEX_OTHER_OPTION_VALUE, label: "其他（填写下方内容）" }];
      fields.push(field, { id: otherFieldId, label: "补充回答", description: `选择“${field.label}”中的其他选项时填写`, type: "text", required: false });
      mapping.otherFieldId = otherFieldId;
      mapping.otherOptionValue = CODEX_OTHER_OPTION_VALUE;
    } else {
      fields.push(field);
    }
    mappings.push(mapping);
  }
  return { interaction: { kind: "form", title: "Codex 需要确认", fields }, mappings };
}

export function mapCodexUserInputAnswers(value: string | boolean | null, mappings: readonly CodexUserInputFieldMapping[]): { answers: Record<string, { answers: string[] }> } {
  let form: Record<string, unknown> = {};
  if (typeof value === "string") {
    try { const parsed: unknown = JSON.parse(value); if (isRecord(parsed)) form = parsed; } catch { /* Invalid form responses resolve unanswered rather than hanging the native request. */ }
  }
  const entries = mappings.map((mapping) => {
    let answer = form[mapping.questionId];
    if (answer === mapping.otherOptionValue && mapping.otherFieldId) answer = form[mapping.otherFieldId];
    return [mapping.questionId, { answers: typeof answer === "string" && answer.length ? [answer] : [] }] as const;
  });
  return { answers: Object.fromEntries(entries) };
}

export function codexElicitationOptions(value: unknown): Array<{ value: string; label: string }> | null {
  if (!isRecord(value)) return null;
  if (Array.isArray(value.enum)) return value.enum.flatMap((entry) => typeof entry === "string" ? [{ value: entry, label: entry }] : []);
  const titled = Array.isArray(value.oneOf) ? value.oneOf : Array.isArray(value.anyOf) ? value.anyOf : null;
  if (!titled) return null;
  return titled.flatMap((entry) => isRecord(entry) && typeof entry.const === "string" ? [{ value: entry.const, label: typeof entry.title === "string" ? entry.title : entry.const }] : []);
}

export function codexElicitationFields(schemaValue: unknown): Extract<UserInteraction, { kind: "form" }>['fields'] | null {
  if (!isRecord(schemaValue) || !isRecord(schemaValue.properties)) return null;
  const entries = Object.entries(schemaValue.properties);
  if (entries.length === 0 || entries.length > 100) return null;
  const required = new Set(Array.isArray(schemaValue.required) ? schemaValue.required.filter((value): value is string => typeof value === "string") : []);
  const fields: Extract<UserInteraction, { kind: "form" }>['fields'] = [];
  for (const [id, rawSchema] of entries) {
    if (!id || !isRecord(rawSchema)) return null;
    const title = typeof rawSchema.title === "string" && rawSchema.title.trim() ? rawSchema.title : id;
    const description = typeof rawSchema.description === "string" ? rawSchema.description : undefined;
    const base = { id, label: title, ...(description ? { description } : {}), required: required.has(id) };
    const type = rawSchema.type;
    if (type === "array") {
      const options = codexElicitationOptions(rawSchema.items);
      if (!options?.length || !isRecord(rawSchema.items) || rawSchema.items.type !== "string") return null;
      fields.push({ ...base, type: "multi-choice", options, ...(Array.isArray(rawSchema.default) ? { defaultValue: rawSchema.default.filter((value): value is string => typeof value === "string") } : {}), ...(typeof rawSchema.minItems === "number" ? { minItems: rawSchema.minItems } : {}), ...(typeof rawSchema.maxItems === "number" ? { maxItems: rawSchema.maxItems } : {}) });
      continue;
    }
    const options = codexElicitationOptions(rawSchema);
    if (type === "string" && options !== null) {
      if (!options.length) return null;
      fields.push({ ...base, type: "choice", options, ...(typeof rawSchema.default === "string" ? { defaultValue: rawSchema.default } : {}) });
      continue;
    }
    if (type === "string") {
      fields.push({ ...base, type: "text", ...(typeof rawSchema.default === "string" ? { defaultValue: rawSchema.default } : {}), ...(typeof rawSchema.minLength === "number" ? { minLength: rawSchema.minLength } : {}), ...(typeof rawSchema.maxLength === "number" ? { maxLength: rawSchema.maxLength } : {}), ...(typeof rawSchema.pattern === "string" ? { pattern: rawSchema.pattern } : {}), ...(typeof rawSchema.format === "string" ? { format: rawSchema.format } : {}) });
      continue;
    }
    if (type === "number" || type === "integer") {
      fields.push({ ...base, type: "number", ...(typeof rawSchema.default === "number" ? { defaultValue: rawSchema.default } : {}), ...(typeof rawSchema.minimum === "number" ? { minimum: rawSchema.minimum } : {}), ...(typeof rawSchema.maximum === "number" ? { maximum: rawSchema.maximum } : {}), ...(type === "integer" ? { integer: true } : {}) });
      continue;
    }
    if (type === "boolean") {
      fields.push({ ...base, type: "boolean", ...(typeof rawSchema.default === "boolean" ? { defaultValue: rawSchema.default } : {}) });
      continue;
    }
    return null;
  }
  return fields;
}

export function mapCodexElicitationRequest(value: unknown): CodexElicitationMapping | null {
  if (!isRecord(value) || typeof value.mode !== "string") return null;
  const serverName = typeof value.serverName === "string" && value.serverName.trim() ? value.serverName : "MCP";
  const meta = isRecord(value._meta) ? value._meta : null;
  if (value.mode === "form" && meta?.codex_approval_kind === "mcp_tool_call" && typeof value.message === "string") {
    const schema = isRecord(value.requestedSchema) ? value.requestedSchema : null;
    if (!schema || schema.type !== "object" || !isRecord(schema.properties) || Object.keys(schema.properties).length !== 0) return null;
    const persistence = Array.isArray(meta.persist) ? meta.persist : [meta.persist];
    const labels = ["允许本次"];
    const approvalPersistence: Record<string, "session" | "always"> = {};
    if (persistence.includes("session")) {
      labels.push("本会话允许");
      approvalPersistence["本会话允许"] = "session";
    }
    if (persistence.includes("always")) {
      labels.push("始终允许");
      approvalPersistence["始终允许"] = "always";
    }
    labels.push("拒绝");
    const toolName = typeof meta.tool_name === "string" && meta.tool_name.trim()
      ? meta.tool_name
      : typeof meta.tool_title === "string" && meta.tool_title.trim() ? meta.tool_title : "MCP 工具";
    const description = typeof meta.tool_description === "string" && meta.tool_description.trim() ? meta.tool_description : null;
    const displayParams = meta.tool_params_display;
    const rawParams = meta.tool_params;
    const displayedParams = displayParams !== undefined && displayParams !== null && !(Array.isArray(displayParams) && displayParams.length === 0)
      ? displayParams
      : rawParams;
    let parameterText = "";
    if (displayedParams !== undefined && displayedParams !== null) {
      try { parameterText = `\n\n参数：\n${JSON.stringify(displayedParams, null, 2).slice(0, 6000)}`; } catch { parameterText = ""; }
    }
    const optionHints = ["仅运行这一次"];
    if (approvalPersistence["本会话允许"]) optionHints.push("在当前 Codex 会话中记住授权");
    if (approvalPersistence["始终允许"]) optionHints.push("在后续 Codex 会话中记住授权");
    optionHints.push("拒绝这次工具调用");
    return {
      interaction: {
        kind: "choice",
        title: "Codex MCP 工具审批",
        message: `${serverName} 请求运行工具“${toolName}”。${description ? `\n\n${description}` : ""}${parameterText}\n\n${value.message}`,
        options: labels,
        optionHints,
      },
      mode: value.mode,
      labels,
      approvalPersistence,
    };
  }
  if (value.mode === "url" && typeof value.url === "string" && typeof value.message === "string") {
    try {
      const url = new URL(value.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      return { interaction: { kind: "url-consent", title: `${serverName} 请求打开链接`, message: value.message, url: url.toString(), host: url.host }, mode: value.mode, labels: ["打开链接"] };
    } catch { return null; }
  }
  if (value.mode === "openai/userVerification" && typeof value.title === "string" && typeof value.description === "string" && typeof value.challenge === "string") {
    return { interaction: { kind: "choice", title: value.title, message: `${value.description}\n\n${value.challenge}`, options: ["继续", "取消"] }, mode: value.mode, labels: ["继续"] };
  }
  if ((value.mode === "form" || value.mode === "openai/form" || value.mode === "openaiForm") && typeof value.message === "string") {
    const fields = codexElicitationFields(value.requestedSchema);
    if (!fields) return null;
    return { interaction: { kind: "form", title: `${serverName} 请求输入`, message: value.message, fields }, mode: value.mode, labels: [] };
  }
  return null;
}

export function mapCodexElicitationResponse(value: string | boolean | null, mode: string, labels: readonly string[], approvalPersistence?: Readonly<Record<string, "session" | "always">>): { action: "accept" | "decline" | "cancel"; content: unknown; _meta: Record<string, string> | null } {
  if (value === null) return { action: "cancel", content: null, _meta: null };
  if (approvalPersistence) {
    const selected = typeof value === "string" ? value : value === true ? labels[0] : null;
    if (selected === labels[0]) return { action: "accept", content: {}, _meta: null };
    const persist = selected ? approvalPersistence[selected] : undefined;
    if (persist) return { action: "accept", content: {}, _meta: { persist } };
    return { action: "decline", content: null, _meta: null };
  }
  const isForm = mode === "form" || mode === "openai/form" || mode === "openaiForm";
  if (isForm) {
    if (typeof value !== "string") return { action: "decline", content: null, _meta: null };
    let content: unknown;
    try { content = JSON.parse(value); } catch { return { action: "decline", content: null, _meta: null }; }
    return isRecord(content) ? { action: "accept", content, _meta: null } : { action: "decline", content: null, _meta: null };
  }
  const accepted = value === true || value === "accept" || value === labels[0];
  if (!accepted) return { action: "decline", content: null, _meta: null };
  return { action: "accept", content: null, _meta: null };
}

export function codexInteractionCancellationResponse(pending: Pick<PendingInteraction, "method" | "questionId" | "questionMappings" | "elicitationMode" | "elicitationApprovalPersistence" | "labels">): Record<string, unknown> {
  if (pending.method === "mcpServer/elicitation/request") return mapCodexElicitationResponse(null, pending.elicitationMode ?? "", pending.labels, pending.elicitationApprovalPersistence);
  if (pending.method === "item/tool/requestUserInput") {
    return pending.questionMappings
      ? mapCodexUserInputAnswers(null, pending.questionMappings)
      : { answers: pending.questionId ? { [pending.questionId]: { answers: [] } } : {} };
  }
  if (pending.method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  return { decision: "cancel" };
}
