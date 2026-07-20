import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invalidateFileProjectCache, scanFileProjects } from "../src/index.js";

// A minimal Claude usage event (assistant turn with token usage) under a given
// cwd. resolveGitOwners is off in these tests, so attribution falls to the
// manual rule (cwd substring) -> clientId.
function claudeTurn(cwd: string, id: string): string {
  return `${JSON.stringify({
    timestamp: "2026-07-08T09:00:00.000Z",
    sessionId: "s1",
    cwd,
    message: {
      id: `msg-${id}`,
      model: "claude-opus-4-8",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    costUSD: 0.5,
  })}\n`;
}

describe("scanFileProjects cache", () => {
  let home: string;
  let logPath: string;
  // Two rules so a single file can resolve to one or two projects by content.
  const rules = [
    { clientId: "alpha", clientName: "Alpha", match: "/work/alpha" },
    { clientId: "beta", clientName: "Beta", match: "/work/beta" },
  ];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "zl-scan-"));
    const dir = join(home, ".claude/projects/demo");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(dir, { recursive: true }),
    );
    logPath = join(dir, "session.jsonl");
    // Initially the file only touches project alpha.
    await writeFile(logPath, claudeTurn("/work/alpha/api", "hello"), "utf8");
    invalidateFileProjectCache();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    invalidateFileProjectCache();
  });

  it("serves a cached map for a normal (non-fresh) call", async () => {
    const first = await scanFileProjects(
      { homeDir: home, resolveGitOwners: false },
      rules,
    );
    expect(first[0]?.clientIds).toEqual(["alpha"]);

    // The file gains a second project's events. A cached read must NOT see it.
    await writeFile(
      logPath,
      claudeTurn("/work/alpha/api", "hello") +
        claudeTurn("/work/beta/api", "world"),
      "utf8",
    );
    const cached = await scanFileProjects(
      { homeDir: home, resolveGitOwners: false },
      rules,
    );
    expect(cached[0]?.clientIds).toEqual(["alpha"]);
  });

  it("fresh:true rebuilds the map so a newly co-resident file is seen (clean safety)", async () => {
    await scanFileProjects({ homeDir: home, resolveGitOwners: false }, rules);
    await writeFile(
      logPath,
      claudeTurn("/work/alpha/api", "hello") +
        claudeTurn("/work/beta/api", "world"),
      "utf8",
    );
    // The destructive clean passes fresh:true; it must see BOTH projects now, so
    // the length===1 guard skips this file instead of trashing beta's data.
    const fresh = await scanFileProjects(
      { homeDir: home, resolveGitOwners: false, fresh: true },
      rules,
    );
    expect(fresh[0]?.clientIds.sort()).toEqual(["alpha", "beta"]);
  });
});
