import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  aggregateUsage,
  type ModelSlice,
  type ScanOptions,
  type ScanResult,
  scanLocalUsage,
  type UsageSource,
} from "@ziplyne/core";
import { z } from "zod";
import {
  type ConnectionsPayload,
  getConnectionsPayload,
} from "./connections.js";
import {
  type CommandRunner,
  defaultRunner,
  getLiveSessionsPayload,
  type LiveSessionsResponse,
} from "./live.js";

// Port of the xbar claude-usage.1m.py script, generalized to also cover the
// per-agent local burn from @ziplyne/core. The Anthropic oauth usage endpoint
// rate-limits aggressively, so every account read goes through a per-account
// JSON cache (fresh for CACHE_FRESH_MS) and falls back to stale cache on any
// token/fetch failure, exactly like the Python get_usage flow.

export interface ClaudeAccount {
  label: string;
  email: string;
  command: string;
  service: string;
}

export const DEFAULT_ACCOUNTS: ClaudeAccount[] = [
  {
    label: "default",
    email: "",
    command: "claude",
    service: "Claude Code-credentials",
  },
];

export const USAGE_API = "https://api.anthropic.com/api/oauth/usage";
export const CACHE_FRESH_MS = 240_000;
export const BURN_TTL_MS = 120_000;
const TOKEN_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 6_000;
const WEEK_DAYS = 7;

const accountSchema = z.object({
  label: z.string().min(1),
  email: z.string(),
  command: z.string(),
  service: z.string().min(1),
});
const limitsConfigSchema = z.object({
  accounts: z.array(accountSchema).optional(),
});

// Raw shape of the Anthropic oauth usage endpoint (fields defensive, the
// endpoint has shifted before).
export interface RawUsageLimit {
  kind?: string;
  percent?: number;
  severity?: string;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string } } | null;
}

export interface RawUsage {
  limits?: RawUsageLimit[];
}

export interface ShapedLimit {
  kind: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  scope?: string;
}

export interface InterpretedUsage {
  session: ShapedLimit | null;
  weeklyAll: ShapedLimit | null;
  weeklyScoped: ShapedLimit[];
}

export interface BestAccount {
  label: string;
  worstPct: number;
  severity: string;
}

export interface AccountUsageRow {
  label: string;
  email: string;
  command: string;
  usage: InterpretedUsage | null;
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
}

export interface AgentBurn {
  source: UsageSource;
  todayCostUsd: number;
  todayTokens: number;
  weekCostUsd: number;
  weekTokens: number;
  models: ModelSlice[];
  // Per local-profile breakdown (multi-account Claude setups), when present.
  accounts?: AgentAccountBurn[];
}

export interface AgentAccountBurn {
  account: string;
  todayCostUsd: number;
  todayTokens: number;
  weekCostUsd: number;
  weekTokens: number;
}

export interface LimitsPayload {
  updatedAt: string;
  bestAccount: BestAccount | null;
  accounts: AccountUsageRow[];
  agents: AgentBurn[];
}

export interface TraySummary {
  updatedAt: string;
  attention: { count: number };
  connections: { count: number };
  today: { costUsd: number; tokens: number };
  bestAccount: BestAccount | null;
  perAgent: Array<{ source: UsageSource; costUsd: number; tokens: number }>;
}

// Everything that touches the outside world is injectable so tests stay
// hermetic: clock, keychain shell-out, network, cache/config paths, the local
// scan, and the live-session probe.
export interface LimitsDeps {
  now?: () => number;
  runner?: CommandRunner;
  fetchImpl?: typeof globalThis.fetch;
  cacheDir?: string;
  configPath?: string;
  scanUsage?: (options: ScanOptions) => Promise<ScanResult>;
  liveSessions?: () => Promise<LiveSessionsResponse>;
  connections?: () => Promise<ConnectionsPayload>;
}

// xbar severity -> dot/color semantics.
const SEV_DOT: Record<string, string> = {
  critical: "\u{1F534}",
  warning: "\u{1F7E1}",
};
const SEV_COLOR: Record<string, string> = {
  critical: "red",
  warning: "#e0a300",
};

export function severityDot(severity: string): string {
  return SEV_DOT[severity] ?? "\u{1F7E2}";
}

export function severityColor(severity: string): string | null {
  return SEV_COLOR[severity] ?? null;
}

