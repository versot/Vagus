import { CreateElicitationRequest, type ElicitationPropertySchema } from "@agentclientprotocol/sdk";
import type { UserInteraction } from "@vagus/protocol";

export function elicitationField(id: string, property: ElicitationPropertySchema, required: boolean): Extract<UserInteraction, { kind: "form" }>["fields"][number] {
  const base = { id, label: typeof property.title === "string" && property.title ? property.title : id, ...(typeof property.description === "string" && property.description ? { description: property.description } : {}), required };
  if (property.type === "boolean") return { ...base, type: "boolean", ...("default" in property && typeof property.default === "boolean" ? { defaultValue: property.default } : {}) };
  if (property.type === "number" || property.type === "integer") return { ...base, type: "number", ...(property.type === "integer" ? { integer: true } : {}), ...("minimum" in property && typeof property.minimum === "number" ? { minimum: property.minimum } : {}), ...("maximum" in property && typeof property.maximum === "number" ? { maximum: property.maximum } : {}), ...("default" in property && typeof property.default === "number" ? { defaultValue: property.default } : {}) };
  if (property.type === "array") {
    const items = "items" in property ? property.items : undefined;
    const options = items && typeof items === "object" && "enum" in items && Array.isArray(items.enum)
      ? items.enum.filter((item): item is string => typeof item === "string").map((value) => ({ value, label: value }))
      : items && typeof items === "object" && "anyOf" in items && Array.isArray(items.anyOf)
        ? items.anyOf.flatMap((option) => "const" in option && typeof option.const === "string" ? [{ value: option.const, label: typeof option.title === "string" ? option.title : option.const, ...(typeof option.description === "string" ? { description: option.description } : {}) }] : []) : [];
    return { ...base, type: "multi-choice", options, ...("minItems" in property && typeof property.minItems === "number" ? { minItems: property.minItems } : {}), ...("maxItems" in property && typeof property.maxItems === "number" ? { maxItems: property.maxItems } : {}) };
  }
  if (property.type === "string" && (("enum" in property && Array.isArray(property.enum)) || ("oneOf" in property && Array.isArray(property.oneOf)))) {
    const options = "oneOf" in property && Array.isArray(property.oneOf) ? property.oneOf.flatMap((option) => "const" in option && typeof option.const === "string" ? [{ value: option.const, label: typeof option.title === "string" ? option.title : option.const, ...(typeof option.description === "string" ? { description: option.description } : {}) }] : []) : (("enum" in property && Array.isArray(property.enum) ? property.enum : []) as string[]).map((value) => ({ value, label: value }));
    return { ...base, type: "choice", options, ...("default" in property && typeof property.default === "string" ? { defaultValue: property.default } : {}) };
  }
  return { ...base, type: "text", ...("minLength" in property && typeof property.minLength === "number" ? { minLength: property.minLength } : {}), ...("maxLength" in property && typeof property.maxLength === "number" ? { maxLength: property.maxLength } : {}), ...("pattern" in property && typeof property.pattern === "string" ? { pattern: property.pattern } : {}), ...("format" in property && typeof property.format === "string" ? { format: property.format } : {}), ...("default" in property && typeof property.default === "string" ? { defaultValue: property.default } : {}) };
}

export function validElicitationContent(content: Record<string, unknown>, params: CreateElicitationRequest): content is Record<string, string | number | boolean | string[]> {
  if (!CreateElicitationRequest.isForm(params)) return false;
  const schema = params.requestedSchema;
  for (const [id, value] of Object.entries(content)) {
    const field = schema.properties?.[id];
    if (!field) return false;
    if (field.type === "string" && typeof value !== "string" || (field.type === "number" || field.type === "integer") && typeof value !== "number" || field.type === "boolean" && typeof value !== "boolean") return false;
    if (field.type === "array" && (!Array.isArray(value) || !value.every((item) => typeof item === "string"))) return false;
    if (field.type === "string" && typeof value === "string") {
      if ("minLength" in field && typeof field.minLength === "number" && value.length < field.minLength) return false;
      if ("maxLength" in field && typeof field.maxLength === "number" && value.length > field.maxLength) return false;
      if ("pattern" in field && typeof field.pattern === "string") { try { if (!new RegExp(field.pattern).test(value)) return false; } catch { return false; } }
      if ("enum" in field && Array.isArray(field.enum) && !field.enum.includes(value)) return false;
      if ("oneOf" in field && Array.isArray(field.oneOf) && !field.oneOf.some((option) => "const" in option && option.const === value)) return false;
    }
    if ((field.type === "number" || field.type === "integer") && typeof value === "number") {
      if (field.type === "integer" && !Number.isInteger(value)) return false;
      if ("minimum" in field && typeof field.minimum === "number" && value < field.minimum) return false;
      if ("maximum" in field && typeof field.maximum === "number" && value > field.maximum) return false;
    }
    if (field.type === "array" && Array.isArray(value)) {
      if ("minItems" in field && typeof field.minItems === "number" && value.length < field.minItems) return false;
      if ("maxItems" in field && typeof field.maxItems === "number" && value.length > field.maxItems) return false;
      if ("items" in field) {
        const items = field.items;
        const allowed = items && typeof items === "object" && "enum" in items && Array.isArray(items.enum) ? items.enum : items && typeof items === "object" && "anyOf" in items && Array.isArray(items.anyOf) ? items.anyOf.flatMap((option) => "const" in option && typeof option.const === "string" ? [option.const] : []) : null;
        if (allowed && value.some((item) => !allowed.includes(item))) return false;
      }
    }
  }
  return (schema.required ?? []).every((id) => Object.prototype.hasOwnProperty.call(content, id));
}
