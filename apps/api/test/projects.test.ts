import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScanResult, UsageEvent } from "@ziplyne/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/projects.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/projects.js")>();
  return { ...actual, getProjectsPayload: vi.fn() };
});

import { app } from "../src/app.js";
import type { CommandRunner, LiveSession } from "../src/live.js";
import {
  aggregateUsageByPath,
  buildProjectsPayload,
  getProjectsPayload,
  type ProjectsDeps,
  type ProjectsPayload,
  parseGitRemote,
  scanDiskRepos,
} from "../src/projects.js";

const getProjectsPayloadMock = vi.mocked(getProjectsPayload);

// 2026-07-18T12:00:00Z — the 30d cost window starts 2026-06-18T12:00:00Z.
const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

const scratches: string[] = [];

afterEach(async () => {
  getProjectsPayloadMock.mockReset();
  await Promise.all(
    scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "projects-test-"));
  scratches.push(dir);
  return dir;
}

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

function makeScan(events: UsageEvent[]): ScanResult {
  return { events, scannedFiles: 1, errors: [] };
}

function makeSession(overrides: Partial<LiveSession>): LiveSession {
  return {
    id: "201:ttys000",
    pid: 201,
    tty: "ttys000",
    command: "claude",
    workingDirectory: "/repo/app",
    projectName: "app",
    host: "Terminal",
    cpuPercent: 0,
    processState: "S",
    provider: "Claude",
    state: "Quiet",
    reason: "Sleeping, with no recent activity",
    lastObservedAt: NOW_ISO,
    ...overrides,
  };
}

// Runner that answers git probes from a per-directory fixture table and
// returns "" (the defaultRunner failure value) for everything else.
function gitRunner(
  fixtures: Record<
    string,
    { remote?: string; lastCommit?: string; branch?: string }
  >,
): CommandRunner {
  return async (_executable, args) => {
    const dir = args[1] ?? "";
    const fixture = fixtures[dir];
    if (!fixture) {
      return "";
    }
    const command = args.slice(2).join(" ");
    if (command === "remote get-url origin") {
      return fixture.remote ?? "";
    }
    if (command === "log -1 --format=%cI") {
      return fixture.lastCommit ?? "";
    }
    if (command === "rev-parse --abbrev-ref HEAD") {
      return fixture.branch ?? "";
    }
    return "";
  };
}

function baseDeps(homeDir: string): ProjectsDeps {
  return {
    now: () => NOW,
    homeDir,
    runner: gitRunner({}),
    scanUsage: async () => makeScan([]),
    liveSessions: async () => [],
    // Most tests use fixture paths that never exist; pruning gets its own test.
    pathExists: async () => true,
  };
}

describe("parseGitRemote", () => {
  it("converts scp-style git@ remotes", () => {
    expect(parseGitRemote("git@github.com:ziplyne/ziplyne-lens.git")).toEqual({
      host: "github.com",
      owner: "ziplyne",
      repo: "ziplyne-lens",
      repoUrl: "https://github.com/ziplyne/ziplyne-lens",
    });
    expect(parseGitRemote("git@github.com:ziplyne/ziplyne-lens")).toEqual(
      expect.objectContaining({
        repoUrl: "https://github.com/ziplyne/ziplyne-lens",
      }),
    );
  });

  it("converts ssh:// remotes", () => {
    expect(
      parseGitRemote("ssh://git@github.com/ziplyne/ziplyne-lens.git"),
    ).toEqual({
      host: "github.com",
      owner: "ziplyne",
      repo: "ziplyne-lens",
      repoUrl: "https://github.com/ziplyne/ziplyne-lens",
    });
  });

  it("converts https remotes and strips the .git suffix", () => {
    expect(
      parseGitRemote("https://github.com/ziplyne/ziplyne-lens.git"),
    ).toEqual({
      host: "github.com",
      owner: "ziplyne",
      repo: "ziplyne-lens",
      repoUrl: "https://github.com/ziplyne/ziplyne-lens",
    });
    expect(parseGitRemote("https://github.com/ziplyne/ziplyne-lens")).toEqual(
      expect.objectContaining({
        repoUrl: "https://github.com/ziplyne/ziplyne-lens",
      }),
    );
  });

  it("keeps other hosts, including gitlab subgroups", () => {
    expect(parseGitRemote("git@gitlab.com:group/sub/tool.git")).toEqual({
      host: "gitlab.com",
      owner: "group/sub",
      repo: "tool",
      repoUrl: "https://gitlab.com/group/sub/tool",
    });
    expect(parseGitRemote("https://bitbucket.org/team/proj.git")).toEqual({
      host: "bitbucket.org",
      owner: "team",
      repo: "proj",
      repoUrl: "https://bitbucket.org/team/proj",
    });
    expect(parseGitRemote("ssh://git@bitbucket.org/team/proj.git")).toEqual(
      expect.objectContaining({ repoUrl: "https://bitbucket.org/team/proj" }),
    );
  });

  it("returns null for remotes without an owner/repo", () => {
    expect(parseGitRemote("")).toBeNull();
    expect(parseGitRemote("   ")).toBeNull();
    expect(parseGitRemote("origin")).toBeNull();
    expect(parseGitRemote("/local/path/repo")).toBeNull();
    expect(parseGitRemote("../relative/repo")).toBeNull();
    expect(parseGitRemote("https://github.com/onlyowner")).toBeNull();
  });
});

