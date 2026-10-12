import { type ClaudeRecord } from "./types.js";

export function isObject(value: unknown): value is ClaudeRecord { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export function claudeSdkModelDiagnostic(line: string): string | undefined {
  const match = line.match(/\[claude-code:unrecognized_model\]\s*(\{[^\r\n]*\})/u);
  if (!match) return undefined;
  try {
    const data: unknown = JSON.parse(match[1]!);
    if (!isObject(data) || data.query_source !== "sdk" || typeof data.model !== "string") return undefined;
    const model = data.model.replace(/[^\w.-]/gu, "").slice(0, 100);
    if (!model) return undefined;
    return `本机模型网关拒绝了 Claude Agent SDK 子代理请求（模型 ${model}）。请检查网关是否支持该模型的 SDK 子代理请求，或在 Claude Code 中改用网关支持的模型。`;
  } catch { return undefined; }
}

export async function withTimeout<T>(promise: Promise<T>, message: string, milliseconds = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref?.();
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer!); }
}
