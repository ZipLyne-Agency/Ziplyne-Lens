import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanLocalPrompts, scanLocalUsage } from "../src/index.js";

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

describe("event cache", () => {
  let home: string;
  let logPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "zl-ecache-"));
    const dir = join(home, ".claude/projects/demo");
    await mkdir(dir, { recursive: true });
    logPath = join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reuses the shard when mtime+size are unchanged, reparses on change", async () => {
    await writeFile(
      logPath,
      claudeTurn("/work/a", "first", "2026-07-15T09:00:00.000Z"),
    );

    const first = await scanLocalUsage({
      homeDir: home,
      resolveGitOwners: false,
    });
    expect(first.events).toHaveLength(1);

    // The shard was written under the scanned home's cache dir.
    const shards = await readdir(join(home, ".ziplyne-lens/event-cache"));
    expect(shards).toHaveLength(1);

    // Rewrite DIFFERENT content padded to the exact same length and restore
    // the old mtime: identity (path+mtime+size) is unchanged, so the scan
    // must serve the cached ("first") parse, not the file's current content.
    const original = claudeTurn("/work/a", "first", "2026-07-15T09:00:00.000Z");
    const replacement = claudeTurn(
      "/work/a",
      "secnd",
      "2026-07-15T09:00:00.000Z",
    );
    expect(replacement).toHaveLength(original.length);
    const info = await import("node:fs/promises").then((fs) =>
      fs.stat(logPath),
    );
    await writeFile(logPath, replacement);
    await utimes(logPath, info.atime, info.mtime);

    const cached = await scanLocalUsage({
      homeDir: home,
      resolveGitOwners: false,
    });
    expect(cached.events.map((event) => event.id)).toEqual(
      first.events.map((event) => event.id),
    );

    // Grow the file: identity changes, so the scan reparses and sees both.
    await writeFile(
      logPath,
      replacement + claudeTurn("/work/a", "third", "2026-07-15T10:00:00.000Z"),
    );
    const fresh = await scanLocalUsage({
      homeDir: home,
      resolveGitOwners: false,
    });
    expect(fresh.events).toHaveLength(2);
  });

  it("stores only redacted prompt content while explicit reveals read the source log", async () => {
    const secret = "sk-proj-abcdEFGH1234ijklMNOP5678qrst"; // gitleaks:allow -- synthetic fixture
    await writeFile(
      logPath,
      `${JSON.stringify({
        timestamp: "2026-07-15T09:00:00.000Z",
        sessionId: "s1",
        cwd: "/work/a",
        type: "user",
        message: { role: "user", content: `use ${secret} for the API` },
      })}\n`,
      "utf8",
    );

    await scanLocalPrompts({ homeDir: home, resolveGitOwners: false });
    const cacheDir = join(home, ".ziplyne-lens", "event-cache");
    const [shardName] = await readdir(cacheDir);
    expect(shardName).toBeDefined();
    const cached = await readFile(join(cacheDir, shardName as string), "utf8");
    expect(cached).not.toContain(secret);
    expect(cached).toContain("[redacted key]");

    const revealed = await scanLocalPrompts({
      homeDir: home,
      resolveGitOwners: false,
      includePromptContent: true,
    });
    expect(revealed.prompts[0]?.content).toContain(secret);
  });
});
