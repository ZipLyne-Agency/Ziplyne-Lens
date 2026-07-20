import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  aggregateUsage,
  buildPromptLibrary,
  type ClientRule,
  DEMO_CLIENT_RULES,
  DEMO_EVENTS,
  DEMO_PROMPTS,
  invalidateFileProjectCache,
  type ProjectOverride,
  scanFileProjects,
  scanLocalPrompts,
  scanLocalUsage,
  type UsageSource,
} from "@ziplyne/core";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { getConnectionsPayload } from "./connections.js";
import { getToolsPayload } from "./inventory.js";
import { buildLimitsPayload, buildTraySummary } from "./limits.js";
import { getLiveSessionsPayload } from "./live.js";
import { getProjectsPayload } from "./projects.js";
import { createScanCache } from "./scan-cache.js";
import {
  dismissEndedSession,
  getEndedSessions,
  trackLiveSessions,
} from "./session-history.js";

const execFileAsync = promisify(execFile);

// Scans re-read up to `maxFiles` log files; dashboard polls arrive far more
// often than the logs meaningfully change. Share in-flight scans and reuse
// fresh results briefly so polls stay cheap (see scan-cache.ts). Two minutes
// because the background warmer refreshes the hot keys every 60s anyway.
const SCAN_CACHE_TTL_MS = 120_000;
const cachedScanLocalUsage = createScanCache(
  SCAN_CACHE_TTL_MS,
  scanLocalUsage,
  (args) =>
    JSON.stringify([
      args?.sources,
      args?.since,
      args?.until,
      args?.maxFiles,
      args?.resolveGitOwners,
    ]),
);
const cachedScanLocalPrompts = createScanCache(
  SCAN_CACHE_TTL_MS,
  scanLocalPrompts,
  (args) =>
    JSON.stringify([
      args?.sources,
      args?.since,
      args?.until,
      args?.maxFiles,
      args?.resolveGitOwners,
      args?.includePromptContent,
    ]),
);

// Pre-warm the exact cache keys the dashboard's default view requests, so the
// first paint after launch never waits on a scan. The web's 30-day range is
// "29 days back from today" (see sinceForRange in apps/web/src/lib/api.ts).
export async function warmSummaryCaches(): Promise<void> {
  const config = await loadProjectConfig();
  const start = new Date();
  start.setDate(start.getDate() - 29);
  const since = start.toISOString().slice(0, 10);
  await Promise.allSettled([
    cachedScanLocalUsage({
      since,
      maxFiles: 8_000,
      resolveGitOwners: config.autoMatch,
    }),
    cachedScanLocalPrompts({
      since,
      maxFiles: 8_000,
      resolveGitOwners: config.autoMatch,
    }),
  ]);
}

// The all-time view (no `since`) is the most expensive scan the app can
// request; the warmer refreshes it on a slow cadence in the background.
export async function warmAllTimeCaches(): Promise<void> {
  const config = await loadProjectConfig();
  await Promise.allSettled([
    cachedScanLocalUsage({
      maxFiles: 8_000,
      resolveGitOwners: config.autoMatch,
    }),
    cachedScanLocalPrompts({
      maxFiles: 8_000,
      resolveGitOwners: config.autoMatch,
    }),
  ]);
}

const supportedSources = new Set<UsageSource>([
  "claude",
  "codex",
  "kimi",
  "grok",
]);
const allowedCorsOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
]);

// The only directories from which "clean" may ever move files to the Trash.
// Every deletable path is checked for containment under one of these.
const trustedRoots = [
  join(homedir(), ".claude"),
  join(homedir(), ".config", "claude"),
  join(homedir(), ".codex"),
];

const sourcesSchema = z
  .string()
  .optional()
  .superRefine((raw, ctx) => {
    if (!raw) {
      return;
    }
    const invalid = raw
      .split(",")
      .map((source) => source.trim())
      .some((source) => !supportedSources.has(source as UsageSource));
    if (invalid) {
      ctx.addIssue({
        code: "custom",
        message: "Sources must contain only claude, codex, kimi or grok.",
      });
    }
  });

