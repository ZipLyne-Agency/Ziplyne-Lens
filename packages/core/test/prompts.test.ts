import { describe, expect, it } from "vitest";
import {
  buildPromptLibrary,
  extractClaudePrompts,
  extractCodexPrompts,
  type PromptRecord,
  redactPromptText,
} from "../src/index.js";

const claudeCtx = { filePath: "/logs/projects/acme/session.jsonl" };
const codexCtx = { filePath: "/logs/sessions/2026/07/session.jsonl" };

function jsonl(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

describe("Claude prompt extraction", () => {
  it("keeps a real typed prompt (string content)", () => {
    const prompts = extractClaudePrompts(
      jsonl({
        type: "user",
        message: { role: "user", content: "Refactor the auth middleware" },
        timestamp: "2026-07-08T09:00:00.000Z",
        uuid: "u1",
        sessionId: "s1",
        cwd: "/Users/dev/acme",
      }),
      claudeCtx,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.content).toBe("Refactor the auth middleware");
    expect(prompts[0]?.privacy).toBe("plain");
  });

  it("drops tool_result records (tool output is not a prompt)", () => {
    const prompts = extractClaudePrompts(
      jsonl({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "export function foo() {}\n// a whole file of code",
            },
          ],
        },
        timestamp: "2026-07-08T09:01:00.000Z",
        uuid: "u2",
        sessionId: "s1",
      }),
      claudeCtx,
    );
    expect(prompts).toHaveLength(0);
  });

  it("drops isMeta / isSidechain records", () => {
    const prompts = extractClaudePrompts(
      jsonl(
        {
          type: "user",
          isMeta: true,
          message: { role: "user", content: "Caveat: system generated" },
          timestamp: "2026-07-08T09:02:00.000Z",
          uuid: "u3",
        },
        {
          type: "user",
          isSidechain: true,
          message: { role: "user", content: "subagent chatter" },
          timestamp: "2026-07-08T09:03:00.000Z",
          uuid: "u4",
        },
      ),
      claudeCtx,
    );
    expect(prompts).toHaveLength(0);
  });

  it("keeps a text-block array prompt", () => {
    const prompts = extractClaudePrompts(
      jsonl({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "Explain the failing test" }],
        },
        timestamp: "2026-07-08T09:04:00.000Z",
        uuid: "u5",
        sessionId: "s1",
      }),
      claudeCtx,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.content).toBe("Explain the failing test");
  });
});

describe("Codex prompt extraction", () => {
  it("extracts the typed prompt from a user_message event", () => {
    const prompts = extractCodexPrompts(
      jsonl(
        {
          type: "turn_context",
          payload: { cwd: "/Users/dev/acme", model: "gpt-5.5" },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>do things</INSTRUCTIONS>",
              },
            ],
          },
          timestamp: "2026-07-06T11:59:00.000Z",
        },
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Find me the leads in a csv",
          },
          timestamp: "2026-07-06T12:00:00.000Z",
        },
      ),
      codexCtx,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.content).toBe("Find me the leads in a csv");
  });

  it("falls back to response_item user messages, skipping developer/AGENTS preamble", () => {
    const prompts = extractCodexPrompts(
      jsonl(
        {
          type: "turn_context",
          payload: { cwd: "/Users/dev/acme", model: "gpt-5.5" },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "# AGENTS.md instructions" }],
          },
          timestamp: "2026-07-06T11:59:00.000Z",
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Trace the upload flow" }],
          },
          timestamp: "2026-07-06T12:01:00.000Z",
        },
      ),
      codexCtx,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.content).toBe("Trace the upload flow");
  });

  it("keeps replayed response_item history alongside new user_message turns (resume)", () => {
    // A resumed session: the prior turn is replayed as a response_item message
    // (no user_message re-emitted); the new turn emits a user_message event.
    const prompts = extractCodexPrompts(
      jsonl(
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Earlier: build the parser" },
            ],
          },
          timestamp: "2026-07-06T11:00:00.000Z",
        },
        {
          type: "event_msg",
          payload: { type: "user_message", message: "Now add tests" },
          timestamp: "2026-07-06T12:00:00.000Z",
        },
      ),
      codexCtx,
    );
    expect(prompts).toHaveLength(2);
    expect(prompts.map((p) => p.content)).toEqual([
      "Earlier: build the parser",
      "Now add tests",
    ]);
  });

  it("dedupes a prompt that appears as both user_message and response_item", () => {
    const prompts = extractCodexPrompts(
      jsonl(
        {
          type: "event_msg",
          payload: { type: "user_message", message: "Add tests" },
          timestamp: "2026-07-06T12:00:00.000Z",
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Add tests" }],
          },
          timestamp: "2026-07-06T12:00:01.000Z",
        },
      ),
      codexCtx,
    );
    expect(prompts).toHaveLength(1);
  });

  it("does not surface turn_context or environment preamble as prompts", () => {
    const prompts = extractCodexPrompts(
      jsonl(
        {
          type: "turn_context",
          payload: { cwd: "/Users/dev/acme", model: "gpt-5.5" },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<environment_context>cwd=/x</environment_context>",
              },
            ],
          },
          timestamp: "2026-07-06T11:58:00.000Z",
        },
      ),
      codexCtx,
    );
    expect(prompts).toHaveLength(0);
  });
});

