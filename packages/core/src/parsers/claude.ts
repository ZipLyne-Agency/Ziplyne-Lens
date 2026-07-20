import { inferProjectKey } from "../attribution.js";
import { calculateCost, costSourceFor, normalizeModel } from "../pricing.js";
import { estimatedPromptTokens, promptPreview } from "../prompts.js";
import type { ParseContext, PromptRecord, UsageEvent } from "../types.js";
import {
  dayFromTimestamp,
  idFromParts,
  linesFromJsonl,
  numberValue,
  objectValue,
  safeJson,
  sessionIdFromPath,
  stringValue,
  textFromContent,
} from "./helpers.js";

export function normalizeClaudeJsonl(
  jsonl: string,
  context: ParseContext,
): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const line of linesFromJsonl(jsonl)) {
    const raw = objectValue(safeJson(line));
    if (!raw) {
      continue;
    }
    const event = normalizeClaudeRecord(raw, context);
    if (event) {
      events.push(event);
    }
  }
  return events;
}

export function extractClaudePrompts(
  jsonl: string,
  context: ParseContext,
): PromptRecord[] {
  const prompts: PromptRecord[] = [];
  for (const line of linesFromJsonl(jsonl)) {
    const raw = objectValue(safeJson(line));
    if (!raw) {
      continue;
    }
    const prompt = extractClaudePrompt(raw, context);
    if (prompt) {
      prompts.push(prompt);
    }
  }
  return prompts;
}

function normalizeClaudeRecord(
  raw: Record<string, unknown>,
  context: ParseContext,
): UsageEvent | undefined {
  const wrapped = objectValue(raw.data)?.message;
  const record = objectValue(wrapped) ?? raw;
  const message = objectValue(record.message) ?? objectValue(raw.message);
  const usage = objectValue(message?.usage);
  if (!message || !usage) {
    return undefined;
  }
  const timestamp = stringValue(record.timestamp) ?? stringValue(raw.timestamp);
  const model = stringValue(message.model) ?? stringValue(record.model);
  if (!timestamp || !model) {
    return undefined;
  }
  const sessionId =
    stringValue(record.sessionId) ??
    stringValue(raw.sessionId) ??
    sessionIdFromPath(context.filePath);
  const cwd = stringValue(record.cwd) ?? stringValue(raw.cwd);
  const normalizedModel = normalizeModel(model);
  const inputTokens = numberValue(usage.input_tokens) ?? 0;
  const outputTokens = numberValue(usage.output_tokens) ?? 0;
  const cacheCreationTokens = cacheCreationTokenCount(usage);
  const cacheReadTokens = numberValue(usage.cache_read_input_tokens) ?? 0;
  const reasoningTokens = numberValue(usage.reasoning_output_tokens) ?? 0;
  const recordedCost = numberValue(record.costUSD) ?? numberValue(raw.costUSD);
  const calculated = calculateCost({
    model: normalizedModel,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    reasoningTokens,
  });

  return {
    id: idFromParts([
      "claude",
      sessionId,
      stringValue(message.id),
      stringValue(record.requestId),
      timestamp,
    ]),
    source: "claude",
    timestamp,
    day: dayFromTimestamp(timestamp),
    sessionId,
    projectKey: inferProjectKey(cwd, projectFromFilePath(context.filePath)),
    cwd,
    gitBranch: stringValue(record.gitBranch),
    ...(context.account ? { account: context.account } : {}),
    model: normalizedModel,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    reasoningTokens,
    totalTokens:
      inputTokens +
      outputTokens +
      cacheCreationTokens +
      cacheReadTokens +
      reasoningTokens,
    costUsd: recordedCost ?? calculated,
    costSource:
      recordedCost === undefined ? costSourceFor(normalizedModel) : "recorded",
  };
}

