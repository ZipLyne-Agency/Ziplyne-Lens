import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LiveSession } from "../src/live.js";
import {
  dismissEndedSession,
  flushSessionHistory,
  getEndedSessions,
  resetSessionHistory,
  trackLiveSessions,
} from "../src/session-history.js";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const HOUR = 3_600_000;

function makeSession(
  id: string,
  overrides: Partial<LiveSession> = {},
): LiveSession {
  return {
    id,
    pid: 4242,
    tty: "ttys007",
    command: "kimi",
    workingDirectory: "/work/alpha",
    projectName: "alpha",
    host: "Zed",
    cpuPercent: 1.2,
    processState: "R",
    provider: "Kimi",
    state: "Working",
    reason: "Using CPU or actively scheduled",
    lastObservedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe("session history", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zl-history-"));
    file = join(dir, "live-history.json");
    resetSessionHistory();
  });

  afterEach(async () => {
    resetSessionHistory();
    await rm(dir, { recursive: true, force: true });
  });

  it("marks a session ended when it disappears from the scan", async () => {
    await trackLiveSessions([makeSession("1:ttys007")], NOW, file);
    // Still present in the next scan: nothing ended.
    await trackLiveSessions([makeSession("1:ttys007")], NOW + 1000, file);
    expect(await getEndedSessions(NOW + 1000, file)).toHaveLength(0);

    // Gone from the scan: it becomes an ended session.
    await trackLiveSessions([makeSession("2:ttys008")], NOW + 2000, file);
    const ended = await getEndedSessions(NOW + 2000, file);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      id: "1:ttys007",
      projectName: "alpha",
      provider: "Kimi",
      endedAt: new Date(NOW + 2000).toISOString(),
    });
  });

  it("revives a session that reappears", async () => {
    await trackLiveSessions([makeSession("1:ttys007")], NOW, file);
    await trackLiveSessions([], NOW + 1000, file);
    expect(await getEndedSessions(NOW + 1000, file)).toHaveLength(1);
    await trackLiveSessions([makeSession("1:ttys007")], NOW + 2000, file);
    expect(await getEndedSessions(NOW + 2000, file)).toHaveLength(0);
  });

  it("dismisses ended sessions and keeps them dismissed after a reload", async () => {
    await trackLiveSessions(
      [makeSession("1:ttys007"), makeSession("2:ttys008")],
      NOW,
      file,
    );
    await trackLiveSessions([], NOW + 1000, file);
    expect(await getEndedSessions(NOW + 1000, file)).toHaveLength(2);

    expect(await dismissEndedSession("1:ttys007", file)).toBe(true);
    expect(await getEndedSessions(NOW + 1000, file)).toHaveLength(1);
    expect(await dismissEndedSession("nope", file)).toBe(false);

    // A fresh tracker over the same file keeps both the ended sessions and
    // the dismissal.
    await flushSessionHistory();
    resetSessionHistory();
    const reloaded = await getEndedSessions(NOW + 2000, file);
    expect(reloaded.map((session) => session.id)).toEqual(["2:ttys008"]);
  });

  it("prunes ended sessions past retention", async () => {
    await trackLiveSessions([makeSession("1:ttys007")], NOW, file);
    await trackLiveSessions([], NOW + 1000, file);
    // 49 hours later the entry is gone (48h retention).
    const later = NOW + 49 * HOUR;
    expect(await getEndedSessions(later, file)).toHaveLength(0);
  });
});
