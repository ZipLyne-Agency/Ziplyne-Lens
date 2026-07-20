import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  attributeClient,
  buildPromptLibrary,
  calculateCost,
  extractClaudePrompts,
  extractCodexPrompts,
  normalizeClaudeJsonl,
  normalizeCodexJsonl,
  redactPromptText,
} from "../src/index.js";

describe("usage normalization", () => {
  it("normalizes Claude entries with official cost and cwd project metadata", () => {
    const rows = normalizeClaudeJsonl(
      [
        JSON.stringify({
          timestamp: "2026-07-08T09:00:00.000Z",
          sessionId: "claude-session",
          cwd: "/Users/dev/Atlas Robotics",
          gitBranch: "main",
          message: {
            id: "msg-1",
            model: "claude-opus-4-8",
            usage: {
              input_tokens: 1000,
              output_tokens: 200,
              cache_creation_input_tokens: 300,
              cache_read_input_tokens: 400,
            },
          },
          costUSD: 1.23,
        }),
      ].join("\n"),
      {
        filePath:
          "/Users/dev/.claude/projects/-Users-dev-Atlas-Robotics/session.jsonl",
      },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "claude",
      sessionId: "claude-session",
      projectKey: "Atlas Robotics",
      cwd: "/Users/dev/Atlas Robotics",
      model: "claude-opus-4-8",
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 300,
      cacheReadTokens: 400,
      costUsd: 1.23,
      costSource: "recorded",
    });
  });

  it("normalizes Codex token events using turn_context cwd and calculated cost", () => {
    const rows = normalizeCodexJsonl(
      [
        JSON.stringify({
          timestamp: "2026-07-08T09:00:00.000Z",
          type: "turn_context",
          payload: {
            cwd: "/Users/dev/Cedar-Health",
            model: "gpt-5.5",
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-08T09:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 250,
                output_tokens: 100,
                reasoning_output_tokens: 20,
                total_tokens: 1100,
              },
            },
          },
        }),
      ].join("\n"),
      { filePath: "/Users/dev/.codex/sessions/rollout.jsonl" },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "codex",
      sessionId: "rollout",
      projectKey: "Cedar-Health",
      model: "gpt-5.5",
      inputTokens: 750,
      outputTokens: 100,
      cacheReadTokens: 250,
      reasoningTokens: 20,
      costSource: "calculated",
    });
    expect(rows[0]?.costUsd).toBeGreaterThan(0);
  });
});

describe("costs and attribution", () => {
  it("calculates model cost with cache reads priced separately", () => {
    const cost = calculateCost({
      model: "gpt-5.5",
      inputTokens: 1000,
      outputTokens: 100,
      cacheCreationTokens: 0,
      cacheReadTokens: 500,
      reasoningTokens: 0,
    });

    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(1);
  });

  it("attributes clients by path rules and falls back to unassigned", () => {
    const client = attributeClient("/Users/dev/Atlas Robotics", [
      {
        clientId: "atlas",
        clientName: "Atlas Robotics",
        match: "Atlas Robotics",
      },
    ]);
    const unassigned = attributeClient("/Users/dev/unknown", [
      {
        clientId: "atlas",
        clientName: "Atlas Robotics",
        match: "Atlas Robotics",
      },
    ]);

    expect(client).toMatchObject({
      clientId: "atlas",
      clientName: "Atlas Robotics",
      confidence: "high",
    });
    expect(unassigned).toMatchObject({
      clientId: "unassigned",
      confidence: "none",
    });
  });
});

