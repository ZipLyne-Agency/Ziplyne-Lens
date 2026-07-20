import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../src/index.js";
import {
  aggregateUsage,
  parseRemoteUrl,
  resolveAttribution,
} from "../src/index.js";

function event(partial: Partial<UsageEvent>): UsageEvent {
  return {
    id: partial.id ?? "e1",
    source: "claude",
    timestamp: "2026-07-08T09:00:00.000Z",
    day: "2026-07-08",
    sessionId: partial.sessionId ?? "s1",
    projectKey: partial.projectKey ?? "repo",
    cwd: partial.cwd,
    repoOwner: partial.repoOwner,
    repoName: partial.repoName,
    model: "claude-opus-4-8",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    totalTokens: 150,
    costUsd: partial.costUsd ?? 2,
    costSource: "recorded",
    ...partial,
  };
}

describe("parseRemoteUrl", () => {
  it("parses the common remote URL shapes", () => {
    expect(
      parseRemoteUrl("git@github.com:ZipLyne-Agency/ziplyne-lens.git"),
    ).toEqual({
      owner: "ZipLyne-Agency",
      repoName: "ziplyne-lens",
    });
    expect(parseRemoteUrl("https://github.com/acme/widgets")).toEqual({
      owner: "acme",
      repoName: "widgets",
    });
    expect(parseRemoteUrl("ssh://git@example.com/team/app.git")).toEqual({
      owner: "team",
      repoName: "app",
    });
    expect(parseRemoteUrl("not-a-url")).toEqual({});
  });
});

describe("resolveAttribution", () => {
  const rules = [
    { clientId: "acme", clientName: "Acme", match: "acme-capital" },
  ];

  it("prefers a manual rule over the git repo", () => {
    const result = resolveAttribution(
      {
        cwd: "/Users/dev/acme-capital/api",
        repoOwner: "some-org",
        repoName: "some-repo",
      },
      rules,
    );
    expect(result.clientId).toBe("acme");
  });

  it("auto-matches each repo as its own project (owner/repo), not the org", () => {
    const result = resolveAttribution(
      {
        cwd: "/Users/dev/thing",
        repoOwner: "ZipLyne-Agency",
        repoName: "ziplyne-lens",
      },
      rules,
    );
    expect(result).toMatchObject({
      clientId: "ZipLyne-Agency/ziplyne-lens",
      clientName: "ziplyne-lens",
      confidence: "medium",
    });
  });

  it("keeps same-named repos under different owners distinct", () => {
    const a = resolveAttribution(
      { cwd: "/a", repoOwner: "owner-one", repoName: "app" },
      rules,
    );
    const b = resolveAttribution(
      { cwd: "/b", repoOwner: "owner-two", repoName: "app" },
      rules,
    );
    expect(a.clientId).not.toBe(b.clientId);
  });

  it("does not auto-match when autoMatch is disabled", () => {
    const result = resolveAttribution(
      { cwd: "/Users/dev/thing", repoOwner: "ZipLyne-Agency", repoName: "x" },
      rules,
      { autoMatch: false },
    );
    expect(result.clientId).toBe("unassigned");
  });

  it("applies a rename override to the resolved repo project", () => {
    const result = resolveAttribution(
      {
        cwd: "/Users/dev/thing",
        repoOwner: "ZipLyne-Agency",
        repoName: "ziplyne-lens",
      },
      rules,
      {
        overrides: {
          "ZipLyne-Agency/ziplyne-lens": { name: "ZipLyne Lens" },
        },
      },
    );
    expect(result.clientName).toBe("ZipLyne Lens");
  });
});

describe("aggregateUsage per-client breakdowns", () => {
  it("builds per-model, per-day, and session-span detail for a client", () => {
    const events = [
      event({
        id: "a",
        repoOwner: "acme",
        repoName: "app",
        sessionId: "s1",
        model: "claude-opus-4-8",
        day: "2026-07-08",
        timestamp: "2026-07-08T09:00:00.000Z",
        costUsd: 2,
      }),
      event({
        id: "b",
        repoOwner: "acme",
        repoName: "app",
        sessionId: "s1",
        model: "gpt-5.5",
        day: "2026-07-08",
        timestamp: "2026-07-08T09:30:00.000Z",
        costUsd: 5,
      }),
      event({
        id: "c",
        repoOwner: "acme",
        repoName: "app",
        sessionId: "s2",
        model: "claude-opus-4-8",
        day: "2026-07-09",
        timestamp: "2026-07-09T10:00:00.000Z",
        costUsd: 1,
      }),
    ];
    const summary = aggregateUsage(events, []);
    const client = summary.clients.find((row) => row.clientId === "acme/app");
    expect(client).toBeDefined();
    // Two models, ranked by cost desc.
    expect(client?.models.map((model) => model.model)).toEqual([
      "gpt-5.5",
      "claude-opus-4-8",
    ]);
    // Two days, ascending.
    expect(client?.days.map((day) => day.day)).toEqual([
      "2026-07-08",
      "2026-07-09",
    ]);
    // Active time counts distinct 5-minute windows with activity: 09:00, 09:30,
    // and 10:00 fall in three separate buckets -> 15 minutes total. A multi-day
    // gap does NOT inflate it. Avg over 2 sessions = 7.5m.
    expect(client?.activeMs).toBe(15 * 60_000);
    expect(client?.avgSessionMs).toBe(7.5 * 60_000);
  });

  it("does not count idle calendar gaps as active time (resumed session)", () => {
    const events = [
      event({
        id: "a",
        repoOwner: "acme",
        repoName: "app",
        sessionId: "s1",
        timestamp: "2026-07-01T09:00:00.000Z",
      }),
      // Same session resumed 10 days later: only two active windows, not 10 days.
      event({
        id: "b",
        repoOwner: "acme",
        repoName: "app",
        sessionId: "s1",
        timestamp: "2026-07-11T09:02:00.000Z",
      }),
    ];
    const client = aggregateUsage(events, []).clients.find(
      (row) => row.clientId === "acme/app",
    );
    // Two 5-minute windows, not ten days.
    expect(client?.activeMs).toBe(2 * 5 * 60_000);
  });
});

describe("aggregateUsage hidden projects", () => {
  it("excludes a hidden project from every metric", () => {
    const events = [
      event({
        id: "a",
        repoOwner: "acme",
        repoName: "keep",
        cwd: "/x/keep",
        costUsd: 3,
      }),
      event({
        id: "b",
        repoOwner: "acme",
        repoName: "drop",
        cwd: "/x/drop",
        costUsd: 5,
      }),
    ];
    const summary = aggregateUsage(events, [], {
      overrides: { "acme/drop": { hidden: true } },
    });
    expect(summary.totals.costUsd).toBe(3);
    expect(summary.totals.eventCount).toBe(1);
    expect(summary.clients.map((row) => row.clientId)).not.toContain(
      "acme/drop",
    );
    expect(summary.days.reduce((sum, day) => sum + day.costUsd, 0)).toBe(3);
  });
});
