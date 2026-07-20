import { basename, dirname } from "node:path";

export function linesFromJsonl(jsonl: string): string[] {
  return jsonl
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function safeJson(line: string): unknown | undefined {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function dayFromTimestamp(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export function sessionIdFromPath(filePath: string): string {
  return (
    basename(filePath).replace(/\.jsonl$/u, "") ||
    basename(dirname(filePath)) ||
    "unknown"
  );
}

export function idFromParts(parts: Array<string | number | undefined>): string {
  return parts.filter((part) => part !== undefined && part !== "").join(":");
}

export function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      const object = objectValue(item);
      if (!object) {
        return "";
      }
      // Only text blocks carry a user's words. Explicitly never pull the body
      // of tool_result / tool_use / image blocks — those are tool I/O, not
      // prompts, and the old `?? object.content` fallback was surfacing them.
      const type = stringValue(object.type);
      if (type === "text" || type === "input_text") {
        return stringValue(object.text) ?? "";
      }
      if (!type) {
        return stringValue(object.text) ?? "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}
