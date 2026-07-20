import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanLocalUsage } from "../src/index.js";

function claudeTurn(cwd: string, id: string, timestamp: string): string {
  return `${JSON.stringify({
    timestamp,
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

describe("scan mtime skipping", () => {
  let home: string;
  let dir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "zl-mtime-"));
    dir = join(home, ".claude/projects/demo");
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("skips files whose mtime predates the since range (identical results)", async () => {
    const oldPath = join(dir, "old.jsonl");
    const newPath = join(dir, "new.jsonl");
    await writeFile(
      oldPath,
      claudeTurn("/work/a", "old", "2026-06-01T09:00:00.000Z"),
    );
    await writeFile(
      newPath,
      claudeTurn("/work/a", "new", "2026-07-15T09:00:00.000Z"),
    );
    // Backdate old.jsonl's mtime to match its contents.
    const june = new Date("2026-06-01T12:00:00.000Z");
    await utimes(oldPath, june, june);

    const ranged = await scanLocalUsage({
      homeDir: home,
      since: "2026-07-01",
      resolveGitOwners: false,
    });
    expect(ranged.events.map((event) => event.id)).toEqual([
      expect.stringContaining("new"),
    ]);

    // No `since` -> both files are read regardless of mtime.
    const all = await scanLocalUsage({
      homeDir: home,
      resolveGitOwners: false,
    });
    expect(all.events).toHaveLength(2);
  });

  it("takes the mtime at face value even when content claims otherwise", async () => {
    // Pathological case the skip rule documents: a file with a stale mtime but
    // an in-range timestamp inside (cannot happen on a normally-written log —
    // mtime is always >= the newest event). It is skipped, because mtime is
    // the only cheap signal available.
    const path = join(dir, "weird.jsonl");
    await writeFile(
      path,
      claudeTurn("/work/a", "x", "2026-07-15T09:00:00.000Z"),
    );
    const june = new Date("2026-06-01T12:00:00.000Z");
    await utimes(path, june, june);

    const ranged = await scanLocalUsage({
      homeDir: home,
      since: "2026-07-01",
      resolveGitOwners: false,
    });
    expect(ranged.events).toHaveLength(0);
  });
});
