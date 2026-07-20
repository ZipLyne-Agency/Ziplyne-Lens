import type { ClientRule, PromptRecord, UsageEvent } from "./types.js";

export const DEMO_CLIENT_RULES: ClientRule[] = [
  { clientId: "acme", clientName: "Acme Capital", match: "acme-capital" },
  {
    clientId: "northstar",
    clientName: "Northstar Health",
    match: "northstar-health",
  },
  { clientId: "ziplyne", clientName: "ZipLyne Internal", match: "ziplyne" },
];

export const DEMO_EVENTS: UsageEvent[] = [
  event(
    "claude",
    "2026-07-01T09:00:00.000Z",
    "acme-web",
    "/work/acme-capital/web",
    "claude-opus-4-8",
    92.14,
    41_200_000,
  ),
  event(
    "codex",
    "2026-07-01T13:00:00.000Z",
    "ziplyne-lens",
    "/work/ziplyne/lens",
    "gpt-5.5",
    31.82,
    18_400_000,
  ),
  event(
    "claude",
    "2026-07-02T10:30:00.000Z",
    "northstar-api",
    "/work/northstar-health/api",
    "claude-fable-5",
    123.44,
    51_000_000,
  ),
  event(
    "codex",
    "2026-07-02T16:20:00.000Z",
    "scratch",
    "/tmp/scratch",
    "gpt-5.5",
    14.6,
    9_000_000,
  ),
  event(
    "claude",
    "2026-07-03T08:15:00.000Z",
    "acme-mobile",
    "/work/acme-capital/mobile",
    "claude-sonnet-5",
    48.72,
    25_100_000,
  ),
  event(
    "claude",
    "2026-07-04T12:45:00.000Z",
    "ziplyne-site",
    "/work/ziplyne/landing",
    "claude-sonnet-4-6",
    18.11,
    8_600_000,
  ),
  event(
    "codex",
    "2026-07-05T11:10:00.000Z",
    "northstar-api",
    "/work/northstar-health/api",
    "gpt-5.5",
    26.9,
    15_800_000,
  ),
  event(
    "claude",
    "2026-07-06T14:00:00.000Z",
    "unknown",
    "/Users/runner/downloads/import",
    "claude-opus-4-8",
    11.4,
    5_200_000,
  ),
];

export const DEMO_PROMPTS: PromptRecord[] = [
  {
    id: "demo-prompt-1",
    source: "claude",
    timestamp: new Date(Date.now() - 8 * 60_000).toISOString(),
    day: new Date().toISOString().slice(0, 10),
    sessionId: "demo-claude-1",
    projectKey: "Atlas Robotics",
    cwd: "/Users/dev/Atlas Robotics",
    gitBranch: "main",
    model: "claude-opus-4-8",
    role: "user",
    preview:
      "Audit the renewal campaign sync path and identify any case where shared email suppression misses a canonical user id.",
    content:
      "Audit the renewal campaign sync path and identify any case where shared email suppression misses a canonical user id.",
    contentLength: 112,
    estimatedTokens: 28,
    privacy: "plain",
    tags: ["atlas", "audit", "email"],
  },
  {
    id: "demo-prompt-2",
    source: "codex",
    timestamp: new Date(Date.now() - 21 * 60_000).toISOString(),
    day: new Date().toISOString().slice(0, 10),
    sessionId: "demo-codex-1",
    projectKey: "Cedar-Health",
    cwd: "/Users/dev/Cedar-Health",
    gitBranch: "main",
    model: "gpt-5.5",
    role: "user",
    preview:
      "Trace the upload limit UX from borrower dropzone to admin review and write the exact current behavior.",
    content:
      "Trace the upload limit UX from borrower dropzone to admin review and write the exact current behavior.",
    contentLength: 96,
    estimatedTokens: 24,
    privacy: "plain",
    tags: ["cedar", "upload", "ux"],
  },
  {
    id: "demo-prompt-3",
    source: "codex",
    timestamp: new Date(Date.now() - 34 * 60_000).toISOString(),
    day: new Date().toISOString().slice(0, 10),
    sessionId: "demo-codex-2",
    projectKey: "Unknown",
    cwd: "/Users/dev/scratch",
    model: "gpt-5.5",
    role: "user",
    preview: "Encrypted Codex prompt",
    contentLength: 0,
    estimatedTokens: 0,
    privacy: "encrypted",
    tags: ["encrypted"],
  },
];

function event(
  source: UsageEvent["source"],
  timestamp: string,
  projectKey: string,
  cwd: string,
  model: string,
  costUsd: number,
  totalTokens: number,
): UsageEvent {
  const inputTokens = Math.floor(totalTokens * 0.42);
  const outputTokens = Math.floor(totalTokens * 0.08);
  const cacheReadTokens = Math.floor(totalTokens * 0.45);
  const cacheCreationTokens =
    totalTokens - inputTokens - outputTokens - cacheReadTokens;
  return {
    id: `${source}:${projectKey}:${timestamp}`,
    source,
    timestamp,
    day: timestamp.slice(0, 10),
    sessionId: `${projectKey}-${timestamp.slice(0, 10)}`,
    projectKey,
    cwd,
    model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    reasoningTokens: source === "codex" ? Math.floor(totalTokens * 0.02) : 0,
    totalTokens,
    costUsd,
    costSource: source === "claude" ? "recorded" : "calculated",
  };
}
