import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/connections.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/connections.js")>();
  return { ...actual, getConnectionsPayload: vi.fn() };
});

import { app } from "../src/app.js";
import {
  type CommandRunner,
  type ConnectionSession,
  type ConnectionsPayload,
  cliContextTarget,
  extractSshTarget,
  getConnectionsPayload,
  isLocalEndpoint,
  parseElapsedSeconds,
  parseLsofConnections,
  parseMongoTarget,
  parseMysqlTarget,
  parsePostgresTarget,
  parsePsSnapshots,
  parseRedisTarget,
  redactCommandLine,
  scanConnections,
  shapeConnectionsPayload,
  shellSplit,
  terminalNameFor,
} from "../src/connections.js";

const getConnectionsPayloadMock = vi.mocked(getConnectionsPayload);

afterEach(() => {
  getConnectionsPayloadMock.mockReset();
});

describe("parsePsSnapshots", () => {
  it("parses ps -ax -o pid=,ppid=,tty=,etimes=,command= output", () => {
    const output = [
      "    1     0 ??       900000 /sbin/launchd",
      "  201   200 ttys000    3600 ssh -p 2222 deploy@db.internal",
      "",
      "garbage line with no numbers",
      "  300     1 ttys001  86400 /bin/zsh -l",
    ].join("\n");

    const records = parsePsSnapshots(output);

    expect(records).toHaveLength(3);
    expect(records[1]).toEqual({
      pid: 201,
      parentPid: 200,
      tty: "ttys000",
      elapsedSeconds: 3600,
      commandLine: "ssh -p 2222 deploy@db.internal",
    });
    expect(records[0]?.tty).toBe("??");
    expect(records[2]?.elapsedSeconds).toBe(86400);
  });

  it("also accepts etime [[dd-]hh:]mm:ss elapsed values", () => {
    const output = [
      "    1     0 ??       10:43:16 /sbin/launchd",
      "  201   200 ttys000 2-03:04:05 ssh host",
      "  202   200 ttys001    04:05 psql shop",
    ].join("\n");

    const records = parsePsSnapshots(output);

    expect(records.map((record) => record.elapsedSeconds)).toEqual([
      10 * 3600 + 43 * 60 + 16,
      2 * 86400 + 3 * 3600 + 4 * 60 + 5,
      4 * 60 + 5,
    ]);
  });

  it("parseElapsedSeconds rejects garbage", () => {
    expect(parseElapsedSeconds("abc")).toBeNull();
    expect(parseElapsedSeconds("1:2:3:4")).toBeNull();
  });
});

describe("shellSplit", () => {
  it("splits on whitespace and collapses runs of it", () => {
    expect(shellSplit("  ssh   -p   2222 host ")).toEqual([
      "ssh",
      "-p",
      "2222",
      "host",
    ]);
  });

  it("keeps single- and double-quoted segments together", () => {
    expect(shellSplit(`ssh -i "my key" host`)).toEqual([
      "ssh",
      "-i",
      "my key",
      "host",
    ]);
    expect(shellSplit("echo 'a b' c")).toEqual(["echo", "a b", "c"]);
  });

  it("treats backslash as an escape for the next character", () => {
    expect(shellSplit("ssh host\\ name")).toEqual(["ssh", "host name"]);
    expect(shellSplit(`echo "a \\"b\\" c"`)).toEqual(["echo", 'a "b" c']);
  });
});

describe("parseLsofConnections", () => {
  it("parses endpoints and TCP state, skipping the header and short lines", () => {
    const output = [
      "COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
      "ssh       201 dev      3u  IPv4 0xaaa      0t0  TCP 10.0.0.2:51000->203.0.113.10:2222 (ESTABLISHED)",
      "postgres  202 dev      5u  IPv4 0xbbb      0t0  TCP *:5432 (LISTEN)",
      "short line",
    ].join("\n");

    const connections = parseLsofConnections(output);

    expect(connections).toHaveLength(2);
    expect(connections[0]).toEqual({
      pid: 201,
      localEndpoint: "10.0.0.2:51000",
      remoteEndpoint: "203.0.113.10:2222",
      state: "ESTABLISHED",
    });
    expect(connections[1]).toEqual({
      pid: 202,
      localEndpoint: "*:5432",
      remoteEndpoint: "*:5432",
      state: "LISTEN",
    });
  });
});

