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

export function normalizeKimiJsonl(
  jsonl: string,
  context: ParseContext,
): UsageEvent[] {
  const events: UsageEvent[] = [];
  let cwd: string | undefined;
  let model: string | undefined;
  const { sessionId, agent } = kimiSessionFromPath(context.filePath);

  for (const line of linesFromJsonl(jsonl)) {
    const raw = objectValue(safeJson(line));
    if (!raw) {
      continue;
    }
    if (raw.type === "config.update") {
      cwd = stringValue(raw.cwd) ?? cwd;
      model = stringValue(raw.modelAlias) ?? model;
      continue;
    }
    if (raw.type !== "usage.record") {
      continue;
    }
    // usageScope "session" records restate the session total on top of the
    // per-turn records; counting them too would double the session's usage.
    if (stringValue(raw.usageScope) !== "turn") {
      continue;
    }
    const usage = objectValue(raw.usage);
    const time = numberValue(raw.time);
    const recordModel = stringValue(raw.model) ?? model;
    if (!usage || !time || !recordModel) {
      continue;
    }
    const inputTokens = numberValue(usage.inputOther) ?? 0;
    const outputTokens = numberValue(usage.output) ?? 0;
    const cacheCreationTokens = numberValue(usage.inputCacheCreation) ?? 0;
    const cacheReadTokens = numberValue(usage.inputCacheRead) ?? 0;
    if (
      inputTokens === 0 &&
      outputTokens === 0 &&
      cacheCreationTokens === 0 &&
      cacheReadTokens === 0
    ) {
      continue;
    }
    const timestamp = new Date(time).toISOString();
    const normalizedModel = normalizeModel(recordModel);
    const costUsd = calculateCost({
      model: normalizedModel,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      reasoningTokens: 0,
    });
    events.push({
      id: idFromParts([
        "kimi",
        sessionId,
        agent,
        timestamp,
        normalizedModel,
        inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
      ]),
      source: "kimi",
      timestamp,
      day: dayFromTimestamp(timestamp),
      sessionId,
      projectKey: inferProjectKey(cwd, projectFromFilePath(context.filePath)),
      cwd,
      model: normalizedModel,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      reasoningTokens: 0,
      totalTokens:
        inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
      costUsd,
      costSource: costSourceFor(normalizedModel),
    });
  }
  return events;
}

export function extractKimiPrompts(
  jsonl: string,
  context: ParseContext,
): PromptRecord[] {
  const prompts: PromptRecord[] = [];
  let cwd: string | undefined;
  let model: string | undefined;
  const { sessionId, agent } = kimiSessionFromPath(context.filePath);

  for (const line of linesFromJsonl(jsonl)) {
    const raw = objectValue(safeJson(line));
    if (!raw) {
      continue;
    }
    if (raw.type === "config.update") {
      cwd = stringValue(raw.cwd) ?? cwd;
      model = stringValue(raw.modelAlias) ?? model;
      continue;
    }
    if (raw.type !== "turn.prompt" && raw.type !== "turn.steer") {
      continue;
    }
    // Only user-origin turns are typed prompts. system_trigger turns carry the
    // injected <git-context> block / subagent briefs, and background_task
    // steers are injected completion notifications.
    if (stringValue(objectValue(raw.origin)?.kind) !== "user") {
      continue;
    }
    const content = textFromContent(raw.input);
    const time = numberValue(raw.time);
    if (!content || !time) {
      continue;
    }
    const timestamp = new Date(time).toISOString();
    const projectKey = inferProjectKey(
      cwd,
      projectFromFilePath(context.filePath),
    );
    prompts.push({
      id: idFromParts(["kimi-prompt", sessionId, agent, timestamp]),
      source: "kimi",
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

// ~/.kimi-code/sessions/wd_<slug>_<hash>/session_<id>/agents/<agent>/wire.jsonl —
// the session id and agent name live in the path, not in the records.
function kimiSessionFromPath(filePath: string): {
  sessionId: string;
  agent?: string;
} {
  const match = filePath.match(
    /\/sessions\/wd_[^/]+\/(session_[^/]+)\/agents\/([^/]+)\/[^/]+$/u,
  );
  if (!match) {
    return { sessionId: sessionIdFromPath(filePath) };
  }
  return {
    sessionId: match[1] ?? sessionIdFromPath(filePath),
    agent: match[2],
  };
}

// The wd_<slug>_<hash> directory names the working directory, which is the
// only project hint in files whose config.update lines omit cwd.
function projectFromFilePath(filePath: string): string {
  const match = filePath.match(/\/sessions\/wd_(.+?)_[0-9a-f]{12}\//u);
  return match?.[1] ?? filePath;
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
