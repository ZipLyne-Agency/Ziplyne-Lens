import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import { resolveAttribution } from "./attribution.js";
import { EventCache } from "./event-cache.js";
import {
  extractClaudePrompts,
  normalizeClaudeJsonl,
} from "./parsers/claude.js";
import { extractCodexPrompts, normalizeCodexJsonl } from "./parsers/codex.js";
import { extractGrokPrompts, normalizeGrokJsonl } from "./parsers/grok.js";
import { extractKimiPrompts, normalizeKimiJsonl } from "./parsers/kimi.js";
import type {
  ClientRule,
  ParseContext,
  ProjectConfig,
  PromptRecord,
  UsageEvent,
  UsageSource,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ScanOptions {
  homeDir?: string;
  sources?: UsageSource[];
  since?: string;
  until?: string;
  maxFiles?: number;
  // Resolve each repo's git remote owner so usage can be grouped by owner.
  // Defaults to true; the API turns it off when auto-matching is disabled.
  resolveGitOwners?: boolean;
  // Bypass the scanFileProjects cache and rebuild the map now. Used by the
  // destructive clean so it never acts on a stale file -> project classification.
  fresh?: boolean;
  // Prompt scans normally reuse a redacted disk cache. Explicit reveal
  // requests bypass it so raw content is read only from the source logs.
  includePromptContent?: boolean;
}

export interface ScanResult {
  events: UsageEvent[];
  scannedFiles: number;
  errors: Array<{ filePath: string; message: string }>;
}

export interface PromptScanResult {
  prompts: PromptRecord[];
  scannedFiles: number;
  errors: Array<{ filePath: string; message: string }>;
}

const DEFAULT_SOURCES: UsageSource[] = ["claude", "codex", "kimi", "grok"];
const DEFAULT_MAX_FILES = 8_000;

const usageNormalizers: Record<
  UsageSource,
  (jsonl: string, context: ParseContext) => UsageEvent[]
> = {
  claude: normalizeClaudeJsonl,
  codex: normalizeCodexJsonl,
  kimi: normalizeKimiJsonl,
  grok: normalizeGrokJsonl,
};

const promptExtractors: Record<
  UsageSource,
  (jsonl: string, context: ParseContext) => PromptRecord[]
> = {
  claude: extractClaudePrompts,
  codex: extractCodexPrompts,
  kimi: extractKimiPrompts,
  grok: extractGrokPrompts,
};

export async function scanLocalUsage(
  options: ScanOptions = {},
): Promise<ScanResult> {
  const sources = options.sources?.length ? options.sources : DEFAULT_SOURCES;
  const home = options.homeDir ?? homedir();
  const files = await collectUsageFiles(
    home,
    sources,
    options.maxFiles ?? DEFAULT_MAX_FILES,
  );
  const candidates = collectCandidates(files, options.since);
  const cache = new EventCache(home);
  const errors: ScanResult["errors"] = [];
  const events: UsageEvent[] = [];

  for (let index = 0; index < candidates.length; index++) {
    // Parsing megabytes of JSONL is CPU-bound and synchronous; yield often so
    // a long scan never starves concurrent API requests.
    if (index % 32 === 31) {
      await yieldToEventLoop();
    }
    const file = candidates[index] as CandidateFile;
    try {
      const hit = await cache.get(file.path, file.mtimeMs, file.size);
      let parsed: UsageEvent[];
      if (hit?.events) {
        parsed = hit.events;
      } else {
        const jsonl = await readFile(file.path, "utf8");
        parsed = usageNormalizers[file.source](jsonl, {
          filePath: file.path,
          ...(file.source === "claude"
            ? { account: claudeAccountFor(file.path, home) }
            : {}),
        });
        cache.set(file.path, file.mtimeMs, file.size, { events: parsed });
      }
      events.push(
        ...parsed.filter((event) =>
          dateInRange(event.day, options.since, options.until),
        ),
      );
    } catch (error) {
      errors.push({
        filePath: file.path,
        message: error instanceof Error ? error.message : "Unknown read error",
      });
    }
  }
  await cache.flush();

  if (options.resolveGitOwners !== false) {
    await enrichWithGitOwners(events);
  }
  return { events: dedupeEvents(events), scannedFiles: files.length, errors };
}

export async function scanLocalPrompts(
  options: ScanOptions = {},
): Promise<PromptScanResult> {
  const sources = options.sources?.length ? options.sources : DEFAULT_SOURCES;
  const home = options.homeDir ?? homedir();
  const files = await collectUsageFiles(
    home,
    sources,
    options.maxFiles ?? DEFAULT_MAX_FILES,
  );
  const candidates = collectCandidates(files, options.since);
  const cache = new EventCache(home);
  const errors: PromptScanResult["errors"] = [];
  const prompts: PromptRecord[] = [];

  for (let index = 0; index < candidates.length; index++) {
    if (index % 32 === 31) {
      await yieldToEventLoop();
    }
    const file = candidates[index] as CandidateFile;
    try {
      const hit = options.includePromptContent
        ? undefined
        : await cache.get(file.path, file.mtimeMs, file.size);
      let parsed: PromptRecord[];
      if (hit?.prompts) {
        parsed = hit.prompts;
      } else {
        const jsonl = await readFile(file.path, "utf8");
        parsed = promptExtractors[file.source](jsonl, {
          filePath: file.path,
        });
        cache.set(file.path, file.mtimeMs, file.size, { prompts: parsed });
      }
      prompts.push(
        ...parsed.filter((prompt) =>
          dateInRange(prompt.day, options.since, options.until),
        ),
      );
    } catch (error) {
      errors.push({
        filePath: file.path,
        message: error instanceof Error ? error.message : "Unknown read error",
      });
    }
  }
  await cache.flush();

  if (options.resolveGitOwners !== false) {
    await enrichWithGitOwners(prompts);
  }
  return {
    prompts: dedupePrompts(prompts),
    scannedFiles: files.length,
    errors,
  };
}

type CandidateFile = UsageFile;

// The collected stats serve two purposes:
//   1. mtime skipping — a log can't contain events newer than its own mtime,
//      so files last written before a `since` range contribute nothing and
//      are dropped without being read (identical results; the one-hour buffer
//      only ever keeps extra files).
//   2. event-cache validation — shards are keyed by path + mtime + size.
function collectCandidates(
  files: UsageFile[],
  since?: string,
): CandidateFile[] {
  const parsedSince = since ? Date.parse(`${since}T00:00:00Z`) : Number.NaN;
  const threshold = Number.isNaN(parsedSince)
    ? Number.NEGATIVE_INFINITY
    : parsedSince - 3_600_000;
  return files.filter((file) => file.mtimeMs >= threshold);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

// Map every scanned session file to the project(s) it belongs to. Used by the
// destructive "clean" action to find exactly which files to move to the Trash.
export interface FileProject {
  filePath: string;
  source: UsageSource;
  cwd?: string;
  clientIds: string[];
}

// Building the file -> clientIds map parses every log file, which is slow on a
// large history. The clean preview and the clean itself both need it seconds
// apart, and the map only changes when config or logs change, so cache it for a
// short window keyed by the exact inputs. The summary route warms this cache so
// the first "Clean" click is usually instant. TTL is intentionally short so new
// sessions show up quickly.
const FILE_PROJECT_TTL_MS = 120_000;
let fileProjectCache:
  | { key: string; at: number; data: FileProject[] }
  | undefined;

function fileProjectCacheKey(
  options: ScanOptions,
  rules: ClientRule[],
  config?: ProjectConfig,
): string {
  return JSON.stringify({
    sources: options.sources ?? null,
    maxFiles: options.maxFiles ?? null,
    resolveGitOwners: options.resolveGitOwners ?? true,
    rules,
    overrides: config?.overrides ?? null,
    autoMatch: config?.autoMatch ?? null,
  });
}

// Drop the cache after a config change so hide/rename/auto-match flow through
// the next clean immediately instead of waiting out the TTL.
export function invalidateFileProjectCache(): void {
  fileProjectCache = undefined;
}

export async function scanFileProjects(
  options: ScanOptions,
  rules: ClientRule[],
  config?: ProjectConfig,
): Promise<FileProject[]> {
  const key = fileProjectCacheKey(options, rules, config);
  // The destructive clean passes fresh:true so the file -> project map is
  // rebuilt at delete time. The cache is safe for the preview, but a stale map
  // could let a session that gained a second project mid-window be treated as
  // single-project and trashed with the other project's data inside.
  if (
    !options.fresh &&
    fileProjectCache &&
    fileProjectCache.key === key &&
    Date.now() - fileProjectCache.at < FILE_PROJECT_TTL_MS
  ) {
    return fileProjectCache.data;
  }
  const sources = options.sources?.length ? options.sources : DEFAULT_SOURCES;
  const home = options.homeDir ?? homedir();
  const files = await collectUsageFiles(
    home,
    sources,
    options.maxFiles ?? DEFAULT_MAX_FILES,
  );
  const result: FileProject[] = [];
  for (const file of files) {
    try {
      const jsonl = await readFile(file.path, "utf8");
      const events = usageNormalizers[file.source](jsonl, {
        filePath: file.path,
      });
      if (options.resolveGitOwners !== false) {
        await enrichWithGitOwners(events);
      }
      const clientIds = new Set<string>();
      let cwd: string | undefined;
      for (const event of events) {
        cwd = cwd ?? event.cwd;
        clientIds.add(resolveAttribution(event, rules, config).clientId);
      }
      result.push({
        filePath: file.path,
        source: file.source,
        cwd,
        clientIds: [...clientIds],
      });
    } catch {
      // A file we can't read simply isn't attributable; skip it.
    }
  }
  fileProjectCache = { key, at: Date.now(), data: result };
  return result;
}

interface GitOwner {
  owner?: string;
  repoName?: string;
}

// cwd -> git owner is stable for a process lifetime, so cache aggressively; the
// first scan pays the git cost, later refreshes are free.
const ownerCache = new Map<string, GitOwner>();

async function enrichWithGitOwners(
  items: Array<Pick<UsageEvent, "cwd" | "repoOwner" | "repoName">>,
): Promise<void> {
  const distinct = [
    ...new Set(
      items.map((item) => item.cwd).filter((cwd): cwd is string => !!cwd),
    ),
  ];
  const concurrency = 16;
  for (let i = 0; i < distinct.length; i += concurrency) {
    await Promise.all(distinct.slice(i, i + concurrency).map(resolveGitOwner));
  }
  for (const item of items) {
    if (!item.cwd) {
      continue;
    }
    const owner = ownerCache.get(item.cwd);
    if (owner?.owner) {
      item.repoOwner = owner.owner;
      item.repoName = owner.repoName;
    }
  }
}

async function resolveGitOwner(cwd: string): Promise<GitOwner> {
  const cached = ownerCache.get(cwd);
  if (cached) {
    return cached;
  }
  let result: GitOwner = {};
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "remote", "get-url", "origin"],
      { timeout: 3_000 },
    );
    result = parseRemoteUrl(stdout.trim());
  } catch {
    // Not a git repo, no origin remote, or the directory no longer exists.
    result = {};
  }
  ownerCache.set(cwd, result);
  return result;
}

