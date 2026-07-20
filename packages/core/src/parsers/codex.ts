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

export function normalizeCodexJsonl(
  jsonl: string,
  context: ParseContext,
): UsageEvent[] {
  const events: UsageEvent[] = [];
  let cwd: string | undefined;
  let model: string | undefined;
  let previousTotal: CodexUsage | undefined;
  const sessionId = sessionIdFromPath(context.filePath);

  for (const line of linesFromJsonl(jsonl)) {
    const raw = objectValue(safeJson(line));
    if (!raw) {
      continue;
    }
    const payload = objectValue(raw.payload);
    if (raw.type === "turn_context") {
      cwd = stringValue(payload?.cwd) ?? cwd;
      model = stringValue(payload?.model) ?? model;
      continue;
    }
    if (raw.type === "turn.completed") {
      const usage = codexUsageFromObject(objectValue(raw.usage));
      const timestamp = stringValue(raw.timestamp);
      model = stringValue(raw.model) ?? stringValue(raw.model_name) ?? model;
      if (usage && timestamp && model) {
        events.push(
          toEvent(usage, { context, cwd, model, sessionId, timestamp }),
        );
      }
      continue;
    }
    if (raw.type !== "event_msg" || payload?.type !== "token_count") {
      continue;
    }
    const info = objectValue(payload.info);
    const timestamp = stringValue(raw.timestamp);
    const currentModel =
      stringValue(info?.model) ??
      stringValue(payload.model) ??
      stringValue(payload.model_name) ??
      model;
    const last = codexUsageFromObject(objectValue(info?.last_token_usage));
    const total = codexUsageFromObject(objectValue(info?.total_token_usage));
    const usage = last ?? diffUsage(total, previousTotal);
    if (total) {
      previousTotal = total;
    }
    if (usage && timestamp && currentModel) {
      events.push(
        toEvent(usage, {
          context,
          cwd,
          model: currentModel,
          sessionId,
          timestamp,
        }),
      );
    }
  }
  return events;
}

export function extractCodexPrompts(
  jsonl: string,
  context: ParseContext,
): PromptRecord[] {
  // Two signals for a typed Codex prompt. Prefer `user_message` events (they
  // contain only what the person typed); fall back to response_item messages
  // with role "user" for older logs that lack them.
  const userMessages: PromptRecord[] = [];
  const responseItems: PromptRecord[] = [];
  let cwd: string | undefined;
  let model: string | undefined;
  const sessionId = sessionIdFromPath(context.filePath);

  for (const line of linesFromJsonl(jsonl)) {
    const raw = objectValue(safeJson(line));
    if (!raw) {
      continue;
    }
    const payload = objectValue(raw.payload);
    if (raw.type === "turn_context") {
      cwd = stringValue(payload?.cwd) ?? cwd;
      model = stringValue(payload?.model) ?? model;
      continue;
    }
    if (raw.type === "event_msg" && payload?.type === "user_message") {
      const message = stringValue(payload.message);
      if (message && !isInjectedContext(message)) {
        userMessages.push(
          toPrompt(message, {
            context,
            cwd,
            model,
            sessionId,
            timestamp: stringValue(raw.timestamp),
            idPart: "user-message",
          }),
        );
      }
      continue;
    }
    if (raw.type === "response_item" && payload?.type === "message") {
      if (stringValue(payload.role) !== "user") {
        continue;
      }
      const timestamp = stringValue(raw.timestamp);
      const content = textFromContent(payload.content);
      const encrypted = Boolean(payload.encrypted_content);
      if (content && !isInjectedContext(content)) {
        responseItems.push(
          toPrompt(content, {
            context,
            cwd,
            model,
            sessionId,
            timestamp,
            idPart: stringValue(payload.id) ?? stringValue(payload.call_id),
          }),
        );
      } else if (!content && encrypted && timestamp) {
        responseItems.push({
          id: idFromParts(["codex-prompt", sessionId, timestamp, "encrypted"]),
          source: "codex",
          timestamp,
          day: dayFromTimestamp(timestamp),
          sessionId,
          projectKey: inferProjectKey(cwd, context.filePath),
          cwd,
          model,
          role: "user",
          preview: "Encrypted Codex prompt",
          contentLength: 0,
          estimatedTokens: 0,
          privacy: "encrypted",
          tags: ["encrypted"],
        });
      }
    }
  }
  // Merge both signals. A resumed / rolled-over session replays prior turns as
  // response_item messages WITHOUT re-emitting their user_message events, while
  // new turns emit user_message events. Keep every user_message plus any
  // response_item whose text isn't already represented, so a resume loses no
  // history and nothing gets double-counted.
  const seen = new Set(
    userMessages
      .map((prompt) => normalizeForDedup(prompt.content))
      .filter(Boolean),
  );
  const merged = [...userMessages];
  for (const prompt of responseItems) {
    const key = normalizeForDedup(prompt.content);
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    merged.push(prompt);
  }
  merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return merged;
}

