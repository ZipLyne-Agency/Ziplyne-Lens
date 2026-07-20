import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aggregateUsage,
  claudeAccountFor,
  scanLocalUsage,
} from "../src/index.js";

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

describe("multi-account Claude scanning", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "zl-accounts-"));
    await mkdir(join(home, ".claude/projects/work"), { recursive: true });
    await mkdir(join(home, ".claude-azl/projects/work"), { recursive: true });
    await mkdir(join(home, ".claude-izl/projects/work"), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("derives the account from the config directory", () => {
    expect(claudeAccountFor(join(home, ".claude/projects/a.jsonl"), home)).toBe(
      "default",
    );
    expect(
      claudeAccountFor(join(home, ".claude-azl/projects/a.jsonl"), home),
    ).toBe("azl");
    expect(
      claudeAccountFor(join(home, ".claude-izl/projects/a.jsonl"), home),
    ).toBe("izl");
    expect(
      claudeAccountFor(join(home, ".config/claude/projects/a.jsonl"), home),
    ).toBe("default");
  });

  it("scans every profile and stamps events with their account", async () => {
    await writeFile(
      join(home, ".claude/projects/work/s.jsonl"),
      claudeTurn("/work/a", "d1", "2026-07-15T09:00:00.000Z"),
    );
    await writeFile(
      join(home, ".claude-azl/projects/work/s.jsonl"),
      claudeTurn("/work/a", "a1", "2026-07-15T10:00:00.000Z") +
        claudeTurn("/work/a", "a2", "2026-07-15T11:00:00.000Z"),
    );
    await writeFile(
      join(home, ".claude-izl/projects/work/s.jsonl"),
      claudeTurn("/work/a", "i1", "2026-07-15T12:00:00.000Z"),
    );

    const scan = await scanLocalUsage({
      homeDir: home,
      resolveGitOwners: false,
    });
    const byAccount = new Map<string, number>();
    for (const event of scan.events) {
      expect(event.source).toBe("claude");
      byAccount.set(
        event.account ?? "none",
        (byAccount.get(event.account ?? "none") ?? 0) + 1,
      );
    }
    expect(byAccount).toEqual(
      new Map([
        ["default", 1],
        ["azl", 2],
        ["izl", 1],
      ]),
    );

    const summary = aggregateUsage(scan.events, []);
    expect(
      summary.accounts
        .map((row) => [row.account, row.eventCount, row.costUsd])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["azl", 2, 1],
      ["default", 1, 0.5],
      ["izl", 1, 0.5],
    ]);
    // Source rollups still work: one "claude" row across all accounts.
    expect(summary.sources.map((row) => row.source)).toEqual(["claude"]);
    expect(summary.sources[0]?.eventCount).toBe(4);
  });
});