// Parse owner/repo from the common git remote URL shapes:
//   git@github.com:owner/repo.git
//   https://github.com/owner/repo(.git)
//   ssh://git@host/owner/repo.git
export function parseRemoteUrl(url: string): GitOwner {
  if (!url) {
    return {};
  }
  const cleaned = url.trim().replace(/\.git$/iu, "");
  const match = cleaned.match(/[:/]([^/:]+)\/([^/]+)$/u);
  if (!match?.[1] || !match[2]) {
    return {};
  }
  return { owner: match[1], repoName: match[2] };
}

interface UsageFile {
  source: UsageSource;
  path: string;
  mtimeMs: number;
  size: number;
}

// Files are collected with their stat in one pass and capped to the newest
// `maxFiles` BY MTIME. (This used to sort by path descending as a proxy for
// recency — but that's an alphabetical sort, and on a machine whose total
// logs exceed maxFiles it let entire sources lose the alphabet and silently
// drop out of every scan: codex/kimi paths beat claude paths, so Claude
// vanished completely.)
async function collectUsageFiles(
  home: string,
  sources: UsageSource[],
  maxFiles: number,
): Promise<UsageFile[]> {
  const groups = await Promise.all(
    sources.map(async (source) => {
      const patterns = sourcePatterns[source](home);
      const entries = await fg(patterns, {
        absolute: true,
        dot: true,
        onlyFiles: true,
        suppressErrors: true,
        unique: true,
        stats: true,
      });
      return entries.map((entry) => ({
        source,
        path: entry.path,
        mtimeMs: entry.stats?.mtimeMs ?? 0,
        size: entry.stats?.size ?? 0,
      }));
    }),
  );
  return groups
    .flat()
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles);
}

