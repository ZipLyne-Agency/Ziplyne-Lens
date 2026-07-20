// Project registry — every project this Mac knows about, in one place.
//
// Sources, unioned:
//   1. Usage-derived projects from the agent logs (with 30d cost)
//   2. Live session working directories (marked live)
//   3. Git repositories discovered on disk (home dir, shallow scan)
//
// Each project carries its GitHub URL (from the git remote) and a
// lastActiveAt timestamp so the UI can answer "what did I work on last?"
// and offer one-click open in Zed / on GitHub.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type ScanOptions,
  type ScanResult,
  scanLocalUsage,
  type UsageEvent,
} from "@ziplyne/core";
import {
  type CommandRunner,
  defaultRunner,
  type LiveSession,
  scanLiveSessions,
} from "./live.js";
import { createScanCache } from "./scan-cache.js";

export interface ProjectEntry {
  id: string; // stable key (owner/repo or path-derived)
  name: string;
  path: string;
  repoUrl?: string; // https github/gitlab URL derived from git remote
  repoOwner?: string;
  repoName?: string;
  gitBranch?: string;
  lastActiveAt: string; // ISO — max(usage, live, on-disk activity)
  live: boolean; // a live session is open here right now
  hasUsage: boolean; // has agent usage in the logs
  costUsd30d?: number;
}

export interface ProjectsPayload {
  generatedAt: string;
  projects: ProjectEntry[];
}

// Everything that touches the outside world is injectable so tests stay
// hermetic: clock, home dir, git shell-out, the usage scan and the live
// session probe. Injecting a dep also bypasses that source's TTL cache.
export interface ProjectsDeps {
  now?: () => number;
  homeDir?: string;
  runner?: CommandRunner;
  scanUsage?: (options: ScanOptions) => Promise<ScanResult>;
  liveSessions?: () => Promise<LiveSession[]>;
  pathExists?: (path: string) => Promise<boolean>;
}

const USAGE_CACHE_TTL_MS = 300_000;
const DISK_CACHE_TTL_MS = 300_000;
const GIT_TIMEOUT_MS = 2_000;
const GIT_CONCURRENCY = 8;
const COST_WINDOW_DAYS = 30;

// Depth-2 containers under $HOME; only scanned when they exist.
const CONTAINER_DIRS = [
  "Developer",
  "Projects",
  "dev",
  "code",
  "repos",
  "work",
  "src",
  "Desktop",
  "Documents",
];
const SKIP_DIR_NAMES = new Set(["Library", "node_modules"]);

export interface ParsedGitRemote {
  host: string;
  owner: string;
  repo: string;
  repoUrl: string;
}

// Converts a git remote into an https URL and owner/repo parts:
//   git@github.com:owner/repo.git       -> https://github.com/owner/repo
//   ssh://git@github.com/owner/repo.git -> https://github.com/owner/repo
//   https://github.com/owner/repo(.git) -> https://github.com/owner/repo
// Other hosts (gitlab, bitbucket, ...) are kept as-is. Returns null for
// remotes that don't carry an owner/repo (local paths, bare hostnames).
export function parseGitRemote(raw: string): ParsedGitRemote | null {
  const url = raw.trim();
  if (!url) {
    return null;
  }
  let host: string;
  let pathPart: string;
  if (url.includes("://")) {
    try {
      const parsed = new URL(url);
      host = parsed.host;
      pathPart = parsed.pathname.replace(/^\/+/u, "");
    } catch {
      return null;
    }
  } else {
    // scp-style: [user@]host:owner/repo(.git)
    const scpLike = url.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/u);
    if (!scpLike?.[1] || !scpLike[2]) {
      return null;
    }
    host = scpLike[1];
    pathPart = scpLike[2];
  }
  const segments = pathPart
    .replace(/\.git$/iu, "")
    .split("/")
    .filter(Boolean);
  if (!host || segments.length < 2) {
    return null;
  }
  const repo = segments[segments.length - 1] as string;
  const owner = segments.slice(0, -1).join("/");
  return { host, owner, repo, repoUrl: `https://${host}/${owner}/${repo}` };
}

