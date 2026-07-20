import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanResult, UsageEvent } from "@ziplyne/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import {
  BURN_TTL_MS,
  buildLimitsPayload,
  buildTraySummary,
  CACHE_FRESH_MS,
  DEFAULT_ACCOUNTS,
  getAccountUsage,
  getAgentBurn,
  getLimit,
  interpretUsage,
  type LimitsDeps,
  pickBestAccount,
  type RawUsage,
  resetLimitsState,
  setLimitsDeps,
  severityColor,
  severityDot,
  USAGE_API,
  worstOf,
} from "../src/limits.js";
import type { CommandRunner, LiveSessionsResponse } from "../src/live.js";

// 2026-07-18T12:00:00Z -> today "2026-07-18", week starts "2026-07-12".
const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const NOW_SECONDS = NOW / 1_000;

const usageFixture: RawUsage = {
  limits: [
    {
      kind: "session",
      percent: 42,
      severity: "normal",
      resets_at: "2026-07-18T20:00:00.000Z",
    },
    {
      kind: "weekly_all",
      percent: 63,
      severity: "warning",
      resets_at: "2026-07-24T00:00:00.000Z",
    },
    {
      kind: "weekly_scoped",
      percent: 71,
      severity: "critical",
      resets_at: "2026-07-24T00:00:00.000Z",
      scope: { model: { display_name: "Fable" } },
    },
    {
      kind: "weekly_scoped",
      percent: 10,
      severity: "normal",
      resets_at: "2026-07-24T00:00:00.000Z",
      scope: { model: { display_name: "Opus" } },
    },
  ],
};

function makeEvent(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    id: "event-1",
    source: "claude",
    timestamp: "2026-07-18T10:00:00.000Z",
    day: "2026-07-18",
    sessionId: "session-1",
    projectKey: "project-1",
    model: "claude-opus-4",
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    totalTokens: 15,
    costUsd: 0.5,
    costSource: "calculated",
    ...overrides,
  };
}

const burnEvents: UsageEvent[] = [
  makeEvent({
    id: "c1",
    model: "opus",
    costUsd: 1,
    totalTokens: 100,
  }),
  makeEvent({
    id: "c2",
    model: "sonnet",
    costUsd: 0.5,
    totalTokens: 50,
  }),
  makeEvent({
    id: "c3",
    day: "2026-07-15",
    timestamp: "2026-07-15T10:00:00.000Z",
    model: "opus",
    costUsd: 2,
    totalTokens: 200,
  }),
  makeEvent({
    id: "c4",
    day: "2026-07-15",
    timestamp: "2026-07-15T11:00:00.000Z",
    model: "haiku",
    costUsd: 0.1,
    totalTokens: 10,
  }),
  makeEvent({
    id: "c5",
    day: "2026-07-15",
    timestamp: "2026-07-15T12:00:00.000Z",
    model: "fable",
    costUsd: 0.05,
    totalTokens: 5,
  }),
  makeEvent({
    id: "k1",
    source: "kimi",
    model: "kimi-k2",
    costUsd: 0.25,
    totalTokens: 25,
  }),
  makeEvent({
    id: "g1",
    source: "grok",
    day: "2026-07-13",
    timestamp: "2026-07-13T10:00:00.000Z",
    model: "grok-4",
    costUsd: 3,
    totalTokens: 300,
  }),
];

function makeScanUsage(events: UsageEvent[] = burnEvents) {
  return vi.fn(
    async (): Promise<ScanResult> => ({
      events,
      scannedFiles: events.length,
      errors: [],
    }),
  );
}

