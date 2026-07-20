import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createScanCache } from "./scan-cache.js";
import type { EndedSession } from "./session-history.js";

const execFileAsync = promisify(execFile);

export interface ProcessRecord {
  pid: number;
  parentPid: number;
  tty: string;
  state: string;
  cpuPercent: number;
  command: string;
}

// Every shell-out goes through a CommandRunner so tests can inject fixtures
// and the route never touches ps/lsof/osascript directly.
export type CommandRunner = (
  executable: string,
  args: string[],
  timeoutMs?: number,
) => Promise<string>;

// Non-zero exits, missing binaries and timeouts all collapse to "" so a
// scanner hiccup can never throw into a route.
export const defaultRunner: CommandRunner = async (
  executable,
  args,
  timeoutMs = 10_000,
) => {
  try {
    const { stdout } = await execFileAsync(executable, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
};

// Provider detection is driven by this single list; order decides which
// provider wins when a command line mentions more than one. Includes the
// extra agent CLIs from Sesshy's AgentCatalog so live sessions and
// connection scans share one catalog ("cursor" also matches cursor-agent,
// "qwen" also matches qwen-code, "gemini" also matches gemini-cli).
export const agentProviders = [
  { match: "claude", name: "Claude" },
  { match: "codex", name: "Codex" },
  { match: "grok", name: "Grok" },
  { match: "kimi", name: "Kimi" },
  { match: "gemini", name: "Gemini" },
  { match: "aider", name: "Aider" },
  { match: "cursor", name: "Cursor" },
  { match: "qwen", name: "Qwen" },
  { match: "goose", name: "Goose" },
  { match: "opencode", name: "OpenCode" },
  { match: "amp", name: "Amp" },
  { match: "crush", name: "Crush" },
  { match: "continue", name: "Continue" },
] as const;

export type AgentProvider = (typeof agentProviders)[number]["name"];

// Exact-executable -> display title, ported from Sesshy's AgentCatalog
// (kimi/grok added: ZipLyne tracks those agents too). connections.ts uses
// this for exact executable matching where detectProvider's substring
// matching would be too loose.
export const agentExecutableTitles: Record<string, string> = {
  claude: "Claude Code",
  "claude-code": "Claude Code",
  "cursor-agent": "Cursor Agent",
  cursor: "Cursor Agent",
  codex: "OpenAI Codex",
  aider: "Aider",
  gemini: "Gemini CLI",
  "gemini-cli": "Gemini CLI",
  qwen: "Qwen Coder",
  "qwen-code": "Qwen Coder",
  goose: "Block Goose",
  opencode: "OpenCode",
  amp: "Sourcegraph Amp",
  crush: "Crush",
  continue: "Continue",
  kimi: "Kimi Code",
  grok: "Grok",
  agent: "Generic Agent",
};

export function agentTitleFor(executable: string): string | null {
  return agentExecutableTitles[executable.toLowerCase()] ?? null;
}

// Wrappers like Happy relaunch agents under a version-named binary
// (e.g. ~/.local/share/claude/versions/2.1.214): the executable basename is a
// bare version string, but the install path still names the agent. Only
// applies when the basename is nothing but digits and dots.
const AGENT_PATH_MARKERS: Record<string, string> = {
  "/claude/": "Claude Code",
  "/codex/": "OpenAI Codex",
  "/kimi": "Kimi Code",
  "/grok/": "Grok",
};

export function agentTitleFromPath(commandLine: string): string | null {
  const executable = basename(commandLine.split(" ")[0] ?? "");
  if (!/^\d[\d.]*$/.test(executable)) {
    return null;
  }
  const lower = commandLine.toLowerCase();
  for (const [marker, title] of Object.entries(AGENT_PATH_MARKERS)) {
    if (lower.includes(marker)) {
      return title;
    }
  }
  return null;
}

export function detectProvider(command: string): AgentProvider | null {
  const lowercased = command.toLowerCase();
  for (const provider of agentProviders) {
    if (lowercased.includes(provider.match)) {
      return provider.name;
    }
  }
  return null;
}

// Hosts without a match here are treated as "other" and their sessions are
// excluded, same as the Swift app.
export const terminalHosts = [
  { name: "Terminal", needles: ["terminal.app"] },
  { name: "iTerm", needles: ["iterm.app", "/iterm"] },
  { name: "Zed", needles: ["zed.app", "/zed"] },
  { name: "VS Code", needles: ["visual studio code", "code helper"] },
  { name: "Cursor", needles: ["cursor.app", "cursor helper"] },
  { name: "Ghostty", needles: ["ghostty"] },
  { name: "WezTerm", needles: ["wezterm"] },
  { name: "Warp", needles: ["warp"] },
] as const;

export type TerminalHost = (typeof terminalHosts)[number]["name"];

// Walks the ppid ancestor chain (starting at the process itself) looking for
// a known terminal host. The visited set guards against ppid cycles (pid 0
// is its own parent on macOS).
export function detectHost(
  process: ProcessRecord,
  processesByPid: ReadonlyMap<number, ProcessRecord>,
): TerminalHost | null {
  const visited = new Set<number>();
  let current: ProcessRecord | undefined = process;
  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    const command = current.command.toLowerCase();
    for (const host of terminalHosts) {
      if (host.needles.some((needle) => command.includes(needle))) {
        return host.name;
      }
    }
    current = processesByPid.get(current.parentPid);
  }
  return null;
}

export function parsePsOutput(output: string): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(.+)$/u,
    );
    if (!match) {
      continue;
    }
    const [pid, parentPid, tty, state, cpu, command] = match.slice(1);
    if (!pid || !parentPid || !tty || !state || !cpu || !command) {
      continue;
    }
    records.push({
      pid: Number(pid),
      parentPid: Number(parentPid),
      tty,
      state,
      cpuPercent: Number(cpu),
      command,
    });
  }
  return records;
}

