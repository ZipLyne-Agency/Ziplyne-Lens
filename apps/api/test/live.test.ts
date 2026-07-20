import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/live.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/live.js")>();
  return { ...actual, getLiveSessionsPayload: vi.fn() };
});

import { app } from "../src/app.js";
import {
  agentTitleFromPath,
  type CommandRunner,
  classifySession,
  detectHost,
  detectProvider,
  getLiveSessionsPayload,
  type LiveSession,
  type LiveSessionsResponse,
  type ProcessRecord,
  parsePsOutput,
  repositoryRoot,
  requiresInput,
  scanLiveSessions,
  scoreProcess,
  shapeLiveSessions,
} from "../src/live.js";

const getLiveSessionsPayloadMock = vi.mocked(getLiveSessionsPayload);

afterEach(() => {
  getLiveSessionsPayloadMock.mockReset();
});

function makeProcess(overrides: Partial<ProcessRecord>): ProcessRecord {
  return {
    pid: 100,
    parentPid: 1,
    tty: "ttys000",
    state: "S",
    cpuPercent: 0,
    command: "-zsh",
    ...overrides,
  };
}

describe("parsePsOutput", () => {
  it("parses ps -axo output into records", () => {
    const output = [
      "    1     0 ??      Ss     0.0 /sbin/launchd",
      "  201   200 ttys000 R+    12.5 claude --dangerously-skip-permissions --model opus",
      "",
      "garbage line with no numbers",
      "  300     1 ttys001 S      0.0 /bin/zsh -l",
    ].join("\n");

    const records = parsePsOutput(output);

    expect(records).toHaveLength(3);
    expect(records[1]).toEqual({
      pid: 201,
      parentPid: 200,
      tty: "ttys000",
      state: "R+",
      cpuPercent: 12.5,
      command: "claude --dangerously-skip-permissions --model opus",
    });
  });
});

describe("detectProvider", () => {
  it("matches known providers case-insensitively", () => {
    expect(detectProvider("claude --resume")).toBe("Claude");
    expect(detectProvider("/usr/local/bin/Codex exec")).toBe("Codex");
    expect(detectProvider("grok chat")).toBe("Grok");
    expect(detectProvider("kimi")).toBe("Kimi");
    expect(detectProvider("gemini -p hi")).toBe("Gemini");
    expect(detectProvider("aider --model gpt-5")).toBe("Aider");
  });

  it("returns null for non-agent commands", () => {
    expect(detectProvider("vim README.md")).toBeNull();
    expect(detectProvider("-zsh")).toBeNull();
  });
});

describe("agentTitleFromPath", () => {
  it("identifies version-named wrapper binaries by their install path", () => {
    expect(
      agentTitleFromPath("/Users/me/.local/share/claude/versions/2.1.214"),
    ).toBe("Claude Code");
    expect(
      agentTitleFromPath("/opt/homebrew/lib/node_modules/codex/1.2.3 --flag"),
    ).toBe("OpenAI Codex");
  });

  it("ignores non-version executables and unknown paths", () => {
    expect(agentTitleFromPath("/usr/local/bin/claude")).toBeNull();
    expect(agentTitleFromPath("/opt/tools/1.2.3")).toBeNull();
    expect(agentTitleFromPath("node server.js")).toBeNull();
  });
});