function extractClaudePrompt(
  raw: Record<string, unknown>,
  context: ParseContext,
): PromptRecord | undefined {
  const wrapped = objectValue(raw.data)?.message;
  const record = objectValue(wrapped) ?? raw;
  const message = objectValue(record.message) ?? objectValue(raw.message);
  if (!message || stringValue(message.role) !== "user") {
    return undefined;
  }
  // Meta records (Caveat/system-injected) and subagent sidechains carry
  // role:"user" but are not prompts the person typed.
  if (
    record.isMeta === true ||
    raw.isMeta === true ||
    record.isSidechain === true ||
    raw.isSidechain === true
  ) {
    return undefined;
  }
  // A user record whose content is a tool_result / tool_use array is a tool
  // turn (file reads, command output), not a prompt. Reject it outright — this
  // is what was surfacing raw source code as "prompts".
  if (isToolTurn(message.content)) {
    return undefined;
  }
  const timestamp = stringValue(record.timestamp) ?? stringValue(raw.timestamp);
  if (!timestamp) {
    return undefined;
  }
  const rawText = textFromContent(message.content);
  const content = rawText ? stripCommandWrappers(rawText) : undefined;
  if (!content) {
    return undefined;
  }
  const sessionId =
    stringValue(record.sessionId) ??
    stringValue(raw.sessionId) ??
    sessionIdFromPath(context.filePath);
  const cwd = stringValue(record.cwd) ?? stringValue(raw.cwd);
  const projectKey = inferProjectKey(
    cwd,
    projectFromFilePath(context.filePath),
  );
  return {
    id: idFromParts([
      "claude-prompt",
      sessionId,
      stringValue(record.promptId),
      stringValue(record.uuid),
      timestamp,
    ]),
    source: "claude",
    timestamp,
    day: dayFromTimestamp(timestamp),
    sessionId,
    projectKey,
    cwd,
    gitBranch: stringValue(record.gitBranch),
    model: stringValue(record.model),
    role: "user",
    preview: promptPreview(content),
    content,
    contentLength: content.length,
    estimatedTokens: estimatedPromptTokens(content),
    privacy: "plain",
    tags: tagsForPrompt(projectKey, content),
  };
}

function isToolTurn(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((item) => {
    const object = objectValue(item);
    const type = object && stringValue(object.type);
    return type === "tool_result" || type === "tool_use";
  });
}

// Slash-command invocations are logged wrapped in <command-name> / <command-args>
// tags (the text the user typed) alongside <local-command-stdout>/<stderr> blocks
// (the command's OUTPUT). Drop the output blocks entirely — that output is not a
// prompt — then strip the remaining wrapper tags so the invocation reads cleanly.
function stripCommandWrappers(text: string): string {
  return text
    .replace(
      /<local-command-(?:stdout|stderr)>[\s\S]*?<\/local-command-(?:stdout|stderr)>/giu,
      " ",
    )
    .replace(/<\/?(?:command-[a-z-]+|local-command-[a-z-]+)>/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function cacheCreationTokenCount(usage: Record<string, unknown>): number {
  const cacheCreation = objectValue(usage.cache_creation);
  if (cacheCreation) {
    return (
      (numberValue(cacheCreation.ephemeral_5m_input_tokens) ?? 0) +
      (numberValue(cacheCreation.ephemeral_1h_input_tokens) ?? 0)
    );
  }
  return numberValue(usage.cache_creation_input_tokens) ?? 0;
}

function projectFromFilePath(filePath: string): string {
  const marker = "/projects/";
  const index = filePath.indexOf(marker);
  if (index < 0) {
    return filePath;
  }
  const rest = filePath.slice(index + marker.length);
  return rest.split("/")[0] ?? filePath;
}

function tagsForPrompt(
  projectKey: string,
  content: string | undefined,
): string[] {
  const tags = new Set<string>();
  for (const chunk of projectKey.split(/[\s/_-]+/u)) {
    if (chunk.length > 2) {
      tags.add(chunk.toLowerCase());
    }
  }
  const text = content?.toLowerCase() ?? "";
  for (const keyword of ["auth", "api", "db", "sql", "ui", "test", "deploy"]) {
    if (text.includes(keyword)) {
      tags.add(keyword);
    }
  }
  return [...tags].slice(0, 6);
}