describe("extractSshTarget", () => {
  it("returns the first non-option argument", () => {
    expect(extractSshTarget(["ssh", "deploy@db.internal"])).toBe(
      "deploy@db.internal",
    );
    expect(extractSshTarget(["ssh"])).toBeNull();
  });

  it("skips option values, including -p port", () => {
    expect(
      extractSshTarget(["/usr/bin/ssh", "-p", "2222", "deploy@db.internal"]),
    ).toBe("deploy@db.internal");
    expect(
      extractSshTarget([
        "ssh",
        "-i",
        "~/.ssh/id_ed25519",
        "-l",
        "deploy",
        "-o",
        "StrictHostKeyChecking=no",
        "db.internal",
      ]),
    ).toBe("db.internal");
    expect(
      extractSshTarget(["ssh", "-L", "8080:localhost:80", "-N", "bastion"]),
    ).toBe("bastion");
  });

  it("ignores flags it does not know without consuming the next token", () => {
    expect(extractSshTarget(["ssh", "-v", "-A", "host"])).toBe("host");
  });
});

describe("database target parsing", () => {
  it("parses psql postgres:// URL form", () => {
    expect(
      parsePostgresTarget([
        "psql",
        "postgres://u:hunter2@db.internal:5432/shop",
      ]),
    ).toEqual({ host: "db.internal", database: "shop" });
  });

  it("parses psql flag and positional forms", () => {
    expect(
      parsePostgresTarget(["psql", "-h", "db.internal", "-d", "shop"]),
    ).toEqual({ host: "db.internal", database: "shop" });
    expect(
      parsePostgresTarget(["psql", "--host", "db.internal", "shop"]),
    ).toEqual({ host: "db.internal", database: "shop" });
    expect(parsePostgresTarget(["psql", "shop"])).toEqual({
      host: "localhost",
      database: "shop",
    });
  });

  it("parses mysql -h host dbname without eating the db after -p", () => {
    expect(
      parseMysqlTarget([
        "mysql",
        "-h",
        "db.internal",
        "-u",
        "root",
        "-p",
        "shop",
      ]),
    ).toEqual({ host: "db.internal", database: "shop" });
    expect(parseMysqlTarget(["mysql", "--host=db.internal", "shop"])).toEqual({
      host: "db.internal",
      database: "shop",
    });
    expect(parseMysqlTarget(["mysql"])).toEqual({
      host: "localhost",
      database: "",
    });
  });

  it("parses redis-cli -h host", () => {
    expect(parseRedisTarget(["redis-cli", "-h", "cache.internal"])).toEqual({
      host: "cache.internal",
      database: "",
    });
    expect(parseRedisTarget(["redis-cli"])).toEqual({
      host: "localhost",
      database: "",
    });
  });

  it("parses mongosh mongodb:// URL and --host forms", () => {
    expect(
      parseMongoTarget(["mongosh", "mongodb://mongo.internal:27017/app"]),
    ).toEqual({ host: "mongo.internal", database: "app" });
    expect(parseMongoTarget(["mongosh", "--host", "mongo.internal"])).toEqual({
      host: "mongo.internal",
      database: "",
    });
  });
});

describe("cliContextTarget", () => {
  it("returns the value of the first context flag (--flag value)", () => {
    expect(cliContextTarget(["aws", "--profile", "prod", "s3", "ls"])).toBe(
      "prod",
    );
    expect(cliContextTarget(["vercel", "--scope", "my-team", "deploy"])).toBe(
      "my-team",
    );
    expect(cliContextTarget(["shopify", "-p", "my-app"])).toBe("my-app");
  });

  it("supports --flag=value", () => {
    expect(
      cliContextTarget(["gcloud", "--project=my-proj", "compute", "list"]),
    ).toBe("my-proj");
  });

  it("falls back to the first two positional tokens after the executable", () => {
    expect(cliContextTarget(["gh", "pr", "list"])).toBe("pr list");
    expect(cliContextTarget(["aws", "s3", "ls", "--profile"])).toBe("s3 ls");
    expect(cliContextTarget(["aws"])).toBeNull();
  });
});

