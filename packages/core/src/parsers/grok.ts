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

export function normalizeGrokJsonl(
  jsonl: string,
  context: ParseContext,
): UsageEvent[] {
  const events: UsageEvent[] = [];
  const { sessionId, cwd } = grokSessionFromPath(context.filePath);

  for (const line of linesFromJsonl(jsonl)) {
    const raw = objectValue(safeJson(line));
    if (!raw) {
      continue;
    }
    const update = objectValue(objectValue(raw.params)?.update);
    if (stringValue(update?.sessionUpdate) !== "turn_completed") {
      continue;
    }
    const seconds = numberValue(raw.timestamp);
    const rawUsage = objectValue(update?.usage);
    if (!rawUsage || !seconds) {
      continue;
    }
    const timestamp = new Date(seconds * 1_000).toISOString();
    const promptId = stringValue(update?.prompt_id);
    // turn_completed breaks usage down per model; emit one event per model so
    // mixed-model turns price each model at its own rate.
    const modelUsage = objectValue(rawUsage.modelUsage);
    for (const [modelName, entry] of Object.entries(modelUsage ?? {})) {
      const usage = grokUsageFromObject(objectValue(entry));
      if (!usage) {
        continue;
      }
      events.push(
        toEvent(usage, {
          context,
          cwd,
          model: modelName,
          promptId,
          sessionId,
          timestamp,
        }),
      );
    }
  }
  return events;
}

export function extractGrokPrompts(
  jsonl: string,
  context: ParseContext,
): PromptRecord[] {
  const prompts: PromptRecord[] = [];
  const { sessionId, cwd } = grokSessionFromPath(context.filePath);

  for (const line of linesFromJsonl(jsonl)) {
    const raw = objectValue(safeJson(line));
    if (!raw) {
      continue;
    }
    const update = objectValue(objectValue(raw.params)?.update);
    if (stringValue(update?.sessionUpdate) !== "user_message_chunk") {
      continue;
    }
    // user_message_chunk carries one full typed message per line, so there is
    // no injected environment context to strip; empty chunks carry no text.
    const block = objectValue(update?.content);
    const content = textFromContent(block ? [block] : undefined);
    const seconds = numberValue(raw.timestamp);
    if (!content || !seconds) {
      continue;
    }
    const timestamp = new Date(seconds * 1_000).toISOString();
    const meta = objectValue(update?._meta);
    const model = stringValue(meta?.modelId);
    const projectKey = inferProjectKey(cwd, context.filePath);
    prompts.push({
      id: idFromParts([
        "grok-prompt",
        sessionId,
        numberValue(meta?.promptIndex),
        timestamp,
      ]),
      source: "grok",
      timestamp,
      day: dayFromTimestamp(timestamp),
      sessionId,
      projectKey,
      cwd,
      model: model ? normalizeModel(model) : undefined,
      role: "user",
      preview: promptPreview(content),
      content,
      contentLength: content.length,
      estimatedTokens: estimatedPromptTokens(content),
      privacy: "plain",
      tags: tagsForPrompt(projectKey, content),
    });
  }
  return prompts;
}

interface GrokUsage {
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
  promptId?: string;
  sessionId: string;
  timestamp: string;
}

function toEvent(usage: GrokUsage, eventContext: EventContext): UsageEvent {
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
      "grok",
      eventContext.sessionId,
      eventContext.promptId,
      eventContext.timestamp,
      model,
      usage.totalTokens,
    ]),
    source: "grok",
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

function grokUsageFromObject(
  raw: Record<string, unknown> | undefined,
): GrokUsage | undefined {
  if (!raw) {
    return undefined;
  }
  const inputTokens = numberValue(raw.inputTokens) ?? 0;
  const cacheReadTokens = numberValue(raw.cachedReadTokens) ?? 0;
  const outputTokens = numberValue(raw.outputTokens) ?? 0;
  const reasoningTokens = numberValue(raw.reasoningTokens) ?? 0;
  const totalTokens =
    numberValue(raw.totalTokens) ?? inputTokens + outputTokens;
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

// ~/.grok/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl — the session
// id and working directory live in the path, not in the records.
function grokSessionFromPath(filePath: string): {
  sessionId: string;
  cwd?: string;
} {
  const match = filePath.match(
    /\/sessions\/([^/]+)\/([^/]+)\/updates\.jsonl$/u,
  );
  if (!match) {
    return { sessionId: sessionIdFromPath(filePath) };
  }
  return {
    sessionId: match[2] ?? sessionIdFromPath(filePath),
    cwd: decodeCwd(match[1]),
  };
}

function decodeCwd(encoded: string | undefined): string | undefined {
  if (!encoded) {
    return undefined;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
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