function normalizeForDedup(content: string | undefined): string {
  return (content ?? "").replace(/\s+/gu, " ").trim();
}

// The first Codex message in a session is the injected AGENTS.md / environment
// context, not a typed prompt. Anchor to the start of the text so a prompt that
// merely *mentions* one of these markers (common when the topic is agent
// tooling) is not silently dropped.
function isInjectedContext(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("# AGENTS.md") ||
    trimmed.startsWith("<INSTRUCTIONS>") ||
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<user_instructions>")
  );
}

interface CodexUsage {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

interface EventContext {
  context: ParseContext;
  cwd?: string;
  model: string;
  sessionId: string;
  timestamp: string;
}

interface PromptContext {
  context: ParseContext;
  cwd?: string;
  model?: string;
  sessionId: string;
  timestamp?: string;
  idPart?: string;
}

function toPrompt(content: string, promptContext: PromptContext): PromptRecord {
  const timestamp = promptContext.timestamp ?? new Date(0).toISOString();
  const projectKey = inferProjectKey(
    promptContext.cwd,
    promptContext.context.filePath,
  );
  return {
    id: idFromParts([
      "codex-prompt",
      promptContext.sessionId,
      promptContext.idPart,
      timestamp,
    ]),
    source: "codex",
    timestamp,
    day: dayFromTimestamp(timestamp),
    sessionId: promptContext.sessionId,
    projectKey,
    cwd: promptContext.cwd,
    model: promptContext.model
      ? normalizeModel(promptContext.model)
      : undefined,
    role: "user",
    preview: promptPreview(content),
    content,
    contentLength: content.length,
    estimatedTokens: estimatedPromptTokens(content),
    privacy: "plain",
    tags: tagsForPrompt(projectKey, content),
  };
}

function toEvent(usage: CodexUsage, eventContext: EventContext): UsageEvent {
  const model = normalizeModel(eventContext.model);
  const nonCachedInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
  const costUsd = calculateCost({
    model,
    inputTokens: nonCachedInput,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: usage.cacheReadTokens,
    reasoningTokens: usage.reasoningTokens,
  });
  return {
    id: idFromParts([
      "codex",
      eventContext.sessionId,
      eventContext.timestamp,
      model,
      usage.totalTokens,
    ]),
    source: "codex",
    timestamp: eventContext.timestamp,
    day: dayFromTimestamp(eventContext.timestamp),
    sessionId: eventContext.sessionId,
    projectKey: inferProjectKey(
      eventContext.cwd,
      eventContext.context.filePath,
    ),
    cwd: eventContext.cwd,
    model,
    inputTokens: nonCachedInput,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: usage.cacheReadTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    costUsd,
    costSource: costSourceFor(model),
  };
}

function codexUsageFromObject(
  raw: Record<string, unknown> | undefined,
): CodexUsage | undefined {
  if (!raw) {
    return undefined;
  }
  const promptTokens = numberValue(raw.prompt_tokens);
  const completionTokens = numberValue(raw.completion_tokens);
  const inputTokens = numberValue(raw.input_tokens) ?? promptTokens ?? 0;
  const cacheReadTokens =
    numberValue(raw.cached_input_tokens) ?? numberValue(raw.cached_tokens) ?? 0;
  const outputTokens = numberValue(raw.output_tokens) ?? completionTokens ?? 0;
  const reasoningTokens = numberValue(raw.reasoning_output_tokens) ?? 0;
  const totalTokens =
    numberValue(raw.total_tokens) ??
    inputTokens + outputTokens + reasoningTokens;
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    reasoningTokens === 0
  ) {
    return undefined;
  }
  return {
    inputTokens,
    cacheReadTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  };
}

function diffUsage(
  current: CodexUsage | undefined,
  previous: CodexUsage | undefined,
): CodexUsage | undefined {
  if (!current) {
    return undefined;
  }
  if (!previous) {
    return current;
  }
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cacheReadTokens: Math.max(
      0,
      current.cacheReadTokens - previous.cacheReadTokens,
    ),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningTokens: Math.max(
      0,
      current.reasoningTokens - previous.reasoningTokens,
    ),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
  };
}

function tagsForPrompt(projectKey: string, content: string): string[] {
  const tags = new Set<string>();
  for (const chunk of projectKey.split(/[\s/_-]+/u)) {
    if (chunk.length > 2) {
      tags.add(chunk.toLowerCase());
    }
  }
  const text = content.toLowerCase();
  for (const keyword of ["auth", "api", "db", "sql", "ui", "test", "deploy"]) {
    if (text.includes(keyword)) {
      tags.add(keyword);
    }
  }
  return [...tags].slice(0, 6);
}
