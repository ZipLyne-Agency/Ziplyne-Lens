import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/inventory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/inventory.js")>();
  return { ...actual, getToolsPayload: vi.fn() };
});

import { app } from "../src/app.js";
import {
  buildMergedRegistry,
  buildToolsPayload,
  type CLIRegistryDefinition,
  candidateCredentialPaths,
  computeSearchPaths,
  firstExistingCredentialPath,
  getToolsPayload,
  type InventoryDeps,
  loadMergedRegistry,
  scanCredentialExpiries,
  scanInventory,
  type ToolsPayload,
  urgencyFor,
} from "../src/inventory.js";

const getToolsPayloadMock = vi.mocked(getToolsPayload);

const tmpRoots: string[] = [];

afterEach(async () => {
  getToolsPayloadMock.mockReset();
  await Promise.all(
    tmpRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeTmpHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inventory-test-"));
  tmpRoots.push(root);
  return root;
}

async function makeExecutable(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function writeText(path: string, contents: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
}

function makeDeps(
  home: string,
  overrides: Partial<InventoryDeps> = {},
): InventoryDeps {
  return {
    home,
    env: {},
    now: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeDefinition(
  overrides: Partial<CLIRegistryDefinition> = {},
): CLIRegistryDefinition {
  return {
    executables: ["mycli"],
    title: "My CLI",
    kind: "cloud",
    contextFlags: [],
    credentialPaths: [],
    ...overrides,
  };
}

describe("buildMergedRegistry", () => {
  it("dedupes by executable and keeps the richer built-in metadata", () => {
    const registry = buildMergedRegistry([
      [
        makeDefinition({
          executables: ["aws"],
          title: "AWS CLI",
          kind: "cloud",
          credentialPaths: ["~/.aws/credentials"],
        }),
      ],
      // Later catalogs describe the same executable with a bare-executable
      // title and generic kind: those must not clobber the built-in metadata.
      [makeDefinition({ executables: ["aws"], title: "aws", kind: "generic" })],
    ]);

    const def = registry.byExecutable.get("aws");
    expect(def?.title).toBe("AWS CLI");
    expect(def?.kind).toBe("cloud");
    expect(def?.credentialPaths).toEqual(["~/.aws/credentials"]);
    expect(registry.definitions).toHaveLength(1);
  });

  it("lets richer later definitions win and merges executables", () => {
    const registry = buildMergedRegistry([
      [makeDefinition({ executables: ["fly"], title: "fly", kind: "generic" })],
      [
        makeDefinition({
          executables: ["flyctl"],
          title: "Fly.io CLI",
          kind: "cloud",
          credentialPaths: ["~/.fly/config.yml"],
        }),
        // A second entry sharing an executable merges both name lists.
        makeDefinition({
          executables: ["fly", "flyctl"],
          title: "fly-cli",
          kind: "generic",
        }),
      ],
    ]);

    const def = registry.byExecutable.get("fly");
    expect(def?.title).toBe("Fly.io CLI");
    expect(def?.kind).toBe("cloud");
    expect(def?.credentialPaths).toEqual(["~/.fly/config.yml"]);
    expect(def?.executables).toEqual(["fly", "flyctl"]);
    expect(registry.byExecutable.get("flyctl")).toBe(def);
    expect(registry.definitions).toHaveLength(1);
  });
});

describe("loadMergedRegistry", () => {
  it("merges built-ins, the user file and sorted Registries dir files", async () => {
    const home = await makeTmpHome();
    const sesshy = join(home, "Library", "Application Support", "Sesshy");
    await writeJson(join(sesshy, "CLIRegistry.json"), {
      tools: [
        {
          executables: ["aws"],
          title: "aws",
          kind: "generic",
          credentialPaths: ["~/.custom/aws-creds"],
        },
      ],
    });
    await writeJson(join(sesshy, "Registries", "20-b.json"), {
      tools: [{ executables: ["btool"], title: "B Tool", kind: "cloud" }],
    });
    await writeJson(join(sesshy, "Registries", "10-a.json"), {
      tools: [{ executables: ["atool"], title: "A Tool", kind: "agent" }],
    });
    await writeJson(join(sesshy, "Registries", "30-bad-shape.json"), {
      notTools: [],
    });
    await mkdir(join(sesshy, "Registries"), { recursive: true });
    await writeFile(join(sesshy, "Registries", "40-broken.json"), "{ not json");

    const registry = await loadMergedRegistry(makeDeps(home));

    // Built-in survives: the user file's low-info title yields, but its
    // non-empty credentialPaths win over the built-in ones.
    const aws = registry.byExecutable.get("aws");
    expect(aws?.title).toBe("AWS CLI");
    expect(aws?.kind).toBe("cloud");
    expect(aws?.credentialPaths).toEqual(["~/.custom/aws-creds"]);
    expect(registry.byExecutable.get("atool")?.kind).toBe("agent");
    expect(registry.byExecutable.get("btool")?.kind).toBe("cloud");
    // 30 built-ins + 2 catalog tools; the two malformed files are skipped.
    expect(registry.definitions).toHaveLength(32);
  });

  it("skips registry files larger than 8MB", async () => {
    const home = await makeTmpHome();
    const sesshy = join(home, "Library", "Application Support", "Sesshy");
    await mkdir(join(sesshy, "Registries"), { recursive: true });
    const big = `${JSON.stringify({ tools: [{ executables: ["bigtool"], title: "Big" }] })}${" ".repeat(8 * 1024 * 1024)}`;
    await writeFile(join(sesshy, "Registries", "10-big.json"), big);

    const registry = await loadMergedRegistry(makeDeps(home));
    expect(registry.byExecutable.has("bigtool")).toBe(false);
  });

  it("falls back to built-ins alone when nothing exists on disk", async () => {
    const home = await makeTmpHome();
    const registry = await loadMergedRegistry(makeDeps(home));
    expect(registry.definitions).toHaveLength(30);
    expect(registry.byExecutable.get("gh")?.title).toBe("GitHub CLI");
  });
});

describe("candidateCredentialPaths", () => {
  it("orders ecosystem paths, then env vars, then generic config paths", () => {
    const candidates = candidateCredentialPaths("aws");
    expect(candidates[0]).toBe("~/.aws/credentials");
    expect(candidates).toContain("env:AWS_ACCESS_KEY_ID");
    expect(candidates).toContain("env:AWS_API_KEY");
    expect(candidates.indexOf("env:AWS_ACCESS_KEY_ID")).toBeLessThan(
      candidates.indexOf("env:AWS_API_KEY"),
    );
    expect(candidates.indexOf("env:AWS_API_KEY")).toBeLessThan(
      candidates.indexOf("~/.config/aws/credentials"),
    );
  });

  it("normalizes suffixed and camelCase executable names", () => {
    expect(candidateCredentialPaths("sentry-cli")[0]).toBe("~/.sentry/cli.db");
    expect(candidateCredentialPaths("mytool")).toContain("env:MYTOOL_TOKEN");
    expect(candidateCredentialPaths("mytool")).toContain("~/.mytool/token");
  });
});

describe("credential evidence resolution order", () => {
  it("resolves registry > heuristic > env > generic", async () => {
    const home = await makeTmpHome();
    const bin = join(home, "bin");
    await makeExecutable(join(bin, "mycli"));
    const deps = makeDeps(home, { searchPaths: [bin] });
    const registry = buildMergedRegistry([
      [
        makeDefinition({
          credentialPaths: ["~/.custom/creds"],
        }),
      ],
    ]);

    // (a) registry credentialPaths win over everything else.
    await writeJson(join(home, ".custom", "creds"), {});
    await writeJson(join(home, ".config", "mycli", "auth.json"), {});
    let tools = await scanInventory(deps, registry);
    expect(tools[0]?.credentialPath).toBe("~/.custom/creds");
    expect(tools[0]?.state).toBe("loggedIn");

    // (b) generic heuristic config path when no registry path exists.
    await rm(join(home, ".custom", "creds"));
    tools = await scanInventory(deps, registry);
    expect(tools[0]?.credentialPath).toBe("~/.config/mycli/auth.json");

    // (c) env evidence (from an rc file) beats generic file guesses.
    await rm(join(home, ".config", "mycli", "auth.json"));
    await writeFile(join(home, ".zshrc"), "export MYCLI_API_KEY=secret\n");
    await writeJson(join(home, ".mycli", "token"), {});
    tools = await scanInventory(deps, registry);
    expect(tools[0]?.credentialPath).toBe("env:MYCLI_API_KEY");

    // (d) generic ~/.<name> guess is the last resort.
    await writeFile(join(home, ".zshrc"), "# nothing here\n");
    tools = await scanInventory(deps, registry);
    expect(tools[0]?.credentialPath).toBe("~/.mycli/token");
  });

  it("considers only env: evidence when the CLI is not installed", async () => {
    const home = await makeTmpHome();
    // A credential file exists, but the binary does not: file heuristics are
    // excluded for uninstalled registry entries, so this stays absent...
    await writeJson(join(home, ".config", "mycli", "auth.json"), {});
    const deps = makeDeps(home, { searchPaths: [join(home, "bin")] });
    const registry = buildMergedRegistry([[makeDefinition()]]);
    let tools = await scanInventory(deps, registry);
    expect(tools).toHaveLength(0);

    // ...while env evidence still marks the CLI as logged in.
    await writeFile(join(home, ".zshrc"), "export MYCLI_TOKEN=abc\n");
    tools = await scanInventory(deps, registry);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.state).toBe("loggedIn");
    expect(tools[0]?.credentialPath).toBe("env:MYCLI_TOKEN");
    expect(tools[0]?.installedPath).toBeUndefined();
  });
});

describe("env evidence from shell rc files", () => {
  it("detects export, plain and fish assignments, ignoring comments", async () => {
    const home = await makeTmpHome();
    await writeFile(
      join(home, ".zshrc"),
      [
        "# export COMMENTED_API_KEY=nope",
        "export PLAIN_EXPORT_TOKEN=abc",
        "PLAIN_ASSIGN_ACCESS_TOKEN=abc",
        'if [ -n "$FOO" ]; then # code with = signs',
        "fi",
      ].join("\n"),
    );
    await mkdir(join(home, ".config", "fish"), { recursive: true });
    await writeFile(
      join(home, ".config", "fish", "config.fish"),
      "set -gx FISH_TOKEN abc\n",
    );
    const deps = makeDeps(home);

    await expect(
      firstExistingCredentialPath(["env:PLAIN_EXPORT_TOKEN"], deps),
    ).resolves.toBe("env:PLAIN_EXPORT_TOKEN");
    await expect(
      firstExistingCredentialPath(["env:PLAIN_ASSIGN_ACCESS_TOKEN"], deps),
    ).resolves.toBe("env:PLAIN_ASSIGN_ACCESS_TOKEN");
    await expect(
      firstExistingCredentialPath(["env:FISH_TOKEN"], deps),
    ).resolves.toBe("env:FISH_TOKEN");
    await expect(
      firstExistingCredentialPath(["env:COMMENTED_API_KEY"], deps),
    ).resolves.toBeUndefined();
  });

  it("treats a non-empty process env value as evidence", async () => {
    const home = await makeTmpHome();
    const deps = makeDeps(home, { env: { OPENAI_API_KEY: "sk-test" } });
    await expect(
      firstExistingCredentialPath(["env:OPENAI_API_KEY"], deps),
    ).resolves.toBe("env:OPENAI_API_KEY");
    await expect(
      firstExistingCredentialPath(
        ["env:EMPTY_KEY"],
        makeDeps(home, { env: { EMPTY_KEY: "" } }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("computeSearchPaths", () => {
  it("discovers dirs from rc PATH lines, install roots, globs and npmrc", async () => {
    const home = await makeTmpHome();
    await writeFile(
      join(home, ".zshrc"),
      [
        'export PATH="$HOME/custom-bin:$PATH"',
        'export NVM_DIR="$HOME/.nvm"',
        'export PNPM_HOME="$HOME/.pnpm-home"',
      ].join("\n"),
    );
    await writeFile(join(home, ".npmrc"), "prefix=$HOME/.npm-prefix\n");
    await mkdir(join(home, ".nvm", "versions", "node", "v20.0.0", "bin"), {
      recursive: true,
    });
    await mkdir(join(home, "go"), { recursive: true });
    await mkdir(join(home, ".config", "go"), { recursive: true });
    await writeFile(
      join(home, ".config", "go", "env"),
      `GOPATH=${join(home, "go")}\n`,
    );

    const paths = await computeSearchPaths(makeDeps(home, { env: {} }));

    expect(paths).toContain(join(home, "custom-bin"));
    expect(paths).toContain(
      join(home, ".nvm", "versions", "node", "v20.0.0", "bin"),
    );
    expect(paths).toContain(join(home, ".pnpm-home"));
    expect(paths).toContain(join(home, ".npm-prefix", "bin"));
    expect(paths).toContain(join(home, "go", "bin"));
    expect(paths).toContain(join(home, ".local", "bin"));
    expect(paths).not.toContain("/usr/bin");
  });
});

describe("scanInventory classification", () => {
  it("classifies registry vs discovered and filters non-executables", async () => {
    const home = await makeTmpHome();
    const bin = join(home, "bin");
    await makeExecutable(join(bin, "aws"));
    await makeExecutable(join(bin, "mytool"));
    await makeExecutable(join(bin, "plain-tool"));
    await writeFile(join(bin, "not-executable"), "text");
    await makeExecutable(join(bin, ".hidden"));

    await writeText(join(home, ".aws", "credentials"), "[default]\n");
    await writeJson(join(home, ".config", "mytool", "token"), {});

    const deps = makeDeps(home, { searchPaths: [bin] });
    const registry = buildMergedRegistry([
      [
        makeDefinition({
          executables: ["aws"],
          title: "AWS CLI",
          kind: "cloud",
          credentialPaths: ["~/.aws/credentials"],
        }),
        // gh is neither installed nor logged in: it must not appear.
        makeDefinition({
          executables: ["gh"],
          title: "GitHub CLI",
          kind: "cloud",
        }),
      ],
    ]);

    const tools = await scanInventory(deps, registry);
    const byName = new Map(tools.map((tool) => [tool.executable, tool]));

    const aws = byName.get("aws");
    expect(aws?.source).toBe("registry");
    expect(aws?.state).toBe("loggedIn");
    expect(aws?.kind).toBe("cloud");
    expect(aws?.credentialPath).toBe("~/.aws/credentials");
    expect(aws?.installedPath).toBe(join(bin, "aws"));

    const mytool = byName.get("mytool");
    expect(mytool?.source).toBe("discovered");
    expect(mytool?.state).toBe("loggedIn");
    expect(mytool?.kind).toBe("generic");

    const plain = byName.get("plain-tool");
    expect(plain?.source).toBe("discovered");
    expect(plain?.state).toBe("installed");
    expect(plain?.credentialPath).toBeUndefined();

    expect(byName.has("gh")).toBe(false);
    expect(byName.has("not-executable")).toBe(false);
    expect(byName.has(".hidden")).toBe(false);

    // loggedIn first, then title.
    expect(tools.map((tool) => tool.state)).toEqual([
      "loggedIn",
      "loggedIn",
      "installed",
    ]);
    expect(tools.map((tool) => tool.executable)).toEqual([
      "aws",
      "mytool",
      "plain-tool",
    ]);
  });
});

describe("credential expiry", () => {
  it("assigns urgency tiers", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    expect(urgencyFor(now, new Date("2025-12-31T12:00:00.000Z"))).toBe(
      "expired",
    );
    expect(urgencyFor(now, new Date("2026-01-01T12:00:00.000Z"))).toBe(
      "expired",
    );
    expect(urgencyFor(now, new Date("2026-01-01T12:10:00.000Z"))).toBe(
      "imminent",
    );
    expect(urgencyFor(now, new Date("2026-01-01T12:30:00.000Z"))).toBe("soon");
    expect(urgencyFor(now, new Date("2026-01-01T13:30:00.000Z"))).toBe("ok");
  });

  it("scans aws sso, gcloud adc and vercel auth.json", async () => {
    const home = await makeTmpHome();
    const now = new Date("2026-01-01T12:00:00.000Z");
    await writeJson(join(home, ".aws", "sso", "cache", "a.json"), {
      expiresAt: "2025-12-31T11:00:00Z",
      startUrl: "https://example.awsapps.com/start",
    });
    await writeJson(join(home, ".aws", "sso", "cache", "b.json"), {
      expiresAt: "2026-01-01T12:10:00Z",
      accountId: "123456789012",
    });
    // Malformed and oversized entries are skipped.
    await writeFile(
      join(home, ".aws", "sso", "cache", "broken.json"),
      "{ nope",
    );
    await writeFile(
      join(home, ".aws", "sso", "cache", "huge.json"),
      `{"expiresAt":"2026-01-02T00:00:00Z"${" ".repeat(1_000_001)}}`,
    );
    await writeJson(
      join(home, ".config", "gcloud", "application_default_credentials.json"),
      { token_expiry: "2026-01-01T12:30:00Z", account: "me@example.com" },
    );
    await writeJson(join(home, ".config", "com.vercel.cli", "auth.json"), {
      expiresAt: Date.parse("2026-01-01T14:00:00Z"),
      user: "vercel-user",
    });

    const records = await scanCredentialExpiries(makeDeps(home, { now }));

    expect(records).toHaveLength(4);
    // Sorted by expiry time (which is also urgency order).
    expect(records.map((record) => record.urgency)).toEqual([
      "expired",
      "imminent",
      "soon",
      "ok",
    ]);
    expect(records[0]).toMatchObject({
      provider: "aws",
      label: "https://example.awsapps.com/start",
      evidencePath: join(home, ".aws", "sso", "cache", "a.json"),
    });
    expect(records[1]).toMatchObject({
      provider: "aws",
      label: "123456789012",
    });
    expect(records[2]).toMatchObject({
      provider: "gcloud",
      label: "me@example.com",
    });
    expect(records[3]).toMatchObject({
      provider: "vercel",
      label: "vercel-user",
    });
  });

  it("prefers the Application Support vercel auth.json", async () => {
    const home = await makeTmpHome();
    const now = new Date("2026-01-01T12:00:00.000Z");
    await writeJson(
      join(
        home,
        "Library",
        "Application Support",
        "com.vercel.cli",
        "auth.json",
      ),
      { expiresAt: Date.parse("2026-01-01T12:05:00Z"), user: "primary" },
    );
    await writeJson(join(home, ".config", "com.vercel.cli", "auth.json"), {
      expiresAt: Date.parse("2026-01-01T13:00:00Z"),
      user: "secondary",
    });

    const records = await scanCredentialExpiries(makeDeps(home, { now }));
    expect(records).toHaveLength(1);
    expect(records[0]?.label).toBe("primary");
    expect(records[0]?.urgency).toBe("imminent");
  });

  it("treats vercel expiresAt as epoch seconds when the value is too small for ms", async () => {
    const home = await makeTmpHome();
    const now = new Date("2026-01-01T12:00:00.000Z");
    await writeJson(join(home, ".config", "com.vercel.cli", "auth.json"), {
      // Real auth.json files store seconds (e.g. 1784398812), not ms.
      expiresAt: Date.parse("2026-01-01T14:00:00Z") / 1000,
      user: "vercel-user",
    });

    const records = await scanCredentialExpiries(makeDeps(home, { now }));
    expect(records[0]?.expiresAt).toBe("2026-01-01T14:00:00.000Z");
    expect(records[0]?.urgency).toBe("ok");
  });
});

describe("buildToolsPayload", () => {
  it("reports counts and sorted tools", async () => {
    const home = await makeTmpHome();
    const bin = join(home, "bin");
    await makeExecutable(join(bin, "aws"));
    await makeExecutable(join(bin, "plain-tool"));
    await writeText(join(home, ".aws", "credentials"), "[default]\n");
    await writeJson(join(home, ".aws", "sso", "cache", "a.json"), {
      expiresAt: "2026-01-01T00:10:00Z",
    });

    const payload = await buildToolsPayload(
      makeDeps(home, { searchPaths: [bin] }),
    );

    expect(payload.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(payload.counts.total).toBe(2);
    expect(payload.counts.loggedIn).toBe(1);
    expect(payload.counts.installed).toBe(1);
    expect(payload.counts.discovered).toBe(1);
    expect(payload.tools[0]?.executable).toBe("aws");
    expect(payload.tools[0]?.state).toBe("loggedIn");
    expect(payload.expiring).toHaveLength(1);
    expect(payload.expiring[0]?.urgency).toBe("imminent");
    expect(payload.expiring[0]?.provider).toBe("aws");
  });
});

describe("GET /api/tools", () => {
  it("returns the inventory payload", async () => {
    const payload: ToolsPayload = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      counts: { total: 1, loggedIn: 1, installed: 0, discovered: 0 },
      tools: [
        {
          executable: "aws",
          title: "AWS CLI",
          kind: "cloud",
          state: "loggedIn",
          source: "registry",
          installedPath: "/opt/homebrew/bin/aws",
          credentialPath: "~/.aws/credentials",
        },
      ],
      expiring: [],
    };
    getToolsPayloadMock.mockResolvedValue(payload);

    const response = await app.request("/api/tools");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
  });
});