export async function readProcesses(
  runner: CommandRunner = defaultRunner,
): Promise<ProcessRecord[]> {
  const output = await runner("/bin/ps", [
    "-axo",
    "pid=,ppid=,tty=,state=,pcpu=,command=",
  ]);
  return parsePsOutput(output);
}

// Best process per tty: provider processes beat shells, busy processes win
// ties. Ported from the Swift scorer.
export function scoreProcess(process: ProcessRecord): number {
  let result = 0;
  if (detectProvider(process.command)) {
    result += 100;
  }
  if (
    !process.command.includes("/bin/zsh") &&
    !process.command.endsWith(" zsh")
  ) {
    result += 20;
  }
  if (process.cpuPercent >= 0.5) {
    result += 10;
  }
  return result;
}

export async function workingDirectoryFor(
  pid: number,
  runner: CommandRunner = defaultRunner,
): Promise<string | null> {
  const output = await runner(
    "/usr/sbin/lsof",
    ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
    4_000,
  );
  const line = output.split("\n").find((entry) => entry.startsWith("n/"));
  return line ? line.slice(1) : null;
}

async function ancestorWorkingDirectory(
  process: ProcessRecord,
  processesByPid: ReadonlyMap<number, ProcessRecord>,
  runner: CommandRunner,
): Promise<string | null> {
  const visited = new Set<number>();
  let current = processesByPid.get(process.parentPid);
  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    const directory = await workingDirectoryFor(current.pid, runner);
    if (directory) {
      return directory;
    }
    current = processesByPid.get(current.parentPid);
  }
  return null;
}

// Walks up from `directory` to the nearest ancestor containing a .git entry.
export function repositoryRoot(directory: string): string | null {
  let current = resolve(directory);
  while (current !== dirname(current)) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    current = dirname(current);
  }
  return null;
}

export type SessionState = "Needs Attention" | "Working" | "Quiet" | "Unknown";

export interface SessionAssessment {
  state: SessionState;
  reason: string;
}

export interface ClassifyInput {
  processState: string;
  cpuPercent: number;
  provider: AgentProvider | null;
  transcript?: string | null;
}