const liveFixture: LiveSessionsResponse = {
  generatedAt: "2026-07-18T12:00:00.000Z",
  sessions: [],
  groups: [],
  counts: { total: 3, working: 1, quiet: 0, needsAttention: 2, unknown: 0 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let scratch: string;

beforeEach(async () => {
  resetLimitsState();
  scratch = await mkdtemp(join(tmpdir(), "limits-test-"));
});

afterEach(async () => {
  resetLimitsState();
  await rm(scratch, { recursive: true, force: true });
});

describe("getLimit", () => {
  it("finds the first limit matching kind", () => {
    expect(getLimit(usageFixture, "session")).toMatchObject({ percent: 42 });
    expect(getLimit(usageFixture, "weekly_all")).toMatchObject({ percent: 63 });
  });

  it("filters weekly_scoped by model display name", () => {
    expect(getLimit(usageFixture, "weekly_scoped", "Fable")).toMatchObject({
      percent: 71,
    });
    expect(getLimit(usageFixture, "weekly_scoped", "Opus")).toMatchObject({
      percent: 10,
    });
    expect(getLimit(usageFixture, "weekly_scoped", "Sonnet")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(getLimit(usageFixture, "monthly")).toBeNull();
    expect(getLimit({}, "session")).toBeNull();
  });
});

describe("worstOf", () => {
  it("picks the highest percentage across session/weekly/Fable", () => {
    expect(worstOf(usageFixture)).toEqual({
      percent: 71,
      severity: "critical",
    });
  });

  it("ignores weekly_scoped limits for other models", () => {
    const usage: RawUsage = {
      limits: [
        { kind: "session", percent: 12, severity: "normal" },
        {
          kind: "weekly_scoped",
          percent: 99,
          severity: "critical",
          scope: { model: { display_name: "Opus" } },
        },
      ],
    };
    expect(worstOf(usage)).toEqual({ percent: 12, severity: "normal" });
  });

  it("keeps the first limit on ties, like the Python max", () => {
    const usage: RawUsage = {
      limits: [
        { kind: "session", percent: 50, severity: "warning" },
        { kind: "weekly_all", percent: 50, severity: "critical" },
      ],
    };
    expect(worstOf(usage)).toEqual({ percent: 50, severity: "warning" });
  });

  it("returns null when there are no usable limits", () => {
    expect(worstOf({})).toBeNull();
    expect(worstOf({ limits: [] })).toBeNull();
  });
});

describe("interpretUsage", () => {
  it("shapes session/weekly and every scoped limit", () => {
    const shaped = interpretUsage(usageFixture);
    expect(shaped.session).toEqual({
      kind: "session",
      percent: 42,
      severity: "normal",
      resetsAt: "2026-07-18T20:00:00.000Z",
    });
    expect(shaped.weeklyAll).toMatchObject({ percent: 63 });
    expect(shaped.weeklyScoped).toHaveLength(2);
    expect(shaped.weeklyScoped[0]).toMatchObject({
      percent: 71,
      scope: "Fable",
    });
  });
});

describe("pickBestAccount", () => {
  it("picks the account with the lowest worst percentage", () => {
    const heavy: RawUsage = {
      limits: [{ kind: "session", percent: 90, severity: "critical" }],
    };
    const light: RawUsage = {
      limits: [{ kind: "session", percent: 20, severity: "normal" }],
    };
    expect(
      pickBestAccount([
        { label: "a", usage: heavy },
        { label: "b", usage: light },
      ]),
    ).toEqual({ label: "b", worstPct: 20, severity: "normal" });
  });

  it("skips accounts without data or limits", () => {
    const light: RawUsage = {
      limits: [{ kind: "session", percent: 20, severity: "normal" }],
    };
    expect(
      pickBestAccount([
        { label: "a", usage: null },
        { label: "b", usage: {} },
        { label: "c", usage: light },
      ]),
    ).toEqual({ label: "c", worstPct: 20, severity: "normal" });
    expect(pickBestAccount([{ label: "a", usage: null }])).toBeNull();
  });
});

describe("severity display semantics", () => {
  it("maps severities to dots and colors like the xbar script", () => {
    expect(severityDot("critical")).toBe("\u{1F534}");
    expect(severityDot("warning")).toBe("\u{1F7E1}");
    expect(severityDot("normal")).toBe("\u{1F7E2}");
    expect(severityColor("critical")).toBe("red");
    expect(severityColor("warning")).toBe("#e0a300");
    expect(severityColor("normal")).toBeNull();
  });
});

describe("getAccountUsage cache flow", () => {
  const account = DEFAULT_ACCOUNTS[0] as (typeof DEFAULT_ACCOUNTS)[number];

  function deps(overrides: Partial<LimitsDeps>): LimitsDeps {
    return {
      now: () => NOW,
      cacheDir: scratch,
      runner: vi.fn(async () => ""),
      fetchImpl: vi.fn(async () => jsonResponse(usageFixture)),
      ...overrides,
    };
  }

  async function seedCache(fetchedAtSeconds: number): Promise<void> {
    await writeFile(
      join(scratch, `${account.label}.json`),
      JSON.stringify({ usage: usageFixture, fetched_at: fetchedAtSeconds }),
      "utf8",
    );
  }

  it("serves a fresh cache without touching the keychain or network", async () => {
    await seedCache(NOW_SECONDS - 100);
    const runner = vi.fn(async () => {
      throw new Error("runner must not be called");
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch must not be called");
    });
    const result = await getAccountUsage(
      account,
      deps({ runner, fetchImpl } as Partial<LimitsDeps>),
    );
    expect(result).toEqual({
      usage: usageFixture,
      fetchedAtSeconds: NOW_SECONDS - 100,
      error: null,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a cache exactly CACHE_FRESH_MS old as stale", async () => {
    await seedCache(NOW_SECONDS - CACHE_FRESH_MS / 1_000);
    const result = await getAccountUsage(account, deps({}));
    expect(result).toEqual({
      usage: usageFixture,
      fetchedAtSeconds: NOW_SECONDS - CACHE_FRESH_MS / 1_000,
      error: "no token in keychain",
    });
  });

  it("falls back to the stale cache when the token is missing", async () => {
    await seedCache(NOW_SECONDS - 300);
    const result = await getAccountUsage(account, deps({}));
    expect(result.usage).toEqual(usageFixture);
    expect(result.error).toBe("no token in keychain");
  });

  it("returns just the error without a token or cache", async () => {
    const result = await getAccountUsage(account, deps({}));
    expect(result).toEqual({
      usage: null,
      fetchedAtSeconds: null,
      error: "no token in keychain",
    });
  });

  it("fetches live usage and rewrites the cache on success", async () => {
    await seedCache(NOW_SECONDS - 300);
    const liveUsage: RawUsage = {
      limits: [{ kind: "session", percent: 5, severity: "normal" }],
    };
    const runner = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-1" } }),
    );
    const fetchImpl = vi.fn(async () => jsonResponse(liveUsage));
    const result = await getAccountUsage(
      account,
      deps({ runner, fetchImpl } as Partial<LimitsDeps>),
    );
    expect(result).toEqual({
      usage: liveUsage,
      fetchedAtSeconds: NOW_SECONDS,
      error: null,
    });
    const onDisk = JSON.parse(
      await readFile(join(scratch, `${account.label}.json`), "utf8"),
    );
    expect(onDisk).toEqual({ usage: liveUsage, fetched_at: NOW_SECONDS });
  });

  it("falls back to the stale cache on HTTP errors", async () => {
    await seedCache(NOW_SECONDS - 300);
    const runner = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-1" } }),
    );
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
    const result = await getAccountUsage(
      account,
      deps({ runner, fetchImpl } as Partial<LimitsDeps>),
    );
    expect(result.usage).toEqual(usageFixture);
    expect(result.error).toBe("HTTP 429");
  });

  it("surfaces network failures without a cache", async () => {
    const runner = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "tok-1" } }),
    );
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      });
    });
    const result = await getAccountUsage(
      account,
      deps({ runner, fetchImpl } as Partial<LimitsDeps>),
    );
    expect(result).toEqual({
      usage: null,
      fetchedAtSeconds: null,
      error: "AbortError: The operation was aborted",
    });
  });

  it("returns null when the keychain entry is not valid JSON", async () => {
    const runner = vi.fn(async () => "not-json");
    const result = await getAccountUsage(account, deps({ runner }));
    expect(result.usage).toBeNull();
    expect(result.error).toBe("no token in keychain");
  });

  it("looks up the configured service without a maintainer-specific keychain account", async () => {
    const runner = vi.fn(async () => "");
    await getAccountUsage(account, deps({ runner }));

    expect(runner).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-w", "-s", account.service],
      5_000,
    );
  });
});