describe("prompt library attribution (repo = project)", () => {
  function promptRecord(partial: Partial<PromptRecord>): PromptRecord {
    return {
      id: partial.id ?? "p1",
      source: "claude",
      timestamp: "2026-07-08T09:00:00.000Z",
      day: "2026-07-08",
      sessionId: "s1",
      projectKey: partial.projectKey ?? "repo",
      cwd: partial.cwd,
      repoOwner: partial.repoOwner,
      repoName: partial.repoName,
      role: "user",
      preview: partial.preview ?? "hello",
      content: partial.content,
      contentLength: 5,
      estimatedTokens: 2,
      privacy: "redacted",
      tags: [],
      ...partial,
    };
  }

  it("attributes a prompt to its repo (owner/repo), not unassigned", () => {
    const library = buildPromptLibrary(
      [promptRecord({ repoOwner: "ZipLyne-Agency", repoName: "ziplyne-lens" })],
      [],
    );
    expect(library.prompts[0]?.clientId).toBe("ZipLyne-Agency/ziplyne-lens");
  });

  it("hides a hidden project's prompts from the library", () => {
    const records = [
      promptRecord({ id: "a", repoOwner: "acme", repoName: "keep" }),
      promptRecord({ id: "b", repoOwner: "acme", repoName: "secret" }),
    ];
    const library = buildPromptLibrary(records, [], {
      config: { overrides: { "acme/secret": { hidden: true } } },
    });
    const ids = library.prompts.map((record) => record.id);
    expect(ids).toContain("a");
    expect(ids).not.toContain("b");
  });

  it("filters to a single repo project by owner/repo id", () => {
    const records = [
      promptRecord({ id: "a", repoOwner: "acme", repoName: "one" }),
      promptRecord({ id: "b", repoOwner: "acme", repoName: "two" }),
    ];
    const library = buildPromptLibrary(records, [], {
      clientId: "acme/one",
    });
    expect(library.prompts.map((record) => record.id)).toEqual(["a"]);
  });

  it("counts prompts per project ignoring search/limit", () => {
    const records = [
      promptRecord({ id: "a", repoOwner: "acme", repoName: "one" }),
      promptRecord({ id: "b", repoOwner: "acme", repoName: "one" }),
      promptRecord({ id: "c", repoOwner: "acme", repoName: "two" }),
    ];
    // A single-project filter must not change the per-project totals.
    const library = buildPromptLibrary(records, [], { clientId: "acme/two" });
    expect(library.promptCounts["acme/one"]).toBe(2);
    expect(library.promptCounts["acme/two"]).toBe(1);
    expect(library.prompts).toHaveLength(1);
  });

  it("disambiguates duplicate prompt ids instead of dropping records", () => {
    const records = [
      promptRecord({ id: "dup", preview: "first form" }),
      promptRecord({ id: "dup", preview: "second form" }),
      promptRecord({ id: "other", preview: "unrelated" }),
    ];
    const library = buildPromptLibrary(records, []);
    const ids = library.prompts.map((record) => record.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain("dup");
    expect(ids).toContain("dup#2");
  });
});

describe("secret redaction", () => {
  it("redacts common API key shapes", () => {
    const google = redactPromptText(
      "here is the key AIzaSyA1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R",
    );
    expect(google).not.toContain("AIzaSyA1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R");
    expect(google).toContain("[redacted");

    const openai = redactPromptText(
      "token sk-proj-abcdEFGH1234ijklMNOP5678qrst",
    );
    expect(openai).not.toContain("sk-proj-abcdEFGH1234ijklMNOP5678qrst");

    // Prefixed all-caps key (the "KEY019F..." shape) — hex runs with letter
    // prefixes dodge both the hex rule and plain \b boundaries.
    const prefixed = redactPromptText(
      "use KEY019F775CB61B87637FD0E80260DE61CE for telnyx",
    );
    expect(prefixed).not.toContain("019F775CB61B87637FD0E80260DE61CE");
    expect(prefixed).toContain("[redacted key]");

    // Ordinary mixed-case words, even long ones, are untouched.
    expect(redactPromptText("UseAuthenticationMiddlewareEverywhere")).toBe(
      "UseAuthenticationMiddlewareEverywhere",
    );
  });

  it("redacts a secret in the preview of an extracted Codex prompt", () => {
    // Full content is stored raw by design (revealed only on explicit request,
    // fully local); the always-visible preview must be redacted.
    const prompts = extractCodexPrompts(
      jsonl({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "use AIzaSyA1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R for maps",
        },
        timestamp: "2026-07-06T12:00:00.000Z",
      }),
      codexCtx,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.preview).not.toContain(
      "AIzaSyA1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R",
    );
    expect(prompts[0]?.preview).toContain("[redacted");
  });
});
