import { CreateElicitationRequest, type ElicitationPropertySchema } from "@agentclientprotocol/sdk";

export function elicitationField(id: string, property: ElicitationPropertySchema, required: boolean) {
  const base = {
    id,
    label: typeof property.title === "string" && property.title ? property.title : id,
    ...(typeof property.description === "string" && property.description ? { description: property.description } : {}),
    required,
  };
  if (property.type === "boolean") return { ...base, type: "boolean" as const, ...("default" in property && typeof property.default === "boolean" ? { defaultValue: property.default } : {}) };
  if (property.type === "number" || property.type === "integer") return {
    ...base, type: "number" as const,
    ...(property.type === "integer" ? { integer: true } : {}),
    ...("minimum" in property && typeof property.minimum === "number" ? { minimum: property.minimum } : {}),
    ...("maximum" in property && typeof property.maximum === "number" ? { maximum: property.maximum } : {}),
    ...("default" in property && typeof property.default === "number" ? { defaultValue: property.default } : {}),
  };
  if (property.type === "array") {
    const items = "items" in property ? property.items : undefined;
    const options = items && typeof items === "object" && "enum" in items && Array.isArray(items.enum)
      ? items.enum.filter((item): item is string => typeof item === "string").map((value) => ({ value, label: value }))
      : items && typeof items === "object" && "anyOf" in items && Array.isArray(items.anyOf)
        ? items.anyOf.flatMap((option) => {
          if (!("const" in option) || typeof option.const !== "string") return [];
          const meta = option._meta?.["_claude/askUserQuestionOption"];
          const preview = meta && typeof meta === "object" && "preview" in meta && typeof meta.preview === "string" ? meta.preview : undefined;
          return [{ value: option.const, label: typeof option.title === "string" ? option.title : option.const, ...(option.description ? { description: option.description } : {}), ...(preview ? { preview } : {}) }];
        })
        : [];
    return {
      ...base, type: "multi-choice" as const, options,
      ...("minItems" in property && typeof property.minItems === "number" ? { minItems: property.minItems } : {}),
      ...("maxItems" in property && typeof property.maxItems === "number" ? { maxItems: property.maxItems } : {}),
      ...("default" in property && Array.isArray(property.default) ? { defaultValue: property.default.filter((item): item is string => typeof item === "string") } : {}),
    };
  }
  const options = property.type === "string"
    ? "oneOf" in property && Array.isArray(property.oneOf) && property.oneOf.length
      ? property.oneOf.flatMap((option) => {
        if (typeof option.const !== "string" || typeof option.title !== "string") return [];
        const meta = option._meta?.["_claude/askUserQuestionOption"];
        const preview = meta && typeof meta === "object" && "preview" in meta && typeof meta.preview === "string" ? meta.preview : undefined;
        return [{ value: option.const, label: option.title, ...(option.description ? { description: option.description } : {}), ...(preview ? { preview } : {}) }];
      })
      : "enum" in property && Array.isArray(property.enum) ? property.enum.filter((value): value is string => typeof value === "string").map((value) => ({ value, label: value })) : []
    : [];
  return {
    ...base, type: options.length ? "choice" as const : "text" as const,
    ...(options.length ? { options } : {}),
    ...("minLength" in property && typeof property.minLength === "number" ? { minLength: property.minLength } : {}),
    ...("maxLength" in property && typeof property.maxLength === "number" ? { maxLength: property.maxLength } : {}),
    ...("pattern" in property && typeof property.pattern === "string" ? { pattern: property.pattern } : {}),
    ...("format" in property && typeof property.format === "string" ? { format: property.format } : {}),
    ...("default" in property && typeof property.default === "string" ? { defaultValue: property.default } : {}),
  };
}

export function validElicitationContent(content: Record<string, string | number | boolean | string[]>, params: CreateElicitationRequest): boolean {
  if (params.mode !== "form") return false;
  const schema = params.requestedSchema as import("@agentclientprotocol/sdk").ElicitationSchema;
  const required = new Set(schema.required ?? []);
  for (const [id, value] of Object.entries(content)) {
    const field = schema.properties?.[id];
    if (!field) return false;
    if (field.type === "string" && typeof value !== "string") return false;
    if ((field.type === "number" || field.type === "integer") && typeof value !== "number") return false;
    if (field.type === "boolean" && typeof value !== "boolean") return false;
    if (field.type === "array" && (!Array.isArray(value) || !value.every((item) => typeof item === "string"))) return false;
    if (field.type === "string" && typeof value === "string" && "minLength" in field && typeof field.minLength === "number" && value.length < field.minLength) return false;
    if (field.type === "string" && typeof value === "string" && "maxLength" in field && typeof field.maxLength === "number" && value.length > field.maxLength) return false;
    if (field.type === "string" && typeof value === "string" && "pattern" in field && typeof field.pattern === "string") {
      try { if (!new RegExp(field.pattern).test(value)) return false; } catch { return false; }
    }
    if (field.type === "array" && Array.isArray(value) && "items" in field) {
      const items = field.items;
      const allowed = items && typeof items === "object" && "enum" in items && Array.isArray(items.enum) ? items.enum : items && typeof items === "object" && "anyOf" in items && Array.isArray(items.anyOf) ? items.anyOf.flatMap((item) => "const" in item && typeof item.const === "string" ? [item.const] : []) : null;
      if (allowed && value.some((item) => !allowed.includes(item))) return false;
    }
    if (field.type === "array" && Array.isArray(value) && "minItems" in field && typeof field.minItems === "number" && value.length < field.minItems) return false;
    if (field.type === "array" && Array.isArray(value) && "maxItems" in field && typeof field.maxItems === "number" && value.length > field.maxItems) return false;
    if (field.type === "string" && "enum" in field && Array.isArray(field.enum) && !field.enum.includes(value as string)) return false;
    if (field.type === "string" && "oneOf" in field && Array.isArray(field.oneOf) && !field.oneOf.some((option) => "const" in option && option.const === value)) return false;
    if ((field.type === "number" || field.type === "integer") && typeof value === "number" && "minimum" in field && typeof field.minimum === "number" && value < field.minimum) return false;
    if ((field.type === "number" || field.type === "integer") && typeof value === "number" && "maximum" in field && typeof field.maximum === "number" && value > field.maximum) return false;
    if (field.type === "integer" && typeof value === "number" && !Number.isInteger(value)) return false;
  }
  return [...required].every((id) => Object.prototype.hasOwnProperty.call(content, id));
}