describe("default account portability", () => {
  it("ships one generic Claude profile without maintainer identity data", () => {
    expect(DEFAULT_ACCOUNTS).toEqual([
      {
        label: "default",
        email: "",
        command: "claude",
        service: "Claude Code-credentials",
      },
    ]);
  });
});

describe("getAgentBurn", () => {
  it("splits today vs week per source and keeps the top 3 models", async () => {
    const agents = await getAgentBurn({
      now: () => NOW,
      scanUsage: makeScanUsage(),
    });
    const bySource = new Map(agents.map((agent) => [agent.source, agent]));
    expect(agents.map((agent) => agent.source)).toEqual([
      "claude",
      "codex",
      "kimi",
      "grok",
    ]);
    expect(bySource.get("claude")).toMatchObject({
      todayCostUsd: 1.5,
      todayTokens: 150,
      weekCostUsd: 3.65,
      weekTokens: 365,
    });
    expect(bySource.get("claude")?.models).toEqual([
      { model: "opus", costUsd: 3, totalTokens: 300 },
      { model: "sonnet", costUsd: 0.5, totalTokens: 50 },
      { model: "haiku", costUsd: 0.1, totalTokens: 10 },
    ]);
    expect(bySource.get("kimi")).toMatchObject({
      todayCostUsd: 0.25,
      weekCostUsd: 0.25,
    });
    expect(bySource.get("grok")).toMatchObject({
      todayCostUsd: 0,
      weekCostUsd: 3,
    });
    expect(bySource.get("codex")).toMatchObject({
      todayCostUsd: 0,
      weekCostUsd: 0,
      models: [],
    });
  });

  it("breaks burn down per account when events carry one", async () => {
    const scanUsage = makeScanUsage([
      makeEvent({ id: "a1", account: "azl", costUsd: 2, totalTokens: 200 }),
      makeEvent({
        id: "a2",
        account: "izl",
        costUsd: 1,
        totalTokens: 100,
        day: "2026-07-15",
        timestamp: "2026-07-15T10:00:00.000Z",
      }),
      makeEvent({ id: "a3", costUsd: 0.25, totalTokens: 25 }),
    ]);
    const agents = await getAgentBurn({ now: () => NOW, scanUsage });
    const claude = agents.find((agent) => agent.source === "claude");
    expect(claude?.accounts).toEqual([
      {
        account: "azl",
        todayCostUsd: 2,
        todayTokens: 200,
        weekCostUsd: 2,
        weekTokens: 200,
      },
      {
        account: "izl",
        todayCostUsd: 0,
        todayTokens: 0,
        weekCostUsd: 1,
        weekTokens: 100,
      },
    ]);
    // The total still includes the account-less event.
    expect(claude?.weekCostUsd).toBeCloseTo(3.25);
  });

  it("scans the 7-day window ending today without git owner resolution", async () => {
    const scanUsage = makeScanUsage([]);
    await getAgentBurn({ now: () => NOW, scanUsage });
    expect(scanUsage).toHaveBeenCalledWith({
      since: "2026-07-12",
      until: "2026-07-18",
      resolveGitOwners: false,
    });
  });

  it("caches the burn for BURN_TTL_MS keyed by day", async () => {
    const scanUsage = makeScanUsage([]);
    let nowMs = NOW;
    const deps: LimitsDeps = { now: () => nowMs, scanUsage };

    await getAgentBurn(deps);
    await getAgentBurn(deps);
    expect(scanUsage).toHaveBeenCalledTimes(1);

    nowMs += BURN_TTL_MS - 1_000;
    await getAgentBurn(deps);
    expect(scanUsage).toHaveBeenCalledTimes(1);

    nowMs += 2_000;
    await getAgentBurn(deps);
    expect(scanUsage).toHaveBeenCalledTimes(2);
  });
});