describe("prompt library", () => {
  it("extracts Claude user prompts with redacted preview support", () => {
    const prompts = extractClaudePrompts(
      [
        JSON.stringify({
          timestamp: "2026-07-08T09:00:00.000Z",
          sessionId: "claude-session",
          cwd: "/Users/dev/Atlas Robotics",
          gitBranch: "main",
          type: "user",
          uuid: "u1",
          message: {
            role: "user",
            content:
              "Fix the auth API. API_KEY=super-secret-token and email ops@example.com are test data.",
          },
        }),
      ].join("\n"),
      {
        filePath:
          "/Users/dev/.claude/projects/-Users-dev-Atlas-Robotics/session.jsonl",
      },
    );

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      source: "claude",
      projectKey: "Atlas Robotics",
      privacy: "plain",
      contentLength: 85,
    });
    expect(prompts[0]?.preview).toContain("[redacted secret]");
    expect(prompts[0]?.preview).toContain("[redacted email]");
  });

  it("extracts Codex plaintext prompts and encrypted prompt metadata", () => {
    const prompts = extractCodexPrompts(
      [
        JSON.stringify({
          timestamp: "2026-07-08T09:00:00.000Z",
          type: "turn_context",
          payload: {
            cwd: "/Users/dev/Cedar-Health",
            model: "gpt-5.5",
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-08T09:01:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Find Sentry upload errors" },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-08T09:02:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            encrypted_content: "ciphertext",
          },
        }),
      ].join("\n"),
      { filePath: "/Users/dev/.codex/sessions/rollout.jsonl" },
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatchObject({
      source: "codex",
      projectKey: "Cedar-Health",
      model: "gpt-5.5",
      privacy: "plain",
    });
    expect(prompts[1]).toMatchObject({
      privacy: "encrypted",
      preview: "Encrypted Codex prompt",
    });
  });

  it("builds prompt library without returning full text by default", () => {
    const library = buildPromptLibrary(
      [
        {
          id: "p1",
          source: "claude",
          timestamp: "2026-07-08T09:00:00.000Z",
          day: "2026-07-08",
          sessionId: "s1",
          projectKey: "Atlas Robotics",
          cwd: "/Users/dev/Atlas Robotics",
          role: "user",
          preview: "Draft client onboarding plan",
          content: "Draft client onboarding plan",
          contentLength: 28,
          estimatedTokens: 7,
          privacy: "plain",
          tags: ["client"],
        },
      ],
      [{ clientId: "atlas", clientName: "Atlas Robotics", match: "Atlas" }],
    );

    expect(library.prompts[0]).toMatchObject({
      clientId: "atlas",
      privacy: "redacted",
    });
    expect(library.prompts[0]?.content).toBeUndefined();
  });

  it("redacts common secret-like prompt content", () => {
    expect(
      redactPromptText("token = abcdefghijklmnopqrstuvwxyz123456"),
    ).toContain("[redacted secret]");
  });
});

describe("aggregation", () => {
  it("summarizes spend by client, project, source, model, day, and unassigned queue", () => {
    const summary = aggregateUsage(
      [
        {
          id: "a",
          source: "claude",
          timestamp: "2026-07-08T09:00:00.000Z",
          day: "2026-07-08",
          sessionId: "s1",
          projectKey: "Atlas Robotics",
          cwd: "/Users/dev/Atlas Robotics",
          model: "claude-opus-4-8",
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          reasoningTokens: 0,
          totalTokens: 150,
          costUsd: 2,
          costSource: "recorded",
        },
        {
          id: "b",
          source: "codex",
          timestamp: "2026-07-08T10:00:00.000Z",
          day: "2026-07-08",
          sessionId: "s2",
          projectKey: "Unknown",
          cwd: "/tmp/scratch",
          model: "gpt-5.5",
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationTokens: 0,
          cacheReadTokens: 10,
          reasoningTokens: 5,
          totalTokens: 130,
          costUsd: 1,
          costSource: "calculated",
        },
      ],
      [
        {
          clientId: "atlas",
          clientName: "Atlas Robotics",
          match: "Atlas Robotics",
        },
      ],
    );

    expect(summary.totals.costUsd).toBe(3);
    expect(summary.clients[0]).toMatchObject({ clientId: "atlas", costUsd: 2 });
    expect(summary.projects[0]).toMatchObject({
      projectKey: "Atlas Robotics",
      costUsd: 2,
    });
    expect(summary.sources).toHaveLength(2);
    expect(summary.models.map((row) => row.model)).toContain("gpt-5.5");
    expect(summary.days[0]).toMatchObject({ day: "2026-07-08", costUsd: 3 });
    expect(summary.unassigned).toHaveLength(1);
  });
});
