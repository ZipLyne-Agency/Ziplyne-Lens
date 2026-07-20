import { describe, expect, it } from "vitest";
import * as api from "../src/lib/api.js";

describe("desktop updater", () => {
  it("reports that browser-only builds do not support native updates", async () => {
    const checkForAppUpdate = (
      api as typeof api & {
        checkForAppUpdate?: () => Promise<{ status: string }>;
      }
    ).checkForAppUpdate;

    expect(checkForAppUpdate).toBeTypeOf("function");
    await expect(checkForAppUpdate?.()).resolves.toEqual({
      status: "unsupported",
    });
  });
});