describe("payload builders", () => {
  function fullDeps(overrides: Partial<LimitsDeps> = {}): LimitsDeps {
    const tokens: Record<string, string> = {
      "Claude Code-credentials": "tok-default",
      "Claude Code-credentials-46210f70": "tok-azl",
      "Claude Code-credentials-09f44530": "tok-izl",
    };
    const usageByToken: Record<string, RawUsage> = {
      "tok-default": usageFixture,
      "tok-azl": {
        limits: [
          { kind: "session", percent: 30, severity: "normal" },
          { kind: "weekly_all", percent: 12, severity: "normal" },
        ],
      },
      "tok-izl": {
        limits: [{ kind: "weekly_all", percent: 55, severity: "warning" }],
      },
    };
    const runner: CommandRunner = vi.fn(
      async (executable: string, args: string[]) => {
        if (executable === "security") {
          const service = args[args.indexOf("-s") + 1] ?? "";
          const token = tokens[service];
          return token
            ? JSON.stringify({ claudeAiOauth: { accessToken: token } })
            : "";
        }
        return "";
      },
    );
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const token = headers.Authorization.replace("Bearer ", "");
      return jsonResponse(usageByToken[token] ?? {});
    }) as unknown as typeof globalThis.fetch;
    return {
      now: () => NOW,
      runner,
      fetchImpl,
      cacheDir: scratch,
      configPath: join(scratch, "config.json"),
      scanUsage: makeScanUsage(),
      liveSessions: async () => liveFixture,
      connections: async () => ({
        generatedAt: new Date(NOW).toISOString(),
        counts: {
          total: 3,
          ssh: 2,
          database: 1,
          tunnel: 0,
          cloud: 0,
          agent: 0,
          other: 0,
        },
        sessions: [],
      }),
      ...overrides,
    };
  }

  it("buildLimitsPayload shapes accounts, best account, and agents", async () => {
    const payload = await buildLimitsPayload(fullDeps());

    expect(payload.updatedAt).toBe("2026-07-18T12:00:00.000Z");
    expect(payload.bestAccount).toEqual({
      label: "default",
      worstPct: 71,
      severity: "critical",
    });
    expect(payload.accounts).toHaveLength(1);

    const first = payload.accounts[0];
    expect(first).toMatchObject({
      label: "default",
      email: "",
      command: "claude",
      fetchedAt: "2026-07-18T12:00:00.000Z",
      stale: false,
      error: null,
    });
    expect(first?.usage?.session).toMatchObject({ percent: 42 });
    expect(first?.usage?.weeklyScoped).toHaveLength(2);

    expect(payload.agents).toHaveLength(4);
    expect(payload.agents[0]).toMatchObject({
      source: "claude",
      todayCostUsd: 1.5,
      weekCostUsd: 3.65,
    });
  });

  it("sends the oauth headers to the usage endpoint", async () => {
    const deps = fullDeps();
    await buildLimitsPayload(deps);
    expect(deps.fetchImpl).toHaveBeenCalledWith(
      USAGE_API,
      expect.objectContaining({
        headers: {
          Authorization: "Bearer tok-default",
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("marks accounts stale when the live fetch fails but a cache exists", async () => {
    // Prime the cache via a successful call, then fail the next one.
    await buildLimitsPayload(fullDeps());
    resetLimitsState();
    const staleDeps = fullDeps({
      now: () => NOW + CACHE_FRESH_MS + 60_000,
      fetchImpl: vi.fn(async () =>
        jsonResponse({ error: "nope" }, 500),
      ) as unknown as typeof globalThis.fetch,
    });
    const payload = await buildLimitsPayload(staleDeps);
    expect(payload.accounts[0]).toMatchObject({
      stale: true,
      error: "HTTP 500",
    });
    expect(payload.accounts[0]?.usage?.session).toMatchObject({ percent: 42 });
    // Stale data still feeds the best-account selection.
    expect(payload.bestAccount).toEqual({
      label: "default",
      worstPct: 71,
      severity: "critical",
    });
  });

  it("reports null usage and null bestAccount when nothing can be fetched", async () => {
    const payload = await buildLimitsPayload(
      fullDeps({
        fetchImpl: vi.fn(async () =>
          jsonResponse({}, 429),
        ) as unknown as typeof globalThis.fetch,
      }),
    );
    expect(payload.bestAccount).toBeNull();
    for (const account of payload.accounts) {
      expect(account).toMatchObject({
        usage: null,
        fetchedAt: null,
        stale: false,
        error: "HTTP 429",
      });
    }
  });

  it("honours the accounts override in the config file", async () => {
    await writeFile(
      join(scratch, "config.json"),
      JSON.stringify({
        accounts: [
          {
            label: "solo",
            email: "one@example.com",
            command: "claude solo",
            service: "Claude Code-credentials",
          },
        ],
      }),
      "utf8",
    );
    const payload = await buildLimitsPayload(fullDeps());
    expect(payload.accounts).toHaveLength(1);
    expect(payload.accounts[0]).toMatchObject({
      label: "solo",
      email: "one@example.com",
      command: "claude solo",
    });
  });

  it("buildTraySummary combines attention, today totals, and best account", async () => {
    const summary = await buildTraySummary(fullDeps());
    expect(summary).toEqual({
      updatedAt: "2026-07-18T12:00:00.000Z",
      attention: { count: 2 },
      connections: { count: 3 },
      today: { costUsd: 1.75, tokens: 175 },
      bestAccount: { label: "default", worstPct: 71, severity: "critical" },
      perAgent: [
        { source: "claude", costUsd: 1.5, tokens: 150 },
        { source: "codex", costUsd: 0, tokens: 0 },
        { source: "kimi", costUsd: 0.25, tokens: 25 },
        { source: "grok", costUsd: 0, tokens: 0 },
      ],
    });
  });
});

describe("routes", () => {
  function routeDeps(): LimitsDeps {
    const runner: CommandRunner = async (executable) => {
      if (executable === "security") {
        return JSON.stringify({
          claudeAiOauth: { accessToken: "route-token" },
        });
      }
      return "";
    };
    return {
      now: () => NOW,
      runner,
      fetchImpl: vi.fn(async () =>
        jsonResponse(usageFixture),
      ) as unknown as typeof globalThis.fetch,
      cacheDir: join(scratch, "route-cache"),
      configPath: join(scratch, "config.json"),
      scanUsage: makeScanUsage(),
      liveSessions: async () => liveFixture,
    };
  }

  it("GET /api/limits returns the limits payload", async () => {
    setLimitsDeps(routeDeps());
    const response = await app.request("/api/limits");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.updatedAt).toBe("2026-07-18T12:00:00.000Z");
    expect(body.accounts).toHaveLength(1);
    expect(body.bestAccount).toMatchObject({ label: "default", worstPct: 71 });
    expect(
      body.agents.map((agent: { source: string }) => agent.source),
    ).toEqual(["claude", "codex", "kimi", "grok"]);
  });

  it("GET /api/tray-summary returns the tray payload", async () => {
    setLimitsDeps(routeDeps());
    const response = await app.request("/api/tray-summary");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      updatedAt: "2026-07-18T12:00:00.000Z",
      attention: { count: 2 },
      today: { costUsd: 1.75, tokens: 175 },
      bestAccount: { label: "default", worstPct: 71, severity: "critical" },
    });
    expect(body.perAgent).toHaveLength(4);
  });

  it("degrades gracefully when the keychain has no token", async () => {
    setLimitsDeps({ ...routeDeps(), runner: async () => "" });
    const response = await app.request("/api/limits");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.bestAccount).toBeNull();
    expect(body.accounts[0]).toMatchObject({
      usage: null,
      error: "no token in keychain",
    });
  });
});

describe("supported sources", () => {
  it("lists all four agents on /api/sources", async () => {
    const response = await app.request("/api/sources");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.sources.map((source: { id: string }) => source.id)).toEqual([
      "claude",
      "codex",
      "kimi",
      "grok",
    ]);
  });

  it("rejects unknown sources with the four-source message", async () => {
    const response = await app.request(
      "/api/summary?sources=not-a-source&maxFiles=1",
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.issues[0]).toMatchObject({
      message: "Sources must contain only claude, codex, kimi or grok.",
    });
  });
});
