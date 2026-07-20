// Live-session history: remembers every session the scanner has seen so the
// dashboard can show recently-ended ("dead") agent sessions, not just the
// currently-running ones.
//
// The scanner itself is stateless — a session that exits simply stops
// appearing. This tracker diffs each scan against everything it knows: a
// session missing from the current scan is marked ended (revived if its
// pid:tty identity ever reappears). State persists to
// ~/.ziplyne-lens/live-history.json so the Ended column survives app
// restarts. Ended entries prune after 48h, users can dismiss individual ones.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LiveSession } from "./live.js";

const ENDED_RETENTION_MS = 48 * 3_600_000;
const ENDED_CAP = 50;
const FLUSH_DELAY_MS = 5_000;

export interface EndedSession {
  id: string;
  pid: number;
  tty: string;
  command: string;
  workingDirectory: string;
  projectName: string;
  host: string;
  provider: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  endedAt: string;
}

interface TrackedEntry {
  pid: number;
  tty: string;
  command: string;
  workingDirectory: string;
  projectName: string;
  host: string;
  provider: string | null;
  firstSeenMs: number;
  lastSeenMs: number;
  endedMs?: number;
}

interface HistoryFile {
  sessions: Record<string, TrackedEntry>;
  dismissed: string[];
}

interface HistoryState {
  loaded: boolean;
  file: string;
  sessions: Map<string, TrackedEntry>;
  dismissed: Set<string>;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
}

let state: HistoryState | undefined;

function stateFor(file?: string): HistoryState {
  if (!state) {
    state = {
      loaded: false,
      file: file ?? join(homedir(), ".ziplyne-lens", "live-history.json"),
      sessions: new Map(),
      dismissed: new Set(),
      flushTimer: undefined,
    };
  }
  return state;
}

async function ensureLoaded(st: HistoryState): Promise<void> {
  if (st.loaded) {
    return;
  }
  st.loaded = true;
  try {
    const raw = JSON.parse(await readFile(st.file, "utf8")) as HistoryFile;
    for (const [id, entry] of Object.entries(raw.sessions ?? {})) {
      st.sessions.set(id, entry);
    }
    for (const id of raw.dismissed ?? []) {
      st.dismissed.add(id);
    }
  } catch {
    // No history yet (or unreadable) — start empty.
  }
}

function scheduleFlush(st: HistoryState): void {
  if (st.flushTimer) {
    return;
  }
  st.flushTimer = setTimeout(() => {
    st.flushTimer = undefined;
    void flushSessionHistory();
  }, FLUSH_DELAY_MS);
  st.flushTimer.unref?.();
}

// Write the current state to disk now. The debounced path uses this; tests
// and shutdown hooks can force it directly.
export async function flushSessionHistory(): Promise<void> {
  const st = state;
  if (!st) {
    return;
  }
  if (st.flushTimer) {
    clearTimeout(st.flushTimer);
    st.flushTimer = undefined;
  }
  try {
    await mkdir(join(st.file, ".."), { recursive: true });
    const body: HistoryFile = {
      sessions: Object.fromEntries(st.sessions),
      dismissed: [...st.dismissed],
    };
    const tmp = `${st.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(body), "utf8");
    await rename(tmp, st.file);
  } catch {
    // Best-effort persistence only.
  }
}

// Record one scan: refresh known sessions, mark the missing ones ended.
export async function trackLiveSessions(
  sessions: LiveSession[],
  nowMs: number,
  historyFile?: string,
): Promise<void> {
  const st = stateFor(historyFile);
  await ensureLoaded(st);
  const current = new Set<string>();
  for (const session of sessions) {
    current.add(session.id);
    const existing = st.sessions.get(session.id);
    if (existing) {
      existing.lastSeenMs = nowMs;
      existing.endedMs = undefined;
      existing.command = session.command;
      existing.provider = session.provider;
      existing.workingDirectory = session.workingDirectory;
      existing.projectName = session.projectName;
      existing.host = session.host;
    } else {
      st.sessions.set(session.id, {
        pid: session.pid,
        tty: session.tty,
        command: session.command,
        workingDirectory: session.workingDirectory,
        projectName: session.projectName,
        host: session.host,
        provider: session.provider,
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
      });
    }
  }
  for (const [id, entry] of st.sessions) {
    if (!current.has(id) && entry.endedMs === undefined) {
      entry.endedMs = nowMs;
    }
  }
  scheduleFlush(st);
}

// Ended sessions for the dashboard: newest first, dismissed excluded,
// retention + cap applied.
export async function getEndedSessions(
  nowMs: number,
  historyFile?: string,
): Promise<EndedSession[]> {
  const st = stateFor(historyFile);
  await ensureLoaded(st);
  const cutoff = nowMs - ENDED_RETENTION_MS;
  const ended: EndedSession[] = [];
  for (const [id, entry] of st.sessions) {
    if (entry.endedMs === undefined) {
      continue;
    }
    if (entry.endedMs < cutoff) {
      st.sessions.delete(id);
      continue;
    }
    if (st.dismissed.has(id)) {
      continue;
    }
    ended.push({
      id,
      pid: entry.pid,
      tty: entry.tty,
      command: entry.command,
      workingDirectory: entry.workingDirectory,
      projectName: entry.projectName,
      host: entry.host,
      provider: entry.provider,
      firstSeenAt: new Date(entry.firstSeenMs).toISOString(),
      lastSeenAt: new Date(entry.lastSeenMs).toISOString(),
      endedAt: new Date(entry.endedMs).toISOString(),
    });
  }
  return ended
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
    .slice(0, ENDED_CAP);
}

export async function dismissEndedSession(
  id: string,
  historyFile?: string,
): Promise<boolean> {
  const st = stateFor(historyFile);
  await ensureLoaded(st);
  if (!st.sessions.has(id)) {
    return false;
  }
  st.dismissed.add(id);
  scheduleFlush(st);
  return true;
}

// Test seam: wipe all in-memory state (and any pending flush).
export function resetSessionHistory(): void {
  if (state?.flushTimer) {
    clearTimeout(state.flushTimer);
  }
  state = undefined;
}