function claudePatterns(home: string): string[] {
  return [
    join(home, ".claude/projects/**/*.jsonl"),
    join(home, ".config/claude/projects/**/*.jsonl"),
    // Side-by-side Claude Code profiles (CLAUDE_CONFIG_DIR variants such as
    // ~/.claude-azl, ~/.claude-izl). Each becomes its own `account`.
    join(home, ".claude-*/projects/**/*.jsonl"),
  ];
}

// The account a Claude log file belongs to, from its config directory:
// ~/.claude-azl/projects/... → "azl", ~/.claude/projects/... → "default",
// ~/.config/claude/... → "default".
export function claudeAccountFor(filePath: string, home: string): string {
  const relative = filePath.startsWith(home)
    ? filePath.slice(home.length).replace(/^\//, "")
    : filePath;
  const match = relative.match(/^\.claude-([^/]+)\//);
  return match?.[1] ?? "default";
}

function codexPatterns(home: string): string[] {
  return [join(home, ".codex/sessions/**/*.jsonl")];
}

function kimiPatterns(home: string): string[] {
  return [join(home, ".kimi-code/sessions/**/*.jsonl")];
}

function grokPatterns(home: string): string[] {
  return [join(home, ".grok/sessions/*/*/updates.jsonl")];
}

const sourcePatterns: Record<UsageSource, (home: string) => string[]> = {
  claude: claudePatterns,
  codex: codexPatterns,
  kimi: kimiPatterns,
  grok: grokPatterns,
};

function dateInRange(day: string, since?: string, until?: string): boolean {
  return (!since || day >= since) && (!until || day <= until);
}

function dedupeEvents(events: UsageEvent[]): UsageEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = [
      event.source,
      event.sessionId,
      event.timestamp,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.cacheReadTokens,
      event.totalTokens,
    ].join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupePrompts(prompts: PromptRecord[]): PromptRecord[] {
  const seen = new Set<string>();
  return prompts.filter((prompt) => {
    const key = [
      prompt.source,
      prompt.sessionId,
      prompt.timestamp,
      prompt.contentLength,
      prompt.preview,
    ].join(":");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