describe("aggregateUsageByPath", () => {
  it("dedupes by path, keeps the max timestamp and sums the 30d window", () => {
    const projects = aggregateUsageByPath(
      [
        makeEvent({
          id: "old",
          cwd: "/repo/app",
          timestamp: "2026-06-01T00:00:00.000Z", // outside the 30d window
          costUsd: 9,
        }),
        makeEvent({
          id: "recent",
          cwd: "/repo/app/",
          timestamp: "2026-07-17T08:00:00.000Z",
          costUsd: 1.25,
          repoOwner: "Ziplyne",
          repoName: "app",
        }),
        makeEvent({
          id: "other",
          cwd: "/repo/other",
          timestamp: "2026-07-10T08:00:00.000Z",
          costUsd: 2,
        }),
        makeEvent({ id: "no-cwd", cwd: undefined }),
      ],
      NOW,
    );

    expect(projects.size).toBe(2);
    const app = projects.get("/repo/app");
    expect(app).toMatchObject({
      lastActiveAtMs: Date.parse("2026-07-17T08:00:00.000Z"),
      costUsd30d: 1.25, // the June event counts for recency, not for cost
      repoOwner: "Ziplyne",
      repoName: "app",
    });
    expect(projects.get("/repo/other")?.costUsd30d).toBe(2);
  });
});

describe("scanDiskRepos", () => {
  it("discovers repos at depth-1 and depth-2 under containers only", async () => {
    const home = await scratch();
    const repoA = join(home, "Developer", "repoA");
    const repoB = join(home, "repoB");
    const hidden = join(home, ".hidden", "repoC");
    const library = join(home, "Library", "repoD");
    const modules = join(home, "node_modules", "repoE");
    const nestedModules = join(home, "Developer", "node_modules", "repoF");
    const nonContainer = join(home, "Downloads", "repoG");
    const notARepo = join(home, "Developer", "plain");
    for (const dir of [
      repoA,
      repoB,
      hidden,
      library,
      modules,
      nestedModules,
      nonContainer,
    ]) {
      await mkdir(join(dir, ".git"), { recursive: true });
    }
    await mkdir(notARepo, { recursive: true });

    const repos = await scanDiskRepos(
      home,
      gitRunner({
        [repoA]: {
          remote: "git@github.com:ziplyne/repoA.git",
          lastCommit: "2026-07-15T09:30:00.000Z",
          branch: "main",
        },
        [repoB]: { lastCommit: "2026-07-01T00:00:00.000Z" },
      }),
    );

    const byPath = new Map(repos.map((repo) => [repo.path, repo]));
    expect([...byPath.keys()].sort()).toEqual([repoA, repoB].sort());
    expect(byPath.get(repoA)).toMatchObject({
      branch: "main",
      lastCommitMs: Date.parse("2026-07-15T09:30:00.000Z"),
      remote: {
        host: "github.com",
        owner: "ziplyne",
        repo: "repoA",
        repoUrl: "https://github.com/ziplyne/repoA",
      },
    });
    // A repo without an origin still shows up, with no remote info.
    expect(byPath.get(repoB)).toMatchObject({
      remote: null,
      lastCommitMs: Date.parse("2026-07-01T00:00:00.000Z"),
    });
    expect(byPath.get(repoB)?.branch).toBeUndefined();
  });

  it("tolerates missing containers and empty repos", async () => {
    const home = await scratch();
    const empty = join(home, "Developer", "empty");
    await mkdir(join(empty, ".git"), { recursive: true });

    const repos = await scanDiskRepos(home, gitRunner({}));

    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ path: empty, remote: null });
    expect(repos[0]?.lastCommitMs).toBeUndefined();
  });
});