const querySchema = z.object({
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
  sources: sourcesSchema,
  maxFiles: z.coerce.number().int().positive().max(10_000).optional(),
});

const promptQuerySchema = querySchema.extend({
  includeContent: z.enum(["true", "false"]).optional(),
  search: z.string().optional(),
  clientId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1_000).optional(),
});

const clientRulesSchema = z.array(
  z.object({
    clientId: z.string(),
    clientName: z.string(),
    match: z.string(),
  }),
);

const overrideSchema = z.object({
  name: z.string().optional(),
  hidden: z.boolean().optional(),
});

const projectConfigSchema = z.object({
  clientRules: clientRulesSchema.optional(),
  overrides: z.record(z.string(), overrideSchema).optional(),
  autoMatch: z.boolean().optional(),
});

const liveQuerySchema = z.object({
  transcripts: z.enum(["1", "true"]).optional(),
});

export const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin) => (allowedCorsOrigins.has(origin) ? origin : undefined),
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    maxAge: 600,
  }),
);

// Guard for mutating routes: a browser request from a page we don't trust sends
// an Origin header that isn't in the allow-list, so reject it. Native callers
// (curl, the app's own tooling) send no Origin and are allowed. The socket is
// already loopback-only, so this closes the drive-by-CSRF gap.
const requireTrustedOrigin: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && !allowedCorsOrigins.has(origin)) {
    return c.json({ error: "Forbidden origin" }, 403);
  }
  await next();
};

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    name: "ZipLyne Lens API",
    version: "0.1.0",
    time: new Date().toISOString(),
  }),
);

app.get("/api/sources", (c) =>
  c.json({
    sources: [
      { id: "claude", name: "Claude Code", status: "supported" },
      { id: "codex", name: "Codex CLI", status: "supported" },
      { id: "kimi", name: "Kimi Code", status: "supported" },
      { id: "grok", name: "Grok CLI", status: "supported" },
    ],
    costNote:
      "Costs are estimates unless local logs include official cost fields.",
  }),
);

app.get("/api/demo-summary", (c) =>
  c.json({
    mode: "demo",
    rules: DEMO_CLIENT_RULES,
    summary: aggregateUsage(DEMO_EVENTS, DEMO_CLIENT_RULES),
    scan: { scannedFiles: 0, errors: [] },
  }),
);

app.get("/api/demo-prompts", (c) => {
  const rules = DEMO_CLIENT_RULES;
  return c.json({
    mode: "demo",
    rules,
    library: buildPromptLibrary(DEMO_PROMPTS, rules),
    scan: { scannedFiles: 0, errors: [] },
  });
});

app.get("/api/summary", async (c) => {
  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }
  const sources = parseSources(parsed.data.sources);
  const config = await loadProjectConfig();
  const scan = await cachedScanLocalUsage({
    sources,
    since: parsed.data.since,
    until: parsed.data.until,
    maxFiles: parsed.data.maxFiles,
    resolveGitOwners: config.autoMatch,
  });
  // Warm the file -> project map in the background so the first "Clean data"
  // click resolves instantly instead of re-scanning the whole history then.
  warmFileProjectCache(config);
  return c.json({
    mode: "local",
    rules: config.rules,
    config: { overrides: config.overrides, autoMatch: config.autoMatch },
    summary: aggregateUsage(scan.events, config.rules, {
      overrides: config.overrides,
      autoMatch: config.autoMatch,
    }),
    scan: {
      scannedFiles: scan.scannedFiles,
      errors: scan.errors.slice(0, 25),
    },
  });
});