export function getLimit(
  usage: RawUsage,
  kind: string,
  modelName?: string,
): RawUsageLimit | null {
  for (const limit of usage.limits ?? []) {
    if (limit.kind !== kind) {
      continue;
    }
    if (modelName !== undefined) {
      const model = limit.scope?.model ?? {};
      if (model.display_name !== modelName) {
        continue;
      }
    }
    return limit;
  }
  return null;
}

function shapeLimit(limit: RawUsageLimit): ShapedLimit {
  const scopeModel = limit.scope?.model?.display_name;
  return {
    kind: limit.kind ?? "unknown",
    percent: limit.percent ?? 0,
    severity: limit.severity ?? "normal",
    resetsAt: limit.resets_at ?? null,
    ...(scopeModel ? { scope: scopeModel } : {}),
  };
}

export function interpretUsage(usage: RawUsage): InterpretedUsage {
  const session = getLimit(usage, "session");
  const weeklyAll = getLimit(usage, "weekly_all");
  return {
    session: session ? shapeLimit(session) : null,
    weeklyAll: weeklyAll ? shapeLimit(weeklyAll) : null,
    weeklyScoped: (usage.limits ?? [])
      .filter((limit) => limit.kind === "weekly_scoped")
      .map(shapeLimit),
  };
}

// Worst of session / weekly_all / Fable-scoped weekly, first one wins ties —
// a direct port of the Python worst_of.
export function worstOf(
  usage: RawUsage,
): { percent: number; severity: string } | null {
  let worst: { percent: number; severity: string } | null = null;
  for (const limit of [
    getLimit(usage, "session"),
    getLimit(usage, "weekly_all"),
    getLimit(usage, "weekly_scoped", "Fable"),
  ]) {
    if (!limit) {
      continue;
    }
    const percent = limit.percent ?? 0;
    if (!worst || percent > worst.percent) {
      worst = { percent, severity: limit.severity ?? "normal" };
    }
  }
  return worst;
}

// Best account = the one whose worst limit percentage is lowest. Accounts
// without data (or without any limits) are skipped, first one wins ties.
export function pickBestAccount(
  rows: Array<{ label: string; usage: RawUsage | null }>,
): BestAccount | null {
  let best: BestAccount | null = null;
  for (const row of rows) {
    if (!row.usage) {
      continue;
    }
    const worst = worstOf(row.usage);
    if (!worst) {
      continue;
    }
    if (!best || worst.percent < best.worstPct) {
      best = {
        label: row.label,
        worstPct: worst.percent,
        severity: worst.severity,
      };
    }
  }
  return best;
}

interface UsageCacheEntry {
  usage: RawUsage;
  // Epoch seconds, matching the Python cache files.
  fetched_at: number;
}

function defaultCacheDir(): string {
  return join(homedir(), ".ziplyne-lens", "limits-cache");
}

async function readUsageCache(
  cacheDir: string,
  label: string,
): Promise<UsageCacheEntry | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(cacheDir, `${label}.json`), "utf8"),
    ) as Partial<UsageCacheEntry> | null;
    if (raw && typeof raw.fetched_at === "number" && raw.usage) {
      return { usage: raw.usage, fetched_at: raw.fetched_at };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeUsageCache(
  cacheDir: string,
  label: string,
  usage: RawUsage,
  fetchedAtSeconds: number,
): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, `${label}.json`),
      JSON.stringify({ usage, fetched_at: fetchedAtSeconds }),
      "utf8",
    );
  } catch {
    // Best effort, same as the Python script: a cache write failure must
    // never break the read path.
  }
}