describe("isLocalEndpoint", () => {
  it("flags loopback, wildcard and listen endpoints as local", () => {
    for (const endpoint of [
      "127.0.0.1:8787",
      "localhost:3000",
      "[::1]:8080",
      "::1:8080",
      "0.0.0.0:80",
      "*:5432",
    ]) {
      expect(isLocalEndpoint(endpoint)).toBe(true);
    }
  });

  it("treats routable endpoints as remote", () => {
    expect(isLocalEndpoint("203.0.113.10:2222")).toBe(false);
    expect(isLocalEndpoint("10.0.0.4:22")).toBe(false);
  });
});

describe("redactCommandLine", () => {
  it("masks --flag value and --flag=value forms", () => {
    expect(redactCommandLine("tool --password hunter2 next")).toBe(
      "tool --password ••••• next",
    );
    expect(redactCommandLine("tool --api-key=abc123")).toBe(
      "tool --api-key=•••••",
    );
    expect(
      redactCommandLine("tool --token tok --secret=s3 --auth Bearer"),
    ).toBe("tool --token ••••• --secret=••••• --auth •••••");
  });

  it("masks env assignments like PGPASSWORD=...", () => {
    expect(redactCommandLine("PGPASSWORD=hunter2 psql -h db")).toBe(
      "PGPASSWORD=••••• psql -h db",
    );
    expect(
      redactCommandLine("AWS_SESSION_TOKEN=abc aws sts get-caller-identity"),
    ).toBe("AWS_SESSION_TOKEN=••••• aws sts get-caller-identity");
  });

  it("masks scheme://user:pass@ userinfo but keeps user and host", () => {
    expect(
      redactCommandLine("psql postgres://u:hunter2@db.internal:5432/shop"),
    ).toBe("psql postgres://u:•••••@db.internal:5432/shop");
    expect(
      redactCommandLine("mongosh mongodb://root:secret@mongo.internal/app"),
    ).toBe("mongosh mongodb://root:•••••@mongo.internal/app");
  });

  it("leaves ordinary command lines untouched", () => {
    expect(redactCommandLine("ssh -p 2222 deploy@db.internal")).toBe(
      "ssh -p 2222 deploy@db.internal",
    );
  });
});