describe("buildProjectsPayload", () => {
  it("unions usage, live and disk projects, deduped by path", async () => {
    const home = await scratch();
    const diskRepo = join(home, "Developer", "baba");
    await mkdir(join(diskRepo, ".git"), { recursive: true });

    const payload = await buildProjectsPayload({
      ...baseDeps(home),
      runner: gitRunner({
        [diskRepo]: {
          remote: "https://github.com/ziplyne/baba-v2.git",
          lastCommit: "2026-07-12T10:00:00.000Z",
          branch: "main",
        },
      }),
      scanUsage: async () =>
        makeScan([
          makeEvent({
            id: "u1",
            cwd: diskRepo,
            timestamp: "2026-07-16T08:00:00.000Z",
            costUsd: 3,
          }),
          makeEvent({
            id: "u2",
            cwd: "/elsewhere/usage-only",
            timestamp: "2026-07-05T08:00:00.000Z",
            costUsd: 1,
            repoOwner: "Ziplyne",
            repoName: "usage-only",
          }),
        ]),
      liveSessions: async () => [
        makeSession({ workingDirectory: "/elsewhere/live-only" }),
      ],
    });

    expect(payload.generatedAt).toBe(NOW_ISO);
    const byPath = new Map(payload.projects.map((p) => [p.path, p]));

    // usage + disk merge into one entry: id from the remote, recency from
    // the newer usage event, cost from usage, branch from git.
    const merged = byPath.get(diskRepo);
    expect(merged).toMatchObject({
      id: "ziplyne/baba-v2",
      name: "baba-v2",
      repoUrl: "https://github.com/ziplyne/baba-v2",
      repoOwner: "ziplyne",
      repoName: "baba-v2",
      gitBranch: "main",
      lastActiveAt: "2026-07-16T08:00:00.000Z",
      live: false,
      hasUsage: true,
      costUsd30d: 3,
    });

    const usageOnly = byPath.get("/elsewhere/usage-only");
    expect(usageOnly).toMatchObject({
      id: "ziplyne/usage-only",
      live: false,
      hasUsage: true,
      costUsd30d: 1,
      lastActiveAt: "2026-07-05T08:00:00.000Z",
    });

    const liveOnly = byPath.get("/elsewhere/live-only");
    expect(liveOnly).toMatchObject({
      id: "/elsewhere/live-only",
      name: "live-only",
      live: true,
      hasUsage: false,
      lastActiveAt: NOW_ISO,
    });
    expect(liveOnly?.costUsd30d).toBeUndefined();
  });

  it("picks the max of usage, live and commit for lastActiveAt", async () => {
    const home = await scratch();
    const repo = join(home, "alpha");
    await mkdir(join(repo, ".git"), { recursive: true });

    // Commit is newer than the usage event -> commit wins.
    const payload = await buildProjectsPayload({
      ...baseDeps(home),
      runner: gitRunner({
        [repo]: { lastCommit: "2026-07-17T23:00:00.000Z" },
      }),
      scanUsage: async () =>
        makeScan([
          makeEvent({
            cwd: repo,
            timestamp: "2026-07-10T00:00:00.000Z",
          }),
        ]),
    });
    expect(payload.projects[0]?.lastActiveAt).toBe("2026-07-17T23:00:00.000Z");

    // A live session is newer than the commit -> now wins.
    const livePayload = await buildProjectsPayload({
      ...baseDeps(home),
      runner: gitRunner({
        [repo]: { lastCommit: "2026-07-17T23:00:00.000Z" },
      }),
      scanUsage: async () => makeScan([]),
      liveSessions: async () => [makeSession({ workingDirectory: repo })],
    });
    expect(livePayload.projects[0]?.lastActiveAt).toBe(NOW_ISO);
  });

  it("sorts by lastActiveAt descending", async () => {
    const home = await scratch();
    const payload = await buildProjectsPayload({
      ...baseDeps(home),
      scanUsage: async () =>
        makeScan([
          makeEvent({
            id: "1",
            cwd: "/repo/old",
            timestamp: "2026-06-20T00:00:00.000Z",
          }),
          makeEvent({
            id: "2",
            cwd: "/repo/new",
            timestamp: "2026-07-18T00:00:00.000Z",
          }),
          makeEvent({
            id: "3",
            cwd: "/repo/mid",
            timestamp: "2026-07-01T00:00:00.000Z",
          }),
        ]),
    });

    expect(payload.projects.map((p) => p.path)).toEqual([
      "/repo/new",
      "/repo/mid",
      "/repo/old",
    ]);
  });

  it("prunes usage-only projects whose directory no longer exists", async () => {
    const home = await scratch();
    const kept = join(home, "kept");
    await mkdir(kept, { recursive: true });

    const payload = await buildProjectsPayload({
      ...baseDeps(home),
      scanUsage: async () =>
        makeScan([
          makeEvent({
            id: "1",
            cwd: kept,
            timestamp: "2026-07-18T00:00:00.000Z",
          }),
          makeEvent({
            id: "2",
            cwd: join(home, "deleted-long-ago"),
            timestamp: "2026-07-17T00:00:00.000Z",
            costUsd: 5,
          }),
        ]),
      pathExists: async (path) => path === kept,
    });

    expect(payload.projects.map((p) => p.path)).toEqual([kept]);
  });

  it("lowercases the owner in the id but keeps the repo casing", async () => {
    const home = await scratch();
    const repo = join(home, "lens");
    await mkdir(join(repo, ".git"), { recursive: true });

    const payload = await buildProjectsPayload({
      ...baseDeps(home),
      runner: gitRunner({
        [repo]: {
          remote: "git@github.com:Ziplyne/Ziplyne-Lens.git",
          lastCommit: "2026-07-18T00:00:00.000Z",
        },
      }),
    });

    expect(payload.projects[0]).toMatchObject({
      id: "ziplyne/Ziplyne-Lens",
      repoOwner: "Ziplyne",
      repoName: "Ziplyne-Lens",
      repoUrl: "https://github.com/Ziplyne/Ziplyne-Lens",
    });
  });

  it("probes usage paths that live outside the scanned roots", async () => {
    const home = await scratch();
    const outside = join(home, "Downloads", "deep", "outer");
    // Not under a container, so the disk scan never sees it; the directory
    // exists and git knows its remote.
    await mkdir(join(outside, ".git"), { recursive: true });

    const payload = await buildProjectsPayload({
      ...baseDeps(home),
      runner: gitRunner({
        [outside]: {
          remote: "git@github.com:ziplyne/outer.git",
          lastCommit: "2026-07-11T00:00:00.000Z",
          branch: "trunk",
        },
      }),
      scanUsage: async () =>
        makeScan([
          makeEvent({ cwd: outside, timestamp: "2026-07-11T00:00:00.000Z" }),
        ]),
    });

    expect(payload.projects).toHaveLength(1);
    expect(payload.projects[0]).toMatchObject({
      id: "ziplyne/outer",
      repoUrl: "https://github.com/ziplyne/outer",
      gitBranch: "trunk",
    });
  });

  it("returns an empty, well-shaped payload when nothing exists", async () => {
    const home = await scratch();
    const payload = await buildProjectsPayload(baseDeps(home));

    expect(payload).toEqual({ generatedAt: NOW_ISO, projects: [] });
  });

  it("keeps working when a source fails", async () => {
    const home = await scratch();
    const payload = await buildProjectsPayload({
      ...baseDeps(home),
      scanUsage: async () => {
        throw new Error("scan exploded");
      },
      liveSessions: async () => {
        throw new Error("ps exploded");
      },
    });

    expect(payload.generatedAt).toBe(NOW_ISO);
    expect(payload.projects).toEqual([]);
  });
});

describe("GET /api/projects", () => {
  const payloadFixture: ProjectsPayload = {
    generatedAt: NOW_ISO,
    projects: [
      {
        id: "ziplyne/ziplyne-lens",
        name: "ziplyne-lens",
        path: "/repo/ziplyne-lens",
        repoUrl: "https://github.com/ziplyne/ziplyne-lens",
        repoOwner: "ziplyne",
        repoName: "ziplyne-lens",
        gitBranch: "main",
        lastActiveAt: NOW_ISO,
        live: true,
        hasUsage: true,
        costUsd30d: 12.5,
      },
      {
        id: "/repo/plain",
        name: "plain",
        path: "/repo/plain",
        lastActiveAt: "2026-07-01T00:00:00.000Z",
        live: false,
        hasUsage: false,
      },
    ],
  };

  it("returns 200 with the projects payload", async () => {
    getProjectsPayloadMock.mockResolvedValue(payloadFixture);

    const response = await app.request("/api/projects");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(payloadFixture);
    expect(getProjectsPayloadMock).toHaveBeenCalledWith();
  });
});