export interface DiskRepo {
  path: string;
  remote: ParsedGitRemote | null;
  branch?: string;
  lastCommitMs?: number;
}

// Probes one repo dir with git. Every call tolerates failure (the runner
// collapses errors to ""), so a repo with no origin, an empty repo with no
// commits, or a vanished directory simply yields fewer fields.
async function inspectGitRepo(
  dir: string,
  runner: CommandRunner,
): Promise<DiskRepo> {
  const [remoteRaw, lastCommitRaw, branchRaw] = await Promise.all([
    runner(
      "/usr/bin/git",
      ["-C", dir, "remote", "get-url", "origin"],
      GIT_TIMEOUT_MS,
    ),
    runner(
      "/usr/bin/git",
      ["-C", dir, "log", "-1", "--format=%cI"],
      GIT_TIMEOUT_MS,
    ),
    runner(
      "/usr/bin/git",
      ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"],
      GIT_TIMEOUT_MS,
    ),
  ]);
  const remote = parseGitRemote(remoteRaw);
  const branch = branchRaw.trim();
  const lastCommitMs = Date.parse(lastCommitRaw.trim());
  return {
    path: dir,
    remote,
    ...(branch ? { branch } : {}),
    ...(Number.isNaN(lastCommitMs) ? {} : { lastCommitMs }),
  };
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !SKIP_DIR_NAMES.has(entry.name),
      )
      .map((entry) => join(dir, entry.name));
  } catch {
    // Missing or unreadable directory contributes no candidates.
    return [];
  }
}

// Depth-1 entries of $HOME plus depth-2 under the known containers.
async function candidateDirs(homeDir: string): Promise<string[]> {
  const candidates = new Set<string>(await listSubdirs(homeDir));
  for (const name of CONTAINER_DIRS) {
    for (const sub of await listSubdirs(join(homeDir, name))) {
      candidates.add(sub);
    }
  }
  return [...candidates];
}