describe("terminalNameFor", () => {
  it("walks the ppid chain to a known terminal, cycle-safe", () => {
    const terminal = {
      pid: 100,
      parentPid: 1,
      tty: "??",
      elapsedSeconds: 10,
      commandLine:
        "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    };
    const shell = {
      pid: 200,
      parentPid: 100,
      tty: "ttys000",
      elapsedSeconds: 10,
      commandLine: "-zsh",
    };
    const ssh = {
      pid: 201,
      parentPid: 200,
      tty: "ttys000",
      elapsedSeconds: 10,
      commandLine: "ssh host",
    };
    const byPid = new Map(
      [terminal, shell, ssh].map((process) => [process.pid, process]),
    );

    expect(terminalNameFor(ssh, byPid)).toBe("Terminal");
  });

  it("falls back to the tty name when no ancestor matches", () => {
    const orphan = {
      pid: 11,
      parentPid: 999,
      tty: "ttys042",
      elapsedSeconds: 10,
      commandLine: "ssh host",
    };
    expect(terminalNameFor(orphan, new Map([[11, orphan]]))).toBe("ttys042");
  });
});

describe("scanConnections", () => {
  const psFixture = [
    "    1     0 ??       900000 /sbin/launchd",
    "  100     1 ??       800000 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    "  200   100 ttys000  700000 -zsh",
    "  201   200 ttys000    3600 ssh -p 2222 deploy@db.internal",
    "  202   200 ttys001     120 psql postgres://u:hunter2@db.host:5432/shop",
    "  203   200 ttys002      60 kubectl port-forward svc/web 8080:80",
    "  204   200 ttys003      30 kubectl get pods",
    "  205   200 ttys004     600 claude",
    "  206   200 ttys005      45 aws --profile prod s3 ls",
    "  207   200 ttys006      15 curl http://127.0.0.1:8787/api/health",
    "  208   200 ttys007      10 nc 192.0.2.5 443",
    "  300   200 ttys008       5 cat /var/log/system.log",
    "  400     1 ??          500 /usr/sbin/mDNSResponder",
  ].join("\n");

  const lsofNetworkFixture = [
    "COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
    "ssh       201 dev      3u  IPv4 0xaaa      0t0  TCP 10.0.0.2:51000->203.0.113.10:2222 (ESTABLISHED)",
    "psql      202 dev      5u  IPv4 0xbbb      0t0  TCP 10.0.0.2:52000->198.51.100.7:5432 (ESTABLISHED)",
    "kubectl   203 dev      7u  IPv4 0xccc      0t0  TCP 127.0.0.1:8080 (LISTEN)",
    "curl      207 dev      3u  IPv4 0xddd      0t0  TCP 127.0.0.1:54000->127.0.0.1:8787 (ESTABLISHED)",
    "nc        208 dev      3u  IPv4 0xeee      0t0  TCP 10.0.0.2:53000->192.0.2.5:443 (ESTABLISHED)",
  ].join("\n");

  const lsofCwdFixture = [
    "p201",
    "n/Users/dev/work/infra",
    "p202",
    "n/Users/dev/work/shop",
    "p205",
    "n/Users/dev/work/app",
  ].join("\n");

  const fixtureRunner: CommandRunner = async (executable, args) => {
    if (executable === "/bin/ps") {
      return psFixture;
    }
    if (executable === "/usr/sbin/lsof") {
      return args.includes("-i") ? lsofNetworkFixture : lsofCwdFixture;
    }
    if (executable === "/usr/bin/git" && args[1] === "/Users/dev/work/app") {
      return args.includes("--abbrev-ref") ? "main\n" : "/Users/dev/work/app\n";
    }
    return "";
  };

  it("classifies an end-to-end fixture and enriches git context", async () => {
    const sessions = await scanConnections({ runner: fixtureRunner });

    expect(
      sessions.map((session) => session.pid).sort((a, b) => a - b),
    ).toEqual([201, 202, 203, 205, 206, 208]);

    const byPid = new Map(sessions.map((session) => [session.pid, session]));

    expect(byPid.get(201)).toMatchObject({
      kind: "ssh",
      title: "SSH",
      target: "deploy@db.internal",
      subtitle: "203.0.113.10:2222",
      terminalName: "Terminal",
      elapsedSeconds: 3600,
    });
    expect(byPid.get(201)?.connections).toEqual([
      {
        local: "10.0.0.2:51000",
        remote: "203.0.113.10:2222",
        state: "ESTABLISHED",
      },
    ]);

    expect(byPid.get(202)).toMatchObject({
      kind: "database",
      title: "Postgres",
      target: "db.host",
      subtitle: "shop",
      commandLine: "psql postgres://u:•••••@db.host:5432/shop",
    });

    expect(byPid.get(203)).toMatchObject({
      kind: "tunnel",
      title: "Port Forward",
      target: "svc/web",
      subtitle: "8080:80",
    });

    expect(byPid.get(205)).toMatchObject({
      kind: "agent",
      title: "Claude Code",
      target: "app",
      subtitle: "/Users/dev/work/app",
      gitBranch: "main",
      gitRepoRoot: "/Users/dev/work/app",
    });

    expect(byPid.get(206)).toMatchObject({
      kind: "cloud",
      title: "AWS CLI",
      target: "prod",
    });

    expect(byPid.get(208)).toMatchObject({
      kind: "other",
      title: "CLI",
      target: "nc",
      subtitle: "192.0.2.5:443",
    });

    // kubectl get pods, loopback-only curl, ignored `cat` and "??" tty
    // processes never become sessions.
    expect(byPid.has(204)).toBe(false);
    expect(byPid.has(207)).toBe(false);
    expect(byPid.has(300)).toBe(false);
    expect(byPid.has(400)).toBe(false);
  });

  it("falls back to etime= when ps rejects etimes=", async () => {
    const requestedKeywords: string[] = [];
    const runner: CommandRunner = async (executable, args) => {
      if (executable === "/bin/ps") {
        const keyword = args.find((arg) => arg.startsWith("etime")) ?? "";
        requestedKeywords.push(keyword);
        if (keyword === "etimes=") {
          return "";
        }
        return "  201   200 ttys000    01:30 ssh prod.internal";
      }
      return "";
    };

    const sessions = await scanConnections({ runner });

    expect(requestedKeywords).toEqual(["etimes=", "etime="]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      kind: "ssh",
      target: "prod.internal",
      elapsedSeconds: 90,
      terminalName: "ttys000",
    });
  });

  it("batches lsof at 200 pids per invocation", async () => {
    const lsofCalls: string[] = [];
    const manyPids = Array.from({ length: 450 }, (_, index) => index + 1000);
    const ps =
      "  100     1 ??       800000 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal\n" +
      manyPids
        .map(
          (pid) =>
            `  ${pid}   100 ttys${String(pid % 100).padStart(3, "0")}      10 ssh host${pid}`,
        )
        .join("\n");
    const runner: CommandRunner = async (executable, args) => {
      if (executable === "/bin/ps") {
        return ps;
      }
      if (executable === "/usr/sbin/lsof") {
        if (args.includes("-i")) {
          lsofCalls.push(args[args.indexOf("-p") + 1] ?? "");
        }
        return "";
      }
      return "";
    };

    await scanConnections({ runner });

    expect(lsofCalls).toHaveLength(3);
    expect(lsofCalls[0]?.split(",")).toHaveLength(200);
    expect(lsofCalls[2]?.split(",")).toHaveLength(50);
  });
});

