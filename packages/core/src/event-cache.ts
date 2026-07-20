// Per-file parse cache for local agent logs.
//
// Session logs are append-mostly: a file that hasn't changed (same mtime and
// size) yields the same events and prompts on every scan. On a dense history
// a full scan re-reads and re-parses gigabytes of JSONL on every cache miss,
// which is the dominant cost in the whole app. This cache stores the parsed
// result per log file, keyed by content identity (path + mtime + size), so a
// rescan only parses files that actually changed and reads the rest back as
// small JSON shards — roughly an order of magnitude less work.
//
// Layout: <home>/.ziplyne-lens/event-cache/<sha1(path)>.json
// Each shard carries whatever kinds have been parsed so far (events and/or
// prompts); a scan fills only the kind it needs. Entries are self-validating
// (mtime + size must match the current stat) and versioned; any
// inconsistency is a plain cache miss, never an error.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactPromptText } from "./prompts.js";
import type { PromptRecord, UsageEvent } from "./types.js";

// Bump when parser or redaction output changes: shards store parsed events
// and (redacted) prompt previews, so stale entries must invalidate.
// v2: redactPromptText gained the all-caps key-shape rule.
// v3: Claude events carry `account` (multi-profile ~/.claude-* scanning).
const CACHE_VERSION = 4;

// Filesystem mtime is not an exact value: it loses sub-millisecond precision
// through Date round-trips, utimes restores, and coarse filesystems (FAT
// stores 2s granularity). Identity therefore requires an exact size match and
// an mtime within this tolerance. Agent logs are append-only — same size and
// a near-identical mtime is, for all practical purposes, the same content.
const MTIME_TOLERANCE_MS = 2_000;

function mtimeMatches(a: number, b: number): boolean {
  return Math.abs(a - b) <= MTIME_TOLERANCE_MS;
}

export interface CacheShard {
  v: number;
  path: string;
  mtimeMs: number;
  size: number;
  events?: UsageEvent[];
  prompts?: PromptRecord[];
}

export class EventCache {
  private readonly dir: string;
  private readonly writes: Promise<void>[] = [];

  constructor(home: string) {
    this.dir = join(home, ".ziplyne-lens", "event-cache");
  }

  async get(
    path: string,
    mtimeMs: number,
    size: number,
  ): Promise<CacheShard | undefined> {
    try {
      const raw = await readFile(this.shardPath(path), "utf8");
      const shard = JSON.parse(raw) as CacheShard;
      if (
        shard.v !== CACHE_VERSION ||
        shard.path !== path ||
        !mtimeMatches(shard.mtimeMs, mtimeMs) ||
        shard.size !== size
      ) {
        return undefined;
      }
      return shard;
    } catch {
      return undefined;
    }
  }

  // Merge-write a shard (preserves kinds parsed by other scans), fired in the
  // background; call flush() at the end of the scan so shards land promptly.
  // Failures are ignored by design — the cache is an optimization, never a
  // correctness dependency.
  set(
    path: string,
    mtimeMs: number,
    size: number,
    part: Partial<CacheShard>,
  ): void {
    this.writes.push(
      (async () => {
        try {
          await mkdir(this.dir, { recursive: true });
          const target = this.shardPath(path);
          let existing: CacheShard | undefined;
          try {
            existing = JSON.parse(await readFile(target, "utf8")) as CacheShard;
          } catch {
            existing = undefined;
          }
          const base =
            existing &&
            existing.v === CACHE_VERSION &&
            mtimeMatches(existing.mtimeMs, mtimeMs) &&
            existing.size === size
              ? existing
              : undefined;
          const shard: CacheShard = {
            ...base,
            v: CACHE_VERSION,
            path,
            mtimeMs,
            size,
            ...part,
            ...(part.prompts
              ? {
                  prompts: part.prompts.map((prompt) => ({
                    ...prompt,
                    content: prompt.content
                      ? redactPromptText(prompt.content)
                      : undefined,
                  })),
                }
              : {}),
          };
          const tmp = `${target}.${process.pid}.tmp`;
          await writeFile(tmp, JSON.stringify(shard), "utf8");
          await rename(tmp, target);
        } catch {
          // Best-effort only.
        }
      })(),
    );
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.writes);
    this.writes.length = 0;
  }

  private shardPath(path: string): string {
    const key = createHash("sha1").update(path).digest("hex");
    return join(this.dir, `${key}.json`);
  }
}
