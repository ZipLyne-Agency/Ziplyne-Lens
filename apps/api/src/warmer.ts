// Background cache warmer.
//
// Every dashboard screen should render from a warm cache, never wait on a
// scan. The warmer runs immediately at server start and then on a timer:
//   - fast pass (60s): the endpoints behind the default view and every
//     secondary screen — summary/prompt scans (via their cached wrappers),
//     limits, live sessions, connections, tools, projects.
//   - slow pass (10min): the all-time scan, the most expensive request the
//     app can make.
// Each payload type has its own TTL cache, so passes are no-ops while
// everything is fresh. Every task is settled individually: a failing probe
// must never take the warmer (or the server) down.

import { warmAllTimeCaches, warmSummaryCaches } from "./app.js";
import { getConnectionsPayload } from "./connections.js";
import { getToolsPayload } from "./inventory.js";
import { buildLimitsPayload } from "./limits.js";
import { getLiveSessionsPayload } from "./live.js";
import { getProjectsPayload } from "./projects.js";

const DEFAULT_FAST_INTERVAL_MS = 60_000;
const DEFAULT_SLOW_INTERVAL_MS = 10 * 60_000;

export function startWarmer(
  fastIntervalMs = DEFAULT_FAST_INTERVAL_MS,
  slowIntervalMs = DEFAULT_SLOW_INTERVAL_MS,
): () => void {
  const fast = () => {
    void warmFastPass();
  };
  const slow = () => {
    void warmAllTimeCaches();
  };
  // Boot pass: start warming immediately, in parallel with the first request.
  fast();
  slow();
  const fastTimer = setInterval(fast, fastIntervalMs);
  const slowTimer = setInterval(slow, slowIntervalMs);
  fastTimer.unref();
  slowTimer.unref();
  return () => {
    clearInterval(fastTimer);
    clearInterval(slowTimer);
  };
}

async function warmFastPass(): Promise<void> {
  await Promise.allSettled([
    warmSummaryCaches(),
    buildLimitsPayload(),
    getLiveSessionsPayload({ includeTranscripts: false }),
    getConnectionsPayload(),
    getToolsPayload(),
    getProjectsPayload(),
  ]);
}