// Ported from the Swift SessionClassifier, branch order included.
export function classifySession(input: ClassifyInput): SessionAssessment {
  if (input.processState.includes("Z")) {
    return {
      state: "Needs Attention",
      reason: "Process exited unexpectedly",
    };
  }
  if (input.processState.includes("R") || input.cpuPercent >= 0.5) {
    return { state: "Working", reason: "Using CPU or actively scheduled" };
  }
  if (input.transcript && requiresInput(input.transcript)) {
    return {
      state: "Needs Attention",
      reason: "Latest terminal output requests input",
    };
  }
  if (input.processState.includes("S") || input.processState.includes("I")) {
    if (input.provider) {
      return {
        state: "Quiet",
        reason:
          "Agent is quiet. Prompt status is not available without a preview",
      };
    }
    return { state: "Quiet", reason: "Sleeping, with no recent activity" };
  }
  return {
    state: "Unknown",
    reason: "macOS did not expose enough activity detail",
  };
}

export function requiresInput(transcript: string): boolean {
  const tail = transcript.split("\n").slice(-8).join(" ").toLowerCase();
  const prompts = [
    "press enter",
    "approve",
    "allow",
    "confirm",
    "y/n",
    "[y/n]",
    "authentication",
    "log in",
    "login",
    "? ",
  ];
  return prompts.some((prompt) => tail.includes(prompt));
}

const terminalTranscriptScript = `tell application "Terminal"
  set output to ""
  set recordSeparator to ASCII character 30
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      set output to output & (tty of aTab) & tab & (contents of aTab) & recordSeparator
    end repeat
  end repeat
  return output
end tell`;

// Opt-in Terminal.app transcript reading via AppleScript. The runner's
// timeout keeps a hung Apple Event from stalling the route; any failure
// yields an empty map.
export async function readTerminalTranscripts(
  runner: CommandRunner = defaultRunner,
): Promise<Record<string, string>> {
  const output = await runner(
    "/usr/bin/osascript",
    ["-e", terminalTranscriptScript],
    4_000,
  );
  const transcripts: Record<string, string> = {};
  for (const record of output.split("\u001e")) {
    const separator = record.indexOf("\t");
    if (separator < 0) {
      continue;
    }
    const tty = record.slice(0, separator).replaceAll("/dev/", "");
    if (!tty) {
      continue;
    }
    transcripts[tty] = record.slice(separator + 1);
  }
  return transcripts;
}

export interface LiveSession {
  id: string;
  pid: number;
  tty: string;
  command: string;
  workingDirectory: string;
  projectName: string;
  host: TerminalHost;
  cpuPercent: number;
  processState: string;
  provider: AgentProvider | null;
  state: SessionState;
  reason: string;
  transcript?: string;
  lastObservedAt: string;
}

export interface ScanLiveOptions {
  includeTranscripts?: boolean;
  runner?: CommandRunner;
}

// Signature-based activity tracking: as long as command|state|cpu stays the
// same the session keeps its previous observation date, so "last changed" is
// visible across polls.
const activityTimes = new Map<string, { signature: string; date: Date }>();

export async function scanLiveSessions(
  options: ScanLiveOptions = {},
): Promise<LiveSession[]> {
  const runner = options.runner ?? defaultRunner;
  const processes = await readProcesses(runner);
  const processesByPid = new Map(
    processes.map((process) => [process.pid, process]),
  );

  const eligible: Array<{ process: ProcessRecord; host: TerminalHost }> = [];
  for (const process of processes) {
    if (!process.tty.startsWith("ttys")) {
      continue;
    }
    const host = detectHost(process, processesByPid);
    if (host) {
      eligible.push({ process, host });
    }
  }

  const byTty = new Map<string, typeof eligible>();
  for (const entry of eligible) {
    const group = byTty.get(entry.process.tty);
    if (group) {
      group.push(entry);
    } else {
      byTty.set(entry.process.tty, [entry]);
    }
  }
  const selected = [...byTty.values()].map((group) =>
    group.reduce((best, entry) =>
      scoreProcess(entry.process) > scoreProcess(best.process) ? entry : best,
    ),
  );

  const transcripts = options.includeTranscripts
    ? await readTerminalTranscripts(runner)
    : {};
  const home = homedir();

  return Promise.all(
    selected.map(async ({ process, host }) => {
      const directory =
        (await workingDirectoryFor(process.pid, runner)) ??
        (await ancestorWorkingDirectory(process, processesByPid, runner)) ??
        home;
      const workingDirectory = repositoryRoot(directory) ?? directory;

      const id = `${process.pid}:${process.tty}`;
      const signature = `${process.command}|${process.state}|${process.cpuPercent}`;
      const history = activityTimes.get(id);
      const lastObservedAt =
        history?.signature === signature ? history.date : new Date();
      activityTimes.set(id, { signature, date: lastObservedAt });

      const provider = detectProvider(process.command);
      const transcript = transcripts[process.tty];
      const assessment = classifySession({
        processState: process.state,
        cpuPercent: process.cpuPercent,
        provider,
        transcript,
      });

      return {
        id,
        pid: process.pid,
        tty: process.tty,
        command: process.command,
        workingDirectory,
        projectName: basename(workingDirectory) || workingDirectory,
        host,
        cpuPercent: process.cpuPercent,
        processState: process.state,
        provider,
        state: assessment.state,
        reason: assessment.reason,
        transcript,
        lastObservedAt: lastObservedAt.toISOString(),
      };
    }),
  );
}