app.get("/api/prompts", async (c) => {
  const parsed = promptQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }
  const sources = parseSources(parsed.data.sources);
  const config = await loadProjectConfig();
  const scan = await cachedScanLocalPrompts({
    sources,
    since: parsed.data.since,
    until: parsed.data.until,
    maxFiles: parsed.data.maxFiles,
    resolveGitOwners: config.autoMatch,
    includePromptContent: parsed.data.includeContent === "true",
  });
  return c.json({
    mode: "local",
    rules: config.rules,
    library: buildPromptLibrary(scan.prompts, config.rules, {
      includeContent: parsed.data.includeContent === "true",
      search: parsed.data.search,
      clientId: parsed.data.clientId,
      limit: parsed.data.limit,
      config: { overrides: config.overrides, autoMatch: config.autoMatch },
    }),
    scan: {
      scannedFiles: scan.scannedFiles,
      errors: scan.errors.slice(0, 25),
    },
  });
});

app.get("/api/projects/config", async (c) => {
  const config = await loadProjectConfig();
  return c.json({
    rules: config.rules,
    overrides: config.overrides,
    autoMatch: config.autoMatch,
  });
});

app.put("/api/projects/config", requireTrustedOrigin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = projectConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid config", issues: parsed.error.issues },
      400,
    );
  }
  const saved = await saveProjectConfig(parsed.data);
  return c.json(saved);
});

app.get("/api/git/status", requireTrustedOrigin, async (c) => {
  let installed = false;
  let authenticated = false;
  try {
    await execFileAsync("gh", ["--version"], { timeout: 3_000 });
    installed = true;
  } catch {
    // gh is not installed; report installed:false.
  }
  if (installed) {
    try {
      await execFileAsync("gh", ["auth", "status"], { timeout: 5_000 });
      authenticated = true;
    } catch {
      // Non-zero exit means gh is installed but not logged in.
    }
  }
  return c.json({ installed, authenticated });
});

app.get("/api/live/sessions", async (c) => {
  const parsed = liveQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }
  const payload = await getLiveSessionsPayload({
    includeTranscripts: parsed.data.transcripts !== undefined,
  });
  // Track every scan so recently-ended sessions stay visible on the board
  // (see session-history.ts).
  const nowMs = Date.now();
  await trackLiveSessions(payload.sessions, nowMs);
  const ended = await getEndedSessions(nowMs);
  return c.json({ ...payload, ended });
});

// Dismiss one ended session off the board (archive it).
app.post("/api/live/dismiss", requireTrustedOrigin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) {
    return c.json({ error: "An id is required" }, 400);
  }
  const dismissed = await dismissEndedSession(id);
  if (!dismissed) {
    return c.json({ error: "Session not found" }, 404);
  }
  return c.json({ ok: true });
});

app.get("/api/limits", async (c) => c.json(await buildLimitsPayload()));

app.get("/api/tray-summary", async (c) => c.json(await buildTraySummary()));

app.get("/api/connections", async (c) => c.json(await getConnectionsPayload()));

app.get("/api/tools", async (c) => c.json(await getToolsPayload()));

app.get("/api/projects", async (c) => c.json(await getProjectsPayload()));

// One-click openers for the projects view: a repo path in Zed, or an
// https URL (e.g. the repo on GitHub) in the browser. Paths must live
// under $HOME; URLs must be https.
app.post("/api/open", requireTrustedOrigin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const path = typeof body?.path === "string" ? body.path : "";
  const url = typeof body?.url === "string" ? body.url : "";

  if (url) {
    if (!url.startsWith("https://")) {
      return c.json({ error: "Only https URLs are allowed" }, 403);
    }
    try {
      await execFileAsync("open", [url], { timeout: 5_000 });
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Could not open the URL" }, 500);
    }
  }

  if (!path) {
    return c.json({ error: "A path or url is required" }, 400);
  }
  const resolved = resolve(path);
  if (!isUnderHome(resolved)) {
    return c.json({ error: "Path is not allowed" }, 403);
  }
  try {
    await stat(resolved);
  } catch {
    return c.json({ error: "Path no longer exists" }, 404);
  }
  try {
    await execFileAsync("open", ["-a", "Zed", resolved], { timeout: 5_000 });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "Could not open Zed" }, 500);
  }
});

