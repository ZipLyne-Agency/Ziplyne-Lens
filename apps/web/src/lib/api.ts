import {
  aggregateUsage,
  buildPromptLibrary,
  type ClientRule,
  DEMO_CLIENT_RULES,
  DEMO_EVENTS,
  DEMO_PROMPTS,
  type LensSummary,
  type PromptLibrary,
} from "@ziplyne/core/browser";

export type { AppUpdateCheck, AppUpdateInstall } from "./updater.js";
export { checkForAppUpdate, installAppUpdate } from "./updater.js";

export type RangePreset = "7d" | "30d" | "month" | "all";
export type SourceFilter = "all" | "claude" | "codex" | "kimi" | "grok";

export interface ProjectOverrideValue {
  name?: string;
  hidden?: boolean;
}

export interface ProjectConfigResponse {
  rules: ClientRule[];
  overrides: Record<string, ProjectOverrideValue>;
  autoMatch: boolean;
}

export interface ProjectConfigPatch {
  overrides?: Record<string, ProjectOverrideValue>;
  autoMatch?: boolean;
  clientRules?: ClientRule[];
}

export interface GitStatus {
  installed: boolean;
  authenticated: boolean;
}

export interface CleanResult {
  moved: number;
  bytes: number;
  total: number;
  skipped: number;
  dryRun?: boolean;
  errors: string[];
}

export interface LensApiResponse {
  mode: "local" | "demo";
  rules: ClientRule[];
  config?: {
    overrides: Record<string, ProjectOverrideValue>;
    autoMatch: boolean;
  };
  summary: LensSummary;
  scan: {
    scannedFiles: number;
    errors: Array<{ filePath: string; message: string }>;
  };
}

export interface PromptApiResponse {
  mode: "local" | "demo";
  rules: ClientRule[];
  library: PromptLibrary;
  scan: {
    scannedFiles: number;
    errors: Array<{ filePath: string; message: string }>;
  };
}

export interface SummaryQuery {
  range: RangePreset;
  source: SourceFilter;
}

export interface PromptQuery extends SummaryQuery {
  search: string;
  clientId: string;
  includeContent: boolean;
}

export interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
  time: string;
}

interface DesktopStatus {
  api_url?: string | null;
}

let apiBaseUrl: string | undefined;
let apiBaseUrlPromise: Promise<string> | undefined;

export async function fetchSummary(
  query: SummaryQuery,
): Promise<LensApiResponse | undefined> {
  const params = new URLSearchParams();
  const since = sinceForRange(query.range);
  if (since) {
    params.set("since", since);
  }
  if (query.source !== "all") {
    params.set("sources", query.source);
  }
  params.set("maxFiles", "8000");
  try {
    const local = await fetch(
      await apiUrl(`/api/summary?${params.toString()}`),
    );
    if (local.ok) {
      return (await local.json()) as LensApiResponse;
    }
  } catch {
    // The local sidecar isn't reachable yet (still booting / first scan).
  }
  // In the installed desktop app we NEVER show sample data. Signal "not ready"
  // so the UI keeps its loading state and retries until the real scan lands.
  if (isTauriRuntime()) {
    return undefined;
  }
  // Frontend-only web run: the static demo keeps the dashboard useful. Apply the
  // range window so the tabs visibly filter instead of looking like a no-op.
  try {
    const demo = await fetch(await apiUrl("/api/demo-summary"));
    if (demo.ok) {
      return (await demo.json()) as LensApiResponse;
    }
  } catch {
    // Fall through to the static demo below.
  }
  const demoEvents = since
    ? DEMO_EVENTS.filter((event) => event.timestamp >= since)
    : DEMO_EVENTS;
  return {
    mode: "demo",
    rules: DEMO_CLIENT_RULES,
    summary: aggregateUsage(demoEvents, DEMO_CLIENT_RULES),
    scan: { scannedFiles: 0, errors: [] },
  };
}

export async function fetchPrompts(
  query: PromptQuery,
): Promise<PromptApiResponse | undefined> {
  const params = new URLSearchParams();
  const since = sinceForRange(query.range);
  if (since) {
    params.set("since", since);
  }
  if (query.source !== "all") {
    params.set("sources", query.source);
  }
  if (query.search.trim()) {
    params.set("search", query.search.trim());
  }
  if (query.clientId !== "all") {
    params.set("clientId", query.clientId);
  }
  if (query.includeContent) {
    params.set("includeContent", "true");
  }
  params.set("maxFiles", "8000");
  params.set("limit", "250");
  try {
    const local = await fetch(
      await apiUrl(`/api/prompts?${params.toString()}`),
    );
    if (local.ok) {
      return (await local.json()) as PromptApiResponse;
    }
  } catch {
    // The local sidecar isn't reachable yet (still booting / first scan).
  }
  // Desktop app: never show sample prompts — signal "not ready" and retry.
  if (isTauriRuntime()) {
    return undefined;
  }
  try {
    const demo = await fetch(await apiUrl("/api/demo-prompts"));
    if (demo.ok) {
      return (await demo.json()) as PromptApiResponse;
    }
  } catch {
    // The static demo below keeps the prompt workspace useful offline.
  }
  return {
    mode: "demo",
    rules: DEMO_CLIENT_RULES,
    library: buildPromptLibrary(DEMO_PROMPTS, DEMO_CLIENT_RULES, {
      includeContent: query.includeContent,
      search: query.search,
      clientId: query.clientId === "all" ? undefined : query.clientId,
    }),
    scan: { scannedFiles: 0, errors: [] },
  };
}

