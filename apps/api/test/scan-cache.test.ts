import { describe, expect, it, vi } from "vitest";
import { createScanCache } from "../src/scan-cache.js";

const keyOf = (args: { id: string }) => args.id;

describe("createScanCache", () => {
  it("reuses fresh results for the same key", async () => {
    const scan = vi.fn(async ({ id }: { id: string }) => ({ id, n: 1 }));
    const cached = createScanCache(60_000, scan, keyOf);

    const first = await cached({ id: "a" });
    const second = await cached({ id: "a" });

    expect(first).toEqual({ id: "a", n: 1 });
    expect(second).toEqual({ id: "a", n: 1 });
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight scan between concurrent callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scan = vi.fn(async ({ id }: { id: string }) => {
      await gate;
      return { id, n: 1 };
    });
    const cached = createScanCache(60_000, scan, keyOf);

    const pending = [
      cached({ id: "a" }),
      cached({ id: "a" }),
      cached({ id: "a" }),
    ];
    release();
    const results = await Promise.all(pending);

    expect(results).toHaveLength(3);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("treats different keys independently", async () => {
    const scan = vi.fn(async ({ id }: { id: string }) => ({ id, n: 1 }));
    const cached = createScanCache(60_000, scan, keyOf);

    await cached({ id: "a" });
    await cached({ id: "b" });

    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("re-scans after the TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const scan = vi.fn(async ({ id }: { id: string }) => ({ id, n: 1 }));
      const cached = createScanCache(1_000, scan, keyOf);

      await cached({ id: "a" });
      vi.advanceTimersByTime(1_500);
      await cached({ id: "a" });

      expect(scan).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never caches failures — the next call retries", async () => {
    const scan = vi
      .fn<(args: { id: string }) => Promise<{ id: string }>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ id: "a" });
    const cached = createScanCache(60_000, scan, keyOf);

    await expect(cached({ id: "a" })).rejects.toThrow("boom");
    await expect(cached({ id: "a" })).resolves.toEqual({ id: "a" });
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