// Reads the Claude Code oauth token from the macOS keychain. The token is
// never logged or returned anywhere beyond the fetch call.
async function readAccessToken(
  service: string,
  runner: CommandRunner,
): Promise<string | null> {
  const stdout = await runner(
    "security",
    ["find-generic-password", "-w", "-s", service],
    TOKEN_TIMEOUT_MS,
  );
  if (!stdout) {
    return null;
  }
  try {
    const parsed = JSON.parse(stdout.trim()) as {
      claudeAiOauth?: { accessToken?: string };
    };
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

async function fetchUsageLive(
  token: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ usage: RawUsage | null; error: string | null }> {
  try {
    const response = await fetchImpl(USAGE_API, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { usage: null, error: `HTTP ${response.status}` };
    }
    return { usage: (await response.json()) as RawUsage, error: null };
  } catch (error) {
    const err = error as Error;
    return { usage: null, error: `${err.name}: ${err.message}` };
  }
}

export interface AccountUsageResult {
  usage: RawUsage | null;
  fetchedAtSeconds: number | null;
  error: string | null;
}

// Port of the Python get_usage: fresh cache wins; otherwise token + live
// fetch; on any failure fall back to the stale cache (with the error).
export async function getAccountUsage(
  account: ClaudeAccount,
  deps: LimitsDeps = {},
): Promise<AccountUsageResult> {
  const now = deps.now ?? Date.now;
  const runner = deps.runner ?? defaultRunner;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const cacheDir = deps.cacheDir ?? defaultCacheDir();

  const cached = await readUsageCache(cacheDir, account.label);
  if (cached && now() - cached.fetched_at * 1_000 < CACHE_FRESH_MS) {
    return {
      usage: cached.usage,
      fetchedAtSeconds: cached.fetched_at,
      error: null,
    };
  }

  const token = await readAccessToken(account.service, runner);
  if (!token) {
    const error = "no token in keychain";
    if (cached) {
      return {
        usage: cached.usage,
        fetchedAtSeconds: cached.fetched_at,
        error,
      };
    }
    return { usage: null, fetchedAtSeconds: null, error };
  }

  const { usage, error } = await fetchUsageLive(token, fetchImpl);
  if (usage) {
    const fetchedAtSeconds = now() / 1_000;
    await writeUsageCache(cacheDir, account.label, usage, fetchedAtSeconds);
    return { usage, fetchedAtSeconds, error: null };
  }
  if (cached) {
    return { usage: cached.usage, fetchedAtSeconds: cached.fetched_at, error };
  }
  return { usage: null, fetchedAtSeconds: null, error };
}

// Accounts come from ~/.ziplyne-lens/config.json ("accounts" array) when
// present, otherwise the standard Claude Code keychain service is used.
export async function loadClaudeAccounts(
  deps: LimitsDeps = {},
): Promise<ClaudeAccount[]> {
  const configPath =
    deps.configPath ?? join(homedir(), ".ziplyne-lens", "config.json");
  try {
    const parsed = limitsConfigSchema.safeParse(
      JSON.parse(await readFile(configPath, "utf8")),
    );
    if (parsed.success && parsed.data.accounts?.length) {
      return parsed.data.accounts;
    }
  } catch {
    // No readable config; fall back to the defaults.
  }
  return DEFAULT_ACCOUNTS;
}

async function getAccountRows(
  deps: LimitsDeps,
): Promise<{ rows: AccountUsageRow[]; bestAccount: BestAccount | null }> {
  const accounts = await loadClaudeAccounts(deps);
  const rows = await Promise.all(
    accounts.map(async (account) => {
      const result = await getAccountUsage(account, deps);
      return {
        label: account.label,
        email: account.email,
        command: account.command,
        usage: result.usage ? interpretUsage(result.usage) : null,
        rawUsage: result.usage,
        fetchedAt: result.fetchedAtSeconds
          ? new Date(result.fetchedAtSeconds * 1_000).toISOString()
          : null,
        stale: result.usage !== null && result.error !== null,
        error: result.error,
      };
    }),
  );
  const bestAccount = pickBestAccount(
    rows.map((row) => ({ label: row.label, usage: row.rawUsage })),
  );
  return {
    rows: rows.map(({ rawUsage: _rawUsage, ...row }) => row),
    bestAccount,
  };
}

const BURN_SOURCES: UsageSource[] = ["claude", "codex", "kimi", "grok"];

// Scanning every local log is expensive, so the per-agent burn is cached in
// memory for BURN_TTL_MS, keyed by the (UTC) day it was computed for.
let burnCache:
  | { day: string; expiresAt: number; agents: AgentBurn[] }
  | undefined;

export async function getAgentBurn(
  deps: LimitsDeps = {},
): Promise<AgentBurn[]> {
  const now = deps.now ?? Date.now;
  const scanUsage = deps.scanUsage ?? scanLocalUsage;
  const nowMs = now();
  // Event days are UTC (the parsers slice ISO timestamps), so "today" and the
  // 7-day window use UTC days too.
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (burnCache && burnCache.day === today && nowMs < burnCache.expiresAt) {
    return burnCache.agents;
  }

  const since = new Date(nowMs - (WEEK_DAYS - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  // Git-owner resolution shells out per repo and is irrelevant for a
  // per-source burn, so it stays off here.
  const scan = await scanUsage({
    since,
    until: today,
    resolveGitOwners: false,
  });
  const weekSummary = aggregateUsage(scan.events);
  const todaySummary = aggregateUsage(
    scan.events.filter((event) => event.day === today),
  );

  const modelsBySource = new Map<UsageSource, Map<string, ModelSlice>>();
  for (const event of scan.events) {
    const models = modelsBySource.get(event.source) ?? new Map();
    const slice = models.get(event.model) ?? {
      model: event.model,
      costUsd: 0,
      totalTokens: 0,
    };
    slice.costUsd = round6(slice.costUsd + event.costUsd);
    slice.totalTokens += event.totalTokens;
    models.set(event.model, slice);
    modelsBySource.set(event.source, models);
  }

  const agents = BURN_SOURCES.map((source) => {
    const week = weekSummary.sources.find((row) => row.source === source);
    const day = todaySummary.sources.find((row) => row.source === source);
    const models = [...(modelsBySource.get(source)?.values() ?? [])]
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 3);
    const accountNames = [
      ...new Set(
        [...weekSummary.accounts, ...todaySummary.accounts]
          .filter((row) => row.source === source)
          .map((row) => row.account),
      ),
    ];
    const accounts = accountNames.map((account) => {
      const accountWeek = weekSummary.accounts.find(
        (row) => row.source === source && row.account === account,
      );
      const accountDay = todaySummary.accounts.find(
        (row) => row.source === source && row.account === account,
      );
      return {
        account,
        todayCostUsd: accountDay?.costUsd ?? 0,
        todayTokens: accountDay?.totalTokens ?? 0,
        weekCostUsd: accountWeek?.costUsd ?? 0,
        weekTokens: accountWeek?.totalTokens ?? 0,
      };
    });
    return {
      source,
      todayCostUsd: day?.costUsd ?? 0,
      todayTokens: day?.totalTokens ?? 0,
      weekCostUsd: week?.costUsd ?? 0,
      weekTokens: week?.totalTokens ?? 0,
      models,
      ...(accounts.length ? { accounts } : {}),
    };
  });
  burnCache = { day: today, expiresAt: nowMs + BURN_TTL_MS, agents };
  return agents;
}

// Deps installed by tests for the route layer; the routes call the builders
// with no arguments, so this is the seam that keeps them hermetic.
let routeDeps: LimitsDeps = {};

export function setLimitsDeps(deps: LimitsDeps): void {
  routeDeps = deps;
  burnCache = undefined;
}

export function resetLimitsState(): void {
  routeDeps = {};
  burnCache = undefined;
}

export async function buildLimitsPayload(
  deps: LimitsDeps = {},
): Promise<LimitsPayload> {
  const merged = { ...routeDeps, ...deps };
  const now = merged.now ?? Date.now;
  const [{ rows, bestAccount }, agents] = await Promise.all([
    getAccountRows(merged),
    getAgentBurn(merged),
  ]);
  return {
    updatedAt: new Date(now()).toISOString(),
    bestAccount,
    accounts: rows,
    agents,
  };
}

export async function buildTraySummary(
  deps: LimitsDeps = {},
): Promise<TraySummary> {
  const merged = { ...routeDeps, ...deps };
  const now = merged.now ?? Date.now;
  const liveSessions = merged.liveSessions ?? getLiveSessionsPayload;
  const [{ bestAccount }, agents, live, connections] = await Promise.all([
    getAccountRows(merged),
    getAgentBurn(merged),
    liveSessions(),
    // The connection probe must never take the tray down with it.
    (merged.connections ?? getConnectionsPayload)().catch(() => null),
  ]);
  return {
    updatedAt: new Date(now()).toISOString(),
    attention: { count: live.counts.needsAttention },
    connections: { count: connections?.counts.total ?? 0 },
    today: {
      costUsd: round6(
        agents.reduce((total, agent) => total + agent.todayCostUsd, 0),
      ),
      tokens: agents.reduce((total, agent) => total + agent.todayTokens, 0),
    },
    bestAccount,
    perAgent: agents.map((agent) => ({
      source: agent.source,
      costUsd: agent.todayCostUsd,
      tokens: agent.todayTokens,
    })),
  };
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