export interface LiveProjectGroup {
  id: string;
  name: string;
  workingDirectory: string;
  sessions: LiveSession[];
  attentionCount: number;
}

export interface LiveSessionsResponse {
  generatedAt: string;
  sessions: LiveSession[];
  groups: LiveProjectGroup[];
  counts: {
    total: number;
    working: number;
    quiet: number;
    needsAttention: number;
    unknown: number;
  };
  // Filled by the route (session-history tracker); absent in direct calls.
  ended?: EndedSession[];
}

const statePriority: Record<SessionState, number> = {
  "Needs Attention": 0,
  Working: 1,
  Quiet: 2,
  Unknown: 3,
};

function compareSessions(a: LiveSession, b: LiveSession): number {
  const priority = statePriority[a.state] - statePriority[b.state];
  if (priority !== 0) {
    return priority;
  }
  return a.command.localeCompare(b.command);
}

export function shapeLiveSessions(
  sessions: LiveSession[],
  generatedAt: Date = new Date(),
): LiveSessionsResponse {
  const sorted = [...sessions].sort(compareSessions);

  const groupsByDirectory = new Map<string, LiveSession[]>();
  for (const session of sorted) {
    const group = groupsByDirectory.get(session.workingDirectory);
    if (group) {
      group.push(session);
    } else {
      groupsByDirectory.set(session.workingDirectory, [session]);
    }
  }
  const groups: LiveProjectGroup[] = [...groupsByDirectory.entries()]
    .map(([workingDirectory, groupSessions]) => ({
      id: workingDirectory,
      name: groupSessions[0]?.projectName ?? workingDirectory,
      workingDirectory,
      sessions: groupSessions,
      attentionCount: groupSessions.filter(
        (session) => session.state === "Needs Attention",
      ).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const counts = {
    total: sessions.length,
    working: 0,
    quiet: 0,
    needsAttention: 0,
    unknown: 0,
  };
  for (const session of sessions) {
    if (session.state === "Working") {
      counts.working += 1;
    } else if (session.state === "Quiet") {
      counts.quiet += 1;
    } else if (session.state === "Needs Attention") {
      counts.needsAttention += 1;
    } else {
      counts.unknown += 1;
    }
  }

  return {
    generatedAt: generatedAt.toISOString(),
    sessions: sorted,
    groups,
    counts,
  };
}

const livePayloadCache = createScanCache(
  2_500,
  (options: ScanLiveOptions) => scanLiveSessions(options),
  (options) => (options.includeTranscripts ? "t" : "f"),
);

// The dashboard's Live pane polls every 3s, the sidebar badge every 15s, the
// tray every 60s, and the warmer every 60s — a tiny shared cache collapses
// the overlaps without ever feeling stale.
export async function getLiveSessionsPayload(
  options: ScanLiveOptions = {},
): Promise<LiveSessionsResponse> {
  return shapeLiveSessions(await livePayloadCache(options));
}