app.post("/api/reveal", requireTrustedOrigin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const path = typeof body?.path === "string" ? body.path : "";
  if (!path) {
    return c.json({ error: "A path is required" }, 400);
  }
  const resolved = resolve(path);
  if (!isUnderHome(resolved)) {
    return c.json({ error: "Path is not allowed" }, 403);
  }
  try {
    await stat(resolved);
  } catch {
    return c.json({ error: "Path no longer exists" }, 404);
  }
  try {
    await execFileAsync("open", [resolved], { timeout: 5_000 });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "Could not open the folder" }, 500);
  }
});

app.post("/api/projects/clean", requireTrustedOrigin, async (c) => {
  const body = await c.req.json().catch(() => null);
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  if (!projectId) {
    return c.json({ error: "A projectId is required" }, 400);
  }
  const dryRun = body?.dryRun === true;
  const config = await loadProjectConfig();
  // The preview may use the warm cache, but the actual delete rebuilds the map
  // now (fresh) so a session that gained a second project since the last scan
  // is correctly seen as multi-project and skipped, never trashed.
  const fileProjects = await scanFileProjects(
    { maxFiles: 100_000, resolveGitOwners: config.autoMatch, fresh: !dryRun },
    config.rules,
    { overrides: config.overrides, autoMatch: config.autoMatch },
  );
  // Only delete files that belong SOLELY to this project. A session that also
  // touched another project is kept and counted as skipped, so cleaning one
  // project can never take another project's data with it.
  const targets = fileProjects.filter(
    (file) =>
      file.clientIds.length === 1 &&
      file.clientIds[0] === projectId &&
      isUnderTrustedRoot(file.filePath),
  );
  const skipped = fileProjects.filter(
    (file) => file.clientIds.length > 1 && file.clientIds.includes(projectId),
  ).length;

  if (dryRun) {
    let bytes = 0;
    for (const target of targets) {
      try {
        bytes += (await stat(target.filePath)).size;
      } catch {
        // File vanished between scan and stat; ignore for the estimate.
      }
    }
    return c.json({
      ok: true,
      dryRun: true,
      total: targets.length,
      bytes,
      skipped,
      moved: 0,
      errors: [],
    });
  }

  let moved = 0;
  let bytes = 0;
  const errors: string[] = [];
  for (const target of targets) {
    try {
      const info = await stat(target.filePath);
      await moveToTrash(target.filePath);
      // Count size only after the move actually succeeds.
      bytes += info.size;
      moved += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Unknown error");
    }
  }
  // The trashed files are no longer present; drop the cache so a re-opened
  // dialog (or the next summary warm) rebuilds an accurate map.
  invalidateFileProjectCache();
  return c.json({
    ok: true,
    moved,
    bytes,
    total: targets.length,
    skipped,
    errors: errors.slice(0, 10),
  });
});

function parseSources(raw: string | undefined): UsageSource[] | undefined {
  if (!raw) {
    return undefined;
  }
  const sources = raw
    .split(",")
    .map((source) => source.trim())
    .filter((source): source is UsageSource =>
      supportedSources.has(source as UsageSource),
    );
  return sources.length ? sources : undefined;
}

interface LoadedConfig {
  rules: ClientRule[];
  overrides: Record<string, ProjectOverride>;
  autoMatch: boolean;
}

function homeConfigPath(): string {
  return join(homedir(), ".ziplyne-lens", "config.json");
}