describe("shapeConnectionsPayload", () => {
  function makeSession(
    overrides: Partial<ConnectionSession>,
  ): ConnectionSession {
    return {
      id: "1:ttys000",
      pid: 1,
      tty: "ttys000",
      terminalName: "Terminal",
      kind: "other",
      title: "CLI",
      target: "zzz",
      subtitle: "",
      commandLine: "nc host 443",
      elapsedSeconds: 1,
      connections: [],
      ...overrides,
    };
  }

  it("sorts by kind then target and counts each kind", () => {
    const sessions = [
      makeSession({ id: "1", kind: "other", target: "nc" }),
      makeSession({ id: "2", kind: "agent", target: "app" }),
      makeSession({ id: "3", kind: "ssh", target: "z-host" }),
      makeSession({ id: "4", kind: "ssh", target: "a-host" }),
      makeSession({ id: "5", kind: "database", target: "db" }),
      makeSession({ id: "6", kind: "tunnel", target: "svc/web" }),
      makeSession({ id: "7", kind: "cloud", target: "prod" }),
    ];

    const payload = shapeConnectionsPayload(
      sessions,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(payload.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(payload.sessions.map((session) => session.id)).toEqual([
      "4",
      "3",
      "5",
      "6",
      "7",
      "2",
      "1",
    ]);
    expect(payload.counts).toEqual({
      total: 7,
      ssh: 2,
      database: 1,
      tunnel: 1,
      cloud: 1,
      agent: 1,
      other: 1,
    });
  });
});

describe("GET /api/connections", () => {
  const payloadFixture: ConnectionsPayload = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    counts: {
      total: 1,
      ssh: 1,
      database: 0,
      tunnel: 0,
      cloud: 0,
      agent: 0,
      other: 0,
    },
    sessions: [
      {
        id: "201:ttys000",
        pid: 201,
        tty: "ttys000",
        terminalName: "Terminal",
        kind: "ssh",
        title: "SSH",
        target: "deploy@db.internal",
        subtitle: "203.0.113.10:2222",
        commandLine: "ssh -p 2222 deploy@db.internal",
        elapsedSeconds: 3600,
        connections: [
          {
            local: "10.0.0.2:51000",
            remote: "203.0.113.10:2222",
            state: "ESTABLISHED",
          },
        ],
      },
    ],
  };

  it("returns 200 with the connections payload shape", async () => {
    getConnectionsPayloadMock.mockResolvedValue(payloadFixture);

    const response = await app.request("/api/connections");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      generatedAt: "2026-01-01T00:00:00.000Z",
      counts: { total: 1, ssh: 1 },
    });
    expect(body.sessions[0]).toMatchObject({
      pid: 201,
      kind: "ssh",
      title: "SSH",
      target: "deploy@db.internal",
      terminalName: "Terminal",
    });
    expect(getConnectionsPayloadMock).toHaveBeenCalledWith();
  });
});