async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    // .git may be a directory or a file (worktrees/submodules); stat covers both.
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function mapLimit<TItem, TResult>(
  items: TItem[],
  limit: number,
  fn: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(items.length);
  let index = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        results[current] = await fn(items[current] as TItem);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// Shallow on-disk scan: repos under $HOME (depth-1) and the common
// containers (depth-2), each probed for remote, branch and last commit.
export async function scanDiskRepos(
  homeDir: string,
  runner: CommandRunner = defaultRunner,
): Promise<DiskRepo[]> {
  const candidates = await candidateDirs(homeDir);
  const repos = await mapLimit(candidates, GIT_CONCURRENCY, async (dir) =>
    (await hasGitEntry(dir)) ? await inspectGitRepo(dir, runner) : null,
  );
  return repos.filter((repo): repo is DiskRepo => repo !== null);
}

interface UsageProject {
  path: string;
  repoOwner?: string;
  repoName?: string;
  gitBranch?: string;
  lastActiveAtMs: number;
  costUsd30d: number;
}

// Events -> per-path aggregate: latest timestamp, branch from the newest
// event that has one, and cost summed over the trailing 30-day window.
export function aggregateUsageByPath(
  events: UsageEvent[],
  nowMs: number,
): Map<string, UsageProject> {
  const windowStartMs = nowMs - COST_WINDOW_DAYS * 86_400_000;
  const projects = new Map<string, UsageProject>();
  for (const event of events) {
    if (!event.cwd) {
      continue;
    }
    const path = resolve(event.cwd);
    const ts = Date.parse(event.timestamp);
    const validTs = Number.isNaN(ts) ? null : ts;
    let project = projects.get(path);
    if (!project) {
      project = {
        path,
        lastActiveAtMs: Number.NEGATIVE_INFINITY,
        costUsd30d: 0,
      };
      projects.set(path, project);
    }
    if (validTs !== null && validTs > project.lastActiveAtMs) {
      project.lastActiveAtMs = validTs;
      if (event.gitBranch) {
        project.gitBranch = event.gitBranch;
      }
    }
    if (validTs !== null && validTs >= windowStartMs) {
      project.costUsd30d += event.costUsd;
    }
    project.repoOwner ??= event.repoOwner;
    project.repoName ??= event.repoName;
  }
  return projects;
}

// In-module caches (production path only — injected deps bypass them).
let cachedUsageScan: ((args: ScanOptions) => Promise<ScanResult>) | undefined;
let cachedDiskScan:
  | ((args: { homeDir: string; runner: CommandRunner }) => Promise<DiskRepo[]>)
  | undefined;

function usageScan(): (args: ScanOptions) => Promise<ScanResult> {
  cachedUsageScan ??= createScanCache(
    USAGE_CACHE_TTL_MS,
    scanLocalUsage,
    () => "usage-projects",
  );
  return cachedUsageScan;
}

function diskScan(): (args: {
  homeDir: string;
  runner: CommandRunner;
}) => Promise<DiskRepo[]> {
  cachedDiskScan ??= createScanCache(
    DISK_CACHE_TTL_MS,
    (args: { homeDir: string; runner: CommandRunner }) =>
      scanDiskRepos(args.homeDir, args.runner),
    (args) => args.homeDir,
  );
  return cachedDiskScan;
}

interface ProjectAccumulator {
  path: string;
  repoOwner?: string;
  repoName?: string;
  repoUrl?: string;
  gitBranch?: string;
  lastActiveAtMs: number;
  live: boolean;
  hasUsage: boolean;
  costUsd30d?: number;
}

export async function buildProjectsPayload(
  deps: ProjectsDeps = {},
): Promise<ProjectsPayload> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const homeDir = deps.homeDir ?? homedir();
  const runner = deps.runner ?? defaultRunner;

  // Event days are UTC, so the scan window uses UTC day boundaries. It spans
  // the full 30-day cost window (the ms-precision aggregation trims the edge).
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const since = new Date(nowMs - COST_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // Each source is independent: a failure in one must never sink the others.
  const [usageResult, liveResult, diskResult] = await Promise.all([
    (deps.scanUsage ?? usageScan())({
      since,
      until: today,
      resolveGitOwners: true,
    }).catch(() => null),
    (deps.liveSessions ?? scanLiveSessions)().catch(() => [] as LiveSession[]),
    (deps.runner || deps.homeDir
      ? scanDiskRepos(homeDir, runner)
      : diskScan()({ homeDir, runner })
    ).catch(() => [] as DiskRepo[]),
  ]);

  const byPath = new Map<string, ProjectAccumulator>();
  const accumulatorFor = (path: string): ProjectAccumulator => {
    let acc = byPath.get(path);
    if (!acc) {
      acc = {
        path,
        lastActiveAtMs: Number.NEGATIVE_INFINITY,
        live: false,
        hasUsage: false,
      };
      byPath.set(path, acc);
    }
    return acc;
  };

  if (usageResult) {
    for (const usage of aggregateUsageByPath(
      usageResult.events,
      nowMs,
    ).values()) {
      const acc = accumulatorFor(usage.path);
      acc.hasUsage = true;
      acc.lastActiveAtMs = Math.max(acc.lastActiveAtMs, usage.lastActiveAtMs);
      acc.repoOwner ??= usage.repoOwner;
      acc.repoName ??= usage.repoName;
      acc.gitBranch ??= usage.gitBranch;
      acc.costUsd30d = (acc.costUsd30d ?? 0) + usage.costUsd30d;
    }
  }

  for (const session of liveResult) {
    if (!session.workingDirectory) {
      continue;
    }
    const acc = accumulatorFor(resolve(session.workingDirectory));
    acc.live = true;
    acc.lastActiveAtMs = Math.max(acc.lastActiveAtMs, nowMs);
  }

  // On-disk repos: the remote is authoritative for owner/name/URL, and the
  // last commit is the activity fallback for projects with no usage or live
  // session.
  const gitByPath = new Map<string, DiskRepo>();
  for (const repo of diskResult) {
    const path = resolve(repo.path);
    gitByPath.set(path, repo);
    const acc = accumulatorFor(path);
    acc.lastActiveAtMs = Math.max(
      acc.lastActiveAtMs,
      repo.lastCommitMs ?? Number.NEGATIVE_INFINITY,
    );
    if (repo.remote) {
      acc.repoOwner = repo.remote.owner;
      acc.repoName = repo.remote.repo;
      acc.repoUrl = repo.remote.repoUrl;
    }
    acc.gitBranch = repo.branch ?? acc.gitBranch;
  }

  // Usage/live paths outside the scanned roots get probed individually so
  // they still gain a repoUrl when the directory exists on disk.
  const extraPaths = [...byPath.keys()].filter((path) => !gitByPath.has(path));
  const extraRepos = await mapLimit(extraPaths, GIT_CONCURRENCY, (path) =>
    inspectGitRepo(path, runner).catch(() => null),
  );
  for (const repo of extraRepos) {
    if (!repo) {
      continue;
    }
    const acc = accumulatorFor(repo.path);
    acc.lastActiveAtMs = Math.max(
      acc.lastActiveAtMs,
      repo.lastCommitMs ?? Number.NEGATIVE_INFINITY,
    );
    if (repo.remote) {
      acc.repoOwner = repo.remote.owner;
      acc.repoName = repo.remote.repo;
      acc.repoUrl = repo.remote.repoUrl;
    }
    acc.gitBranch = repo.branch ?? acc.gitBranch;
  }

  // Ghost pruning: usage logs remember cwds of directories that have since
  // been deleted. A project you can no longer open is noise in a "my
  // projects" list, so usage-only entries whose directory vanished are
  // dropped (their spend still shows in the usage analytics views). Paths
  // proven by the disk scan, the git probe, or a live session are known to
  // exist; the rest get one existence check.
  // Existence is proven by the disk scan (stat'ed .git), a live session cwd,
  // or the explicit check below — never by the git probe, whose empty output
  // can't distinguish "not a repo" from "directory is gone".
  const knownExisting = new Set<string>();
  for (const repo of diskResult) {
    knownExisting.add(resolve(repo.path));
  }
  for (const session of liveResult) {
    if (session.workingDirectory) {
      knownExisting.add(resolve(session.workingDirectory));
    }
  }
  const pathExists =
    deps.pathExists ??
    (async (path: string) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    });
  const unknownPaths = [...byPath.keys()].filter(
    (path) => !knownExisting.has(path),
  );
  const existence = await mapLimit(unknownPaths, GIT_CONCURRENCY, pathExists);
  const dropped = new Set(
    unknownPaths.filter((_, index) => existence[index] !== true),
  );

  const projects: ProjectEntry[] = [];
  for (const acc of byPath.values()) {
    if (dropped.has(acc.path)) {
      continue;
    }
    const repoOwner = acc.repoOwner;
    const repoName = acc.repoName;
    const repoUrl = acc.repoUrl;
    const gitBranch = acc.gitBranch;
    const lastActiveAtMs = acc.lastActiveAtMs;
    projects.push({
      id:
        repoOwner && repoName
          ? `${repoOwner.toLowerCase()}/${repoName}`
          : acc.path,
      name: repoName ?? (basename(acc.path) || acc.path),
      path: acc.path,
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoOwner ? { repoOwner } : {}),
      ...(repoName ? { repoName } : {}),
      ...(gitBranch ? { gitBranch } : {}),
      // A project with no timestamp anywhere still exists right now.
      lastActiveAt: new Date(
        lastActiveAtMs === Number.NEGATIVE_INFINITY ? nowMs : lastActiveAtMs,
      ).toISOString(),
      live: acc.live,
      hasUsage: acc.hasUsage,
      ...(acc.costUsd30d !== undefined
        ? { costUsd30d: round6(acc.costUsd30d) }
        : {}),
    });
  }

  projects.sort(
    (a, b) =>
      Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt) ||
      a.name.localeCompare(b.name),
  );

  return { generatedAt: new Date(nowMs).toISOString(), projects };
}

export async function getProjectsPayload(): Promise<ProjectsPayload> {
  return buildProjectsPayload();
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
