// Short-TTL cache + in-flight dedupe for local log scans.
//
// Every dashboard poll used to trigger a full re-read of up to 1,500 log
// files, and concurrent consumers (summary, prompts, limits burn) each ran
// their own scan. On machines with large histories a scan can outlast the
// client's 15s refresh tick, so the client kept cancelling and restarting
// scans and the dashboard never left its loading state.
//
// Wrapping a scan with this cache makes concurrent callers share one
// in-flight promise and lets fresh results be reused for `ttlMs`, so polls
// are cheap and a slow first scan converges instead of looping.

type ScanCacheEntry<TResult> = {
  // Infinity while the scan is in flight — concurrent callers always share
  // it. Set to Date.now() + ttl when the scan resolves, so the freshness
  // window starts at completion, not at kickoff.
  expiresAt: number;
  value: Promise<TResult>;
};

const MAX_ENTRIES = 32;

export function createScanCache<TArgs, TResult>(
  ttlMs: number,
  scan: (args: TArgs) => Promise<TResult>,
  keyOf: (args: TArgs) => string,
): (args: TArgs) => Promise<TResult> {
  const entries = new Map<string, ScanCacheEntry<TResult>>();

  return (args) => {
    const now = Date.now();
    const key = keyOf(args);
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.value;
    }

    const value = Promise.resolve().then(() => scan(args));
    const entry: ScanCacheEntry<TResult> = {
      expiresAt: Number.POSITIVE_INFINITY,
      value,
    };
    value.then(
      () => {
        if (entries.get(key)?.value === value) {
          entry.expiresAt = Date.now() + ttlMs;
        }
      },
      // Failed scans are never cached; the next caller retries immediately.
      () => {
        if (entries.get(key)?.value === value) {
          entries.delete(key);
        }
      },
    );
    entries.set(key, entry);

    if (entries.size > MAX_ENTRIES) {
      for (const [entryKey, existing] of entries) {
        if (existing.expiresAt <= now) {
          entries.delete(entryKey);
        }
      }
    }

    return value;
  };
}
