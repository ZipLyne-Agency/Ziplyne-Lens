import { describe, expect, it } from "vitest";
import { extractKimiPrompts, normalizeKimiJsonl } from "../src/index.js";

const WIRE_PATH =
  "/Users/dev/.kimi-code/sessions/wd_cedar-health_ab12cd34ef56/session_s1/agents/main/wire.jsonl";

describe("kimi usage normalization", () => {
  it("normalizes usage.record lines with config.update cwd and calculated cost", () => {
    const rows = normalizeKimiJsonl(
      [
        JSON.stringify({
          type: "metadata",
          protocol_version: "1.4",
          created_at: 1784369906488,
        }),
        JSON.stringify({
          type: "config.update",
          cwd: "/Users/dev/Cedar-Health",
          modelAlias: "kimi-code/k3",
          time: 1784369906488,
        }),
        JSON.stringify({
          type: "usage.record",
          model: "kimi-code/k3",
          usage: {
            inputOther: 2596,
            output: 265,
            inputCacheRead: 7936,
            inputCacheCreation: 0,
          },
          usageScope: "turn",
          time: 1784369934699,
        }),
      ].join("\n"),
      { filePath: WIRE_PATH },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "kimi",
      sessionId: "session_s1",
      projectKey: "Cedar-Health",
      cwd: "/Users/dev/Cedar-Health",
      model: "kimi-code/k3",
      timestamp: "2026-07-18T10:18:54.699Z",
      day: "2026-07-18",
      inputTokens: 2596,
      outputTokens: 265,
      cacheCreationTokens: 0,
      cacheReadTokens: 7936,
      reasoningTokens: 0,
      totalTokens: 10797,
      costSource: "calculated",
    });
    expect(rows[0]?.costUsd).toBe(0.005034);
  });

  it("skips session-scope usage records so totals are not doubled", () => {
    const rows = normalizeKimiJsonl(
      [
        JSON.stringify({
          type: "usage.record",
          model: "kimi-code/k3",
          usage: {
            inputOther: 100,
            output: 50,
            inputCacheRead: 0,
            inputCacheCreation: 0,
          },
          usageScope: "turn",
          time: 1784369934699,
        }),
        JSON.stringify({
          type: "usage.record",
          model: "kimi-code/k3",
          usage: {
            inputOther: 3018,
            output: 3086,
            inputCacheRead: 211968,
            inputCacheCreation: 0,
          },
          usageScope: "session",
          time: 1784369959859,
        }),
      ].join("\n"),
      { filePath: WIRE_PATH },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputTokens).toBe(100);
  });

  it("falls back to the wd directory name when no config.update carries cwd", () => {
    const rows = normalizeKimiJsonl(
      [
        JSON.stringify({
          type: "usage.record",
          model: "kimi-code/k3",
          usage: {
            inputOther: 10,
            output: 5,
            inputCacheRead: 0,
            inputCacheCreation: 0,
          },
          usageScope: "turn",
          time: 1784369934699,
        }),
      ].join("\n"),
      { filePath: WIRE_PATH },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.projectKey).toBe("cedar-health");
    expect(rows[0]?.cwd).toBeUndefined();
  });

  it("tolerates malformed and unknown lines", () => {
    const rows = normalizeKimiJsonl(
      [
        "not json at all",
        '{"type":"usage.record","usage":',
        JSON.stringify({ type: "llm.request", model: "kimi-code/k3" }),
        JSON.stringify({ type: "usage.record", usageScope: "turn" }),
        JSON.stringify({
          type: "usage.record",
          model: "kimi-code/k3",
          usage: { inputOther: 10, output: 5 },
          usageScope: "turn",
          time: 1784369934699,
        }),
      ].join("\n"),
      { filePath: WIRE_PATH },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.cacheReadTokens).toBe(0);
  });
});

describe("kimi prompt extraction", () => {
  it("keeps user-origin turns and skips injected context", () => {
    const prompts = extractKimiPrompts(
      [
        JSON.stringify({
          type: "config.update",
          cwd: "/Users/dev/Cedar-Health",
          modelAlias: "kimi-code/k3",
          time: 1784369906488,
        }),
        JSON.stringify({
          type: "turn.prompt",
          input: [
            {
              type: "text",
              text: "<git-context>\nWorking directory: /Users/dev/Cedar-Health\n</git-context>\n\nYou are an auditor.",
            },
          ],
          origin: { kind: "system_trigger" },
          time: 1784369906488,
        }),
        JSON.stringify({
          type: "turn.prompt",
          input: [{ type: "text", text: "Fix the auth API rate limits" }],
          origin: { kind: "user" },
          time: 1784369934699,
        }),
        JSON.stringify({
          type: "turn.steer",
          input: [
            {
              type: "text",
              text: '<notification id="task:agent-1:completed">Background agent completed</notification>',
            },
          ],
          origin: { kind: "background_task" },
          time: 1784369940000,
        }),
        JSON.stringify({
          type: "turn.steer",
          input: [{ type: "text", text: "Also add a test for it" }],
          origin: { kind: "user" },
          time: 1784369959859,
        }),
        "garbage line",
      ].join("\n"),
      { filePath: WIRE_PATH },
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatchObject({
      source: "kimi",
      sessionId: "session_s1",
      projectKey: "Cedar-Health",
      cwd: "/Users/dev/Cedar-Health",
      model: "kimi-code/k3",
      timestamp: "2026-07-18T10:18:54.699Z",
      privacy: "plain",
      content: "Fix the auth API rate limits",
    });
    expect(prompts[0]?.tags).toContain("auth");
    expect(prompts[1]).toMatchObject({
      timestamp: "2026-07-18T10:19:19.859Z",
      content: "Also add a test for it",
    });
  });
});