describe("detectHost", () => {
  it("finds the host by walking ppid ancestors", () => {
    const terminal = makeProcess({
      pid: 50,
      parentPid: 1,
      tty: "??",
      command:
        "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    });
    const shell = makeProcess({
      pid: 60,
      parentPid: 50,
      command: "login -fp developer",
    });
    const agent = makeProcess({ pid: 61, parentPid: 60, command: "claude" });
    const byPid = new Map([terminal, shell, agent].map((p) => [p.pid, p]));

    expect(detectHost(agent, byPid)).toBe("Terminal");
  });

  it("matches the additional editors and terminals", () => {
    const cases: Array<[string, string]> = [
      ["/Applications/iTerm.app/Contents/MacOS/iTerm2", "iTerm"],
      ["/Applications/Zed.app/Contents/MacOS/zed", "Zed"],
      [
        "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
        "VS Code",
      ],
      ["Cursor Helper --type=renderer", "Cursor"],
      ["/Applications/Ghostty.app/Contents/MacOS/ghostty", "Ghostty"],
      ["wezterm-gui", "WezTerm"],
      ["/Applications/Warp.app/Contents/MacOS/stable", "Warp"],
    ];
    for (const [command, expected] of cases) {
      const parent = makeProcess({ pid: 10, command });
      const child = makeProcess({ pid: 11, parentPid: 10, command: "-zsh" });
      const byPid = new Map([parent, child].map((p) => [p.pid, p]));
      expect(detectHost(child, byPid)).toBe(expected);
    }
  });

  it("returns null when no ancestor is a known host", () => {
    const orphan = makeProcess({ pid: 11, parentPid: 999, command: "claude" });
    expect(detectHost(orphan, new Map([[11, orphan]]))).toBeNull();
  });
});

describe("scoreProcess", () => {
  it("ranks providers above shells and busy processes above idle ones", () => {
    const shell = scoreProcess(makeProcess({ command: "/bin/zsh -l" }));
    const editor = scoreProcess(makeProcess({ command: "vim foo.ts" }));
    const agent = scoreProcess(
      makeProcess({ command: "claude", cpuPercent: 3 }),
    );
    expect(agent).toBeGreaterThan(editor);
    expect(editor).toBeGreaterThan(shell);
  });
});

describe("classifySession", () => {
  it("flags zombies as needing attention", () => {
    expect(
      classifySession({ processState: "Z", cpuPercent: 0, provider: null }),
    ).toEqual({
      state: "Needs Attention",
      reason: "Process exited unexpectedly",
    });
  });

  it("treats running or busy processes as working", () => {
    expect(
      classifySession({ processState: "R+", cpuPercent: 0, provider: null })
        .state,
    ).toBe("Working");
    expect(
      classifySession({ processState: "S", cpuPercent: 0.5, provider: null }),
    ).toEqual({
      state: "Working",
      reason: "Using CPU or actively scheduled",
    });
  });

  it("flags a transcript that requests input as needing attention", () => {
    expect(
      classifySession({
        processState: "S",
        cpuPercent: 0,
        provider: "Claude",
        transcript:
          "some output\nDo you want to proceed? press enter to confirm",
      }),
    ).toEqual({
      state: "Needs Attention",
      reason: "Latest terminal output requests input",
    });
  });

  it("reports quiet sessions with provider-aware reasons", () => {
    expect(
      classifySession({ processState: "S", cpuPercent: 0, provider: "Kimi" }),
    ).toEqual({
      state: "Quiet",
      reason:
        "Agent is quiet. Prompt status is not available without a preview",
    });
    expect(
      classifySession({ processState: "I", cpuPercent: 0, provider: null }),
    ).toEqual({
      state: "Quiet",
      reason: "Sleeping, with no recent activity",
    });
  });

  it("falls back to unknown for other states", () => {
    expect(
      classifySession({ processState: "T", cpuPercent: 0, provider: null }),
    ).toEqual({
      state: "Unknown",
      reason: "macOS did not expose enough activity detail",
    });
  });
});

describe("requiresInput", () => {
  it("only inspects the last eight lines", () => {
    const prompt = "press enter to continue";
    const recent = Array.from({ length: 7 }, (_, i) => `line ${i}`);
    expect(requiresInput([...recent, prompt].join("\n"))).toBe(true);

    const buried = [
      prompt,
      ...Array.from({ length: 8 }, (_, i) => `line ${i}`),
    ];
    expect(requiresInput(buried.join("\n"))).toBe(false);
  });
});

describe("repositoryRoot", () => {
  let scratch: string;

  afterEach(async () => {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("walks up to the nearest directory containing .git", async () => {
    scratch = await mkdtemp(join(tmpdir(), "live-git-"));
    await mkdir(join(scratch, ".git"));
    await mkdir(join(scratch, "packages", "core"), { recursive: true });

    expect(repositoryRoot(join(scratch, "packages", "core"))).toBe(scratch);
  });

  it("returns null outside any repository", async () => {
    scratch = await mkdtemp(join(tmpdir(), "live-nogit-"));
    await mkdir(join(scratch, "sub"), { recursive: true });

    expect(repositoryRoot(join(scratch, "sub"))).toBeNull();
  });
});

describe("scanLiveSessions", () => {
  const psFixture = [
    "    1     0 ??      Ss     0.0 /sbin/launchd",
    "  100     1 ??      Ss     0.0 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    "  200   100 ttys000 Ss     0.0 -zsh",
    "  201   200 ttys000 S      2.5 claude",
    "  300     1 ttys001 Ss     0.0 /bin/zsh -l",
    "  400   999 ttys002 S      0.1 vim foo.ts",
    "  500   100 ??      S      0.0 /usr/libexec/whatever",
  ].join("\n");

  function fixtureRunner(lsofOutput: string): CommandRunner {
    return async (executable) => {
      if (executable === "/bin/ps") {
        return psFixture;
      }
      if (executable === "/usr/sbin/lsof") {
        return lsofOutput;
      }
      return "";
    };
  }

  it("keeps only hosted ttys sessions and picks the best process per tty", async () => {
    const sessions = await scanLiveSessions({
      runner: fixtureRunner("p201\nn/tmp\n"),
    });

    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session).toMatchObject({
      id: "201:ttys000",
      pid: 201,
      tty: "ttys000",
      command: "claude",
      host: "Terminal",
      provider: "Claude",
      workingDirectory: "/tmp",
      projectName: "tmp",
      state: "Working",
    });
    expect(typeof session?.lastObservedAt).toBe("string");
  });

  it("marks sessions as quiet when idle and omits transcripts by default", async () => {
    const sessions = await scanLiveSessions({
      runner: fixtureRunner("p201\nn/tmp\n"),
    });
    expect(sessions[0]?.transcript).toBeUndefined();

    const idleFixture = psFixture.replace(
      "S      2.5 claude",
      "S      0.0 claude",
    );
    const idleRunner: CommandRunner = async (executable) => {
      if (executable === "/bin/ps") {
        return idleFixture;
      }
      return "";
    };
    const idle = await scanLiveSessions({ runner: idleRunner });
    expect(idle[0]).toMatchObject({ state: "Quiet", provider: "Claude" });
  });
});

describe("shapeLiveSessions", () => {
  function makeSession(overrides: Partial<LiveSession>): LiveSession {
    return {
      id: "1:ttys000",
      pid: 1,
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
      lastObservedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("groups by working directory, sorts sessions, and counts states", () => {
    const sessions = [
      makeSession({ id: "1", state: "Quiet", command: "zsh" }),
      makeSession({ id: "2", state: "Needs Attention", command: "claude" }),
      makeSession({
        id: "3",
        state: "Working",
        command: "kimi",
        workingDirectory: "/repo/other",
        projectName: "other",
      }),
    ];

    const payload = shapeLiveSessions(
      sessions,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(payload.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(payload.sessions.map((s) => s.id)).toEqual(["2", "3", "1"]);
    expect(payload.counts).toEqual({
      total: 3,
      working: 1,
      quiet: 1,
      needsAttention: 1,
      unknown: 0,
    });
    expect(payload.groups).toHaveLength(2);
    const appGroup = payload.groups.find((g) => g.name === "app");
    expect(appGroup).toMatchObject({
      id: "/repo/app",
      workingDirectory: "/repo/app",
      attentionCount: 1,
    });
    expect(appGroup?.sessions.map((s) => s.id)).toEqual(["2", "1"]);
  });
});

describe("GET /api/live/sessions", () => {
  const payloadFixture: LiveSessionsResponse = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    sessions: [
      {
        id: "201:ttys000",
        pid: 201,
        tty: "ttys000",
        command: "claude",
        workingDirectory: "/repo/app",
        projectName: "app",
        host: "Terminal",
        cpuPercent: 2.5,
        processState: "S",
        provider: "Claude",
        state: "Working",
        reason: "Using CPU or actively scheduled",
        lastObservedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    groups: [
      {
        id: "/repo/app",
        name: "app",
        workingDirectory: "/repo/app",
        sessions: [],
        attentionCount: 0,
      },
    ],
    counts: { total: 1, working: 1, quiet: 0, needsAttention: 0, unknown: 0 },
  };

  it("returns 200 with the live payload shape", async () => {
    getLiveSessionsPayloadMock.mockResolvedValue(payloadFixture);

    const response = await app.request("/api/live/sessions");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      generatedAt: "2026-01-01T00:00:00.000Z",
      counts: { total: 1, working: 1, quiet: 0, needsAttention: 0, unknown: 0 },
    });
    expect(body.sessions[0]).toMatchObject({
      pid: 201,
      tty: "ttys000",
      provider: "Claude",
      state: "Working",
      host: "Terminal",
    });
    expect(body.groups[0]).toMatchObject({ name: "app", id: "/repo/app" });
    expect(getLiveSessionsPayloadMock).toHaveBeenCalledWith({
      includeTranscripts: false,
    });
  });

  it("accepts the transcripts opt-in flag", async () => {
    getLiveSessionsPayloadMock.mockResolvedValue(payloadFixture);

    const response = await app.request("/api/live/sessions?transcripts=1");

    expect(response.status).toBe(200);
    expect(getLiveSessionsPayloadMock).toHaveBeenCalledWith({
      includeTranscripts: true,
    });
  });

  it("rejects an invalid transcripts value", async () => {
    const response = await app.request("/api/live/sessions?transcripts=yes");

    expect(response.status).toBe(400);
    expect(getLiveSessionsPayloadMock).not.toHaveBeenCalled();
  });
});
