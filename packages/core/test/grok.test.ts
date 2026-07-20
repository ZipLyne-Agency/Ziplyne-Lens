import { describe, expect, it } from "vitest";
import { extractGrokPrompts, normalizeGrokJsonl } from "../src/index.js";

const UPDATES_PATH =
  "/Users/dev/.grok/sessions/%2FUsers%2Fdev%2FCedar-Health/019f6c75-0366-7f22-8309-c21389c7cae4/updates.jsonl";

function grokLine(update: Record<string, unknown>, timestamp: number): string {
  return JSON.stringify({
    timestamp,
    method: "session/update",
    params: {
      sessionId: "019f6c75-0366-7f22-8309-c21389c7cae4",
      update,
    },
  });
}

describe("grok usage normalization", () => {
  it("emits one event per model in turn_completed modelUsage", () => {
    const rows = normalizeGrokJsonl(
      [
        grokLine(
          {
            sessionUpdate: "turn_completed",
            prompt_id: "9e411c9d-95f5-41e6-9a8b-48ae8d569ee3",
            stop_reason: "end_turn",
            usage: {
              inputTokens: 1200,
              outputTokens: 150,
              totalTokens: 1350,
              cachedReadTokens: 500,
              reasoningTokens: 20,
              modelCalls: 3,
              modelUsage: {
                "grok-4.5": {
                  inputTokens: 1000,
                  outputTokens: 100,
                  totalTokens: 1100,
                  cachedReadTokens: 400,
                  reasoningTokens: 20,
                  modelCalls: 2,
                },
                "grok-code-fast-1": {
                  inputTokens: 200,
                  outputTokens: 50,
                  totalTokens: 250,
                  cachedReadTokens: 100,
                  reasoningTokens: 0,
                  modelCalls: 1,
                },
              },
            },
          },
          1784231051,
        ),
      ].join("\n"),
      { filePath: UPDATES_PATH },
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: "grok",
      sessionId: "019f6c75-0366-7f22-8309-c21389c7cae4",
      projectKey: "Cedar-Health",
      cwd: "/Users/dev/Cedar-Health",
      model: "grok-4.5",
      timestamp: "2026-07-16T19:44:11.000Z",
      day: "2026-07-16",
      inputTokens: 600,
      outputTokens: 100,
      cacheCreationTokens: 0,
      cacheReadTokens: 400,
      reasoningTokens: 20,
      totalTokens: 1100,
      costSource: "calculated",
    });
    expect(rows[0]?.costUsd).toBe(0.00212);
    expect(rows[1]).toMatchObject({
      model: "grok-code-fast-1",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 100,
      costSource: "calculated",
    });
  });

  it("skips updates without usage and non-turn updates", () => {
    const rows = normalizeGrokJsonl(
      [
        grokLine(
          {
            sessionUpdate: "turn_completed",
            prompt_id: "p1",
            stop_reason: "end_turn",
          },
          1784231051,
        ),
        grokLine(
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Working on it" },
          },
          1784231052,
        ),
        "not json at all",
        '{"timestamp":1784231053,"params":',
      ].join("\n"),
      { filePath: UPDATES_PATH },
    );

    expect(rows).toHaveLength(0);
  });
});

describe("grok prompt extraction", () => {
  it("extracts user_message_chunk prompts with model and decoded cwd", () => {
    const prompts = extractGrokPrompts(
      [
        grokLine(
          {
            sessionUpdate: "user_message_chunk",
            content: {
              type: "text",
              text: "Fix the auth API rate limits",
            },
            _meta: { modelId: "grok-4.5", promptIndex: 0 },
          },
          1784231051,
        ),
        grokLine(
          {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "" },
            _meta: { modelId: "grok-4.5", promptIndex: 1 },
          },
          1784231052,
        ),
        grokLine(
          {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "The user wants auth fixes" },
          },
          1784231053,
        ),
        "garbage line",
      ].join("\n"),
      { filePath: UPDATES_PATH },
    );

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      source: "grok",
      sessionId: "019f6c75-0366-7f22-8309-c21389c7cae4",
      projectKey: "Cedar-Health",
      cwd: "/Users/dev/Cedar-Health",
      model: "grok-4.5",
      timestamp: "2026-07-16T19:44:11.000Z",
      privacy: "plain",
      content: "Fix the auth API rate limits",
    });
    expect(prompts[0]?.tags).toContain("auth");
  });
});