export async function saveProjectConfig(
  patch: ProjectConfigPatch,
): Promise<ProjectConfigResponse | undefined> {
  try {
    const response = await fetch(await apiUrl("/api/projects/config"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as ProjectConfigResponse;
  } catch {
    return undefined;
  }
}

export async function fetchGitStatus(): Promise<GitStatus | undefined> {
  try {
    const response = await fetch(await apiUrl("/api/git/status"), {
      cache: "no-store",
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as GitStatus;
  } catch {
    return undefined;
  }
}

export async function revealPath(path: string): Promise<boolean> {
  try {
    const response = await fetch(await apiUrl("/api/reveal"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function cleanProject(
  projectId: string,
  dryRun = false,
): Promise<CleanResult | undefined> {
  try {
    const response = await fetch(await apiUrl("/api/projects/clean"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, dryRun }),
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as CleanResult;
  } catch {
    return undefined;
  }
}

export async function fetchHealth(): Promise<HealthResponse | undefined> {
  try {
    const response = await fetch(await apiUrl("/api/health"), {
      cache: "no-store",
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as HealthResponse;
  } catch {
    return undefined;
  }
}

async function apiUrl(path: string): Promise<string> {
  const baseUrl = await resolveApiBaseUrl();
  if (!baseUrl) {
    return path;
  }
  return `${baseUrl}${path}`;
}

async function resolveApiBaseUrl(): Promise<string> {
  if (apiBaseUrl !== undefined) {
    return apiBaseUrl;
  }
  apiBaseUrlPromise ??= loadApiBaseUrl();
  const resolved = await apiBaseUrlPromise;
  apiBaseUrlPromise = undefined;
  // In the desktop app an empty base means the sidecar URL isn't ready yet
  // (desktop_status raced the sidecar boot). Do NOT cache that — retry on the
  // next call so a momentary race can't pin the whole app to the demo fallback.
  // In the browser, "" is the real answer (same-origin), so cache it.
  if (resolved || !isTauriRuntime()) {
    apiBaseUrl = resolved;
  }
  return resolved;
}

async function loadApiBaseUrl(): Promise<string> {
  const configured = import.meta.env.VITE_ZIPLYNE_API_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/u, "");
  }
  if (!isTauriRuntime()) {
    return "";
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const status = await invoke<DesktopStatus>("desktop_status");
    return status.api_url?.replace(/\/$/u, "") ?? "";
  } catch {
    return "";
  }
}

function isTauriRuntime(): boolean {
  const runtime = globalThis as {
    __TAURI_INTERNALS__?: unknown;
    isTauri?: boolean;
  };
  return Boolean(runtime.isTauri || runtime.__TAURI_INTERNALS__);
}

function sinceForRange(range: RangePreset): string | undefined {
  if (range === "all") {
    return undefined;
  }
  const now = new Date();
  const start = new Date(now);
  if (range === "7d") {
    start.setDate(now.getDate() - 6);
  } else if (range === "30d") {
    start.setDate(now.getDate() - 29);
  } else {
    start.setDate(1);
  }
  return start.toISOString().slice(0, 10);
}

/* ====================================================================
   Additive: Live sessions, Limits, and Sources endpoints.
   These reuse the exact same base-url resolution chain as the summary
   fetchers above. There is no demo variant of these payloads (the API
   only ships demo summary/prompts), so an unreachable service yields
   `undefined` and the screens render their own honest error states.
   ==================================================================== */

export interface SourceInfo {
  id: string;
  name: string;
  status: string;
}

export interface SourcesResponse {
  sources: SourceInfo[];
  costNote: string;
}

export type LiveSessionState =
  | "Needs Attention"
  | "Working"
  | "Quiet"
  | "Unknown";

export interface LiveSession {
  id: string;
  pid: number;
  tty: string;
  command: string;
  workingDirectory: string;
  projectName: string;
  host: string;
  cpuPercent: number;
  processState: string;
  provider: string | null;
  state: LiveSessionState;
  reason: string;
  transcript?: string;
  lastObservedAt: string;
}

export interface LiveProjectGroup {
  id: string;
  name: string;
  workingDirectory: string;
  sessions: LiveSession[];
  attentionCount: number;
}

// Recently-ended ("dead") agent sessions, remembered server-side for 48h so
// the board can show an Ended column. Dismissed via /api/live/dismiss.
export interface EndedSession {
  id: string;
  pid: number;
  tty: string;
  command: string;
  workingDirectory: string;
  projectName: string;
  host: string;
  provider: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  endedAt: string;
}

export interface LiveSessionsResponse {
  generatedAt: string;
  sessions: LiveSession[];
  groups: LiveProjectGroup[];
  counts: {
    total: number;
    working: number;
    quiet: number;
    needsAttention: number;
    unknown: number;
  };
  ended: EndedSession[];
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
  source: string;
  todayCostUsd: number;
  todayTokens: number;
  weekCostUsd: number;
  weekTokens: number;
  models: Array<{ model: string; costUsd: number; totalTokens: number }>;
  // Per-profile breakdown for multi-account agents (Claude "default"/"azl"/…).
  // Absent when the agent has a single local profile.
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

export async function fetchSources(): Promise<SourcesResponse | undefined> {
  try {
    const response = await fetch(await apiUrl("/api/sources"), {
      cache: "no-store",
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as SourcesResponse;
  } catch {
    return undefined;
  }
}

export async function fetchLiveSessions(options: {
  transcripts: boolean;
}): Promise<LiveSessionsResponse | undefined> {
  const params = new URLSearchParams();
  if (options.transcripts) {
    params.set("transcripts", "1");
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  try {
    const response = await fetch(await apiUrl(`/api/live/sessions${suffix}`), {
      cache: "no-store",
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as LiveSessionsResponse;
  } catch {
    return undefined;
  }
}

export async function fetchLimits(): Promise<LimitsPayload | undefined> {
  try {
    const response = await fetch(await apiUrl("/api/limits"), {
      cache: "no-store",
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as LimitsPayload;
  } catch {
    return undefined;
  }
}

// Archives one ended session off the board. False when the service is
// unreachable or the id is unknown (already dismissed / pruned).
export async function dismissEndedSession(id: string): Promise<boolean> {
  try {
    const response = await fetch(await apiUrl("/api/live/dismiss"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/* ====================================================================
   Additive: Connections, CLI tools, project registry, and open-target
   endpoints (Sesshy port). Same base-url chain and "undefined on
   failure" contract as the fetchers above — no demo fallback.
   ==================================================================== */

export type ConnectionKind =
  | "ssh"
  | "database"
  | "tunnel"
  | "cloud"
  | "agent"
  | "other";

export interface SocketEndpoint {
  local: string;
  remote: string;
  state?: string;
}

export interface ConnectionSession {
  id: string;
  pid: number;
  tty: string;
  terminalName: string;
  kind: ConnectionKind;
  title: string;
  target: string;
  subtitle: string;
  commandLine: string; // already redacted server-side
  workingDirectory?: string;
  elapsedSeconds: number;
  connections: SocketEndpoint[];
  gitBranch?: string;
  gitRepoRoot?: string;
}

export interface ConnectionsPayload {
  generatedAt: string;
  counts: Record<ConnectionKind | "total", number>;
  sessions: ConnectionSession[];
}

export type ToolState = "loggedIn" | "installed";
export type ToolSource = "registry" | "discovered";

export interface ToolItem {
  executable: string;
  title: string;
  kind: string;
  state: ToolState;
  source: ToolSource;
  installedPath?: string;
  credentialPath?: string;
}

export type CredentialUrgency = "expired" | "imminent" | "soon" | "ok";

export interface CredentialExpiryItem {
  provider: string;
  label: string;
  expiresAt: string; // ISO
  urgency: CredentialUrgency;
  evidencePath: string;
}

export interface ToolsPayload {
  generatedAt: string;
  counts: {
    total: number;
    loggedIn: number;
    installed: number;
    discovered: number;
  };
  tools: ToolItem[];
  expiring: CredentialExpiryItem[];
}

export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  repoUrl?: string;
  repoOwner?: string;
  repoName?: string;
  gitBranch?: string;
  lastActiveAt: string; // ISO
  live: boolean;
  hasUsage: boolean;
  costUsd30d?: number;
}

export interface ProjectsPayload {
  generatedAt: string;
  projects: ProjectEntry[];
}

export interface OpenResult {
  ok: boolean;
  error?: string;
}

export async function fetchConnections(): Promise<
  ConnectionsPayload | undefined
> {
  try {
    const response = await fetch(await apiUrl("/api/connections"), {
      cache: "no-store",
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as ConnectionsPayload;
  } catch {
    return undefined;
  }
}

export async function fetchTools(): Promise<ToolsPayload | undefined> {
  try {
    const response = await fetch(await apiUrl("/api/tools"), {
      cache: "no-store",
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as ToolsPayload;
  } catch {
    return undefined;
  }
}

export async function fetchProjects(): Promise<ProjectsPayload | undefined> {
  try {
    const response = await fetch(await apiUrl("/api/projects"), {
      cache: "no-store",
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as ProjectsPayload;
  } catch {
    return undefined;
  }
}

// Opens a repo path in Zed or an https URL in the browser via the local
// service. Never throws — the caller renders `error` when ok is false.
export async function openTarget(
  target: { path: string } | { url: string },
): Promise<OpenResult> {
  try {
    const response = await fetch(await apiUrl("/api/open"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(target),
    });
    if (response.ok) {
      return { ok: true };
    }
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    return {
      ok: false,
      error: typeof body?.error === "string" ? body.error : "Open failed",
    };
  } catch {
    return { ok: false, error: "Local service unreachable" };
  }
}