async function loadProjectConfig(): Promise<LoadedConfig> {
  const envRules = parseClientRules(process.env.ZIPLYNE_CLIENT_RULES);
  let fileConfig: z.infer<typeof projectConfigSchema> = {};
  for (const path of [
    join(process.cwd(), "ziplyne-lens.config.json"),
    homeConfigPath(),
  ]) {
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      const parsed = projectConfigSchema.safeParse(raw);
      if (parsed.success) {
        fileConfig = parsed.data;
        break;
      }
    } catch {
      // No config at this path; try the next one.
    }
  }
  return {
    rules: envRules.length ? envRules : (fileConfig.clientRules ?? []),
    overrides: fileConfig.overrides ?? {},
    autoMatch: fileConfig.autoMatch ?? true,
  };
}

export async function saveProjectConfig(
  patch: z.infer<typeof projectConfigSchema>,
  path = homeConfigPath(),
): Promise<LoadedConfig> {
  let existing: z.infer<typeof projectConfigSchema> = {};
  let existingDocument: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      existingDocument = raw as Record<string, unknown>;
    }
    const parsed = projectConfigSchema.safeParse(raw);
    if (parsed.success) {
      existing = parsed.data;
    }
  } catch {
    // First write; start from an empty config.
  }
  const merged: z.infer<typeof projectConfigSchema> = {
    clientRules: patch.clientRules ?? existing.clientRules,
    autoMatch: patch.autoMatch ?? existing.autoMatch,
    overrides: mergeOverrides(existing.overrides, patch.overrides),
  };
  await mkdir(dirname(path), { recursive: true });
  const document = { ...existingDocument, ...merged };
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
  // Hide/rename/auto-match changes the file -> project map; drop the cache so
  // the next clean reflects them instead of waiting out the TTL.
  invalidateFileProjectCache();
  return {
    rules: merged.clientRules ?? [],
    overrides: merged.overrides ?? {},
    autoMatch: merged.autoMatch ?? true,
  };
}

// Fire-and-forget: prime the file -> project cache with the SAME options the
// clean route uses, so a later "Clean data" click hits the cache. Errors are
// swallowed; this is a best-effort warm, never on the request's critical path.
function warmFileProjectCache(config: LoadedConfig): void {
  void scanFileProjects(
    { maxFiles: 100_000, resolveGitOwners: config.autoMatch },
    config.rules,
    { overrides: config.overrides, autoMatch: config.autoMatch },
  ).catch(() => {
    // Best effort; the clean route will scan on demand if this didn't finish.
  });
}

function mergeOverrides(
  existing: Record<string, ProjectOverride> = {},
  patch?: Record<string, ProjectOverride>,
): Record<string, ProjectOverride> {
  if (!patch) {
    return existing;
  }
  const out: Record<string, ProjectOverride> = { ...existing };
  for (const [id, override] of Object.entries(patch)) {
    out[id] = { ...out[id], ...override };
  }
  return out;
}

function parseClientRules(raw: string | undefined): ClientRule[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = clientRulesSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function isUnderHome(path: string): boolean {
  const home = resolve(homedir());
  const target = resolve(path);
  return target === home || target.startsWith(home + sep);
}

function isUnderTrustedRoot(path: string): boolean {
  const target = resolve(path);
  return trustedRoots.some(
    (root) => target === root || target.startsWith(root + sep),
  );
}

async function moveToTrash(filePath: string): Promise<void> {
  const trashDir = join(homedir(), ".Trash");
  await mkdir(trashDir, { recursive: true });
  const base = basename(filePath);
  let dest = join(trashDir, base);
  try {
    await stat(dest);
    // Name taken in Trash: disambiguate so we never clobber an existing item.
    const ext = extname(base);
    dest = join(trashDir, `${basename(base, ext)}-${Date.now()}${ext}`);
  } catch {
    // Destination is free.
  }
  try {
    await rename(filePath, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      // Trash on a different volume: copy then remove.
      await copyFile(filePath, dest);
      await unlink(filePath);
      return;
    }
    throw error;
  }
}
