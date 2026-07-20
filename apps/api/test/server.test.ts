import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as appModule from "../src/app.js";

const { app } = appModule;

const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ZipLyne Lens API", () => {
  it("serves demo summary data", async () => {
    const response = await app.request("/api/demo-summary");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: "demo",
      scan: { scannedFiles: 0, errors: [] },
    });
  });

  it("rejects unsupported source filters", async () => {
    const response = await app.request(
      "/api/summary?sources=not-a-source&maxFiles=1",
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: "Invalid query" });
    expect(body.issues[0]).toMatchObject({
      message: "Sources must contain only claude, codex, kimi or grok.",
      path: ["sources"],
    });
  });

  it("serves redacted demo prompt library by default", async () => {
    const response = await app.request("/api/demo-prompts");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ mode: "demo" });
    expect(body.library.prompts.length).toBeGreaterThan(0);
    expect(body.library.prompts[0].privacy).toBe("redacted");
    expect(body.library.prompts[0].content).toBeUndefined();
  });

  it("rejects unsupported prompt source filters", async () => {
    const response = await app.request(
      "/api/prompts?sources=not-a-source&maxFiles=1",
    );

    expect(response.status).toBe(400);
  });

  it("returns the project config shape", async () => {
    const response = await app.request("/api/projects/config");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body.rules)).toBe(true);
    expect(typeof body.overrides).toBe("object");
    expect(typeof body.autoMatch).toBe("boolean");
  });

  it("rejects an invalid config payload", async () => {
    const response = await app.request("/api/projects/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoMatch: "yes-please" }),
    });

    expect(response.status).toBe(400);
  });

  it("preserves account and extension settings when saving project config", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "lens-config-test-"));
    scratchDirs.push(scratch);
    const configPath = join(scratch, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        accounts: [
          {
            label: "work",
            email: "developer@example.com",
            command: "claude-work",
            service: "Claude Code-credentials-work",
          },
        ],
        extensionSetting: { enabled: true },
      }),
      "utf8",
    );

    const saveProjectConfig = (
      appModule as typeof appModule & {
        saveProjectConfig?: (
          patch: { autoMatch?: boolean },
          path: string,
        ) => Promise<unknown>;
      }
    ).saveProjectConfig;
    expect(saveProjectConfig).toBeTypeOf("function");
    await saveProjectConfig?.({ autoMatch: false }, configPath);

    await expect(
      readFile(configPath, "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toMatchObject({
      accounts: [{ label: "work", service: "Claude Code-credentials-work" }],
      extensionSetting: { enabled: true },
      autoMatch: false,
    });
  });

  it("requires a path to reveal", async () => {
    const response = await app.request("/api/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it("refuses to reveal a path outside the home directory", async () => {
    const response = await app.request("/api/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/etc" }),
    });

    expect(response.status).toBe(403);
  });

  it("requires a projectId to clean", async () => {
    const response = await app.request("/api/projects/clean", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it("reports git tooling status", async () => {
    const response = await app.request("/api/git/status");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(typeof body.installed).toBe("boolean");
    expect(typeof body.authenticated).toBe("boolean");
  });
});
