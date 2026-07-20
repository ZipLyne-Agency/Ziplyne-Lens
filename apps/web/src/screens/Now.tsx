import type { LensSummary } from "@ziplyne/core/browser";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Moon,
  Radio,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { ProgressBar, severityClass } from "../components/ProgressBar.js";
import { EmptyState, ErrorBanner } from "../components/States.js";
import { Toggle } from "../components/Toggle.js";
import { Panel, WorkspaceHeader } from "../components/Workspace.js";
import {
  type AccountUsageRow,
  type ConnectionKind,
  type ConnectionsPayload,
  dismissEndedSession,
  type EndedSession,
  fetchConnections,
  fetchLimits,
  fetchLiveSessions,
  type LimitsPayload,
  type LiveSession,
  type LiveSessionsResponse,
} from "../lib/api.js";
import { periodSums } from "../lib/derive.js";
import {
  agentLabel,
  formatCurrency,
  formatDuration,
  formatTokens,
  providerBadgeClass,
  relativeTime,
  sourceAccent,
} from "../lib/format.js";
import { readTranscriptOptIn, writeTranscriptOptIn } from "../lib/prefs.js";

const LIVE_POLL_MS = 3_000;
const CONNECTIONS_POLL_MS = 5_000;
const SLOW_POLL_MS = 60_000;

const KIND_LABEL: Record<ConnectionKind, string> = {
  ssh: "SSH",
  database: "DB",
  tunnel: "Tunnel",
  cloud: "Cloud",
  agent: "Agent",
  other: "Other",
};

const KIND_COLOR: Record<ConnectionKind, string> = {
  ssh: "var(--warn)",
  database: "var(--info)",
  tunnel: "var(--agent-kimi)",
  cloud: "var(--brand)",
  agent: "var(--ok)",
  other: "var(--t3)",
};

// Generic recursive-timeout poller: never stacks overlapping requests, stops
// when the workspace unmounts.
function usePoller<T>(
  load: () => Promise<T | undefined>,
  intervalMs: number,
  deps: readonly unknown[],
): T | undefined {
  const [payload, setPayload] = useState<T | undefined>();
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      const next = await load();
      inFlight = false;
      if (cancelled) {
        return;
      }
      if (next !== undefined) {
        setPayload(next);
      }
      timer = window.setTimeout(() => void tick(), intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's poll inputs
  }, deps);
  return payload;
}

export function Now({ summary }: { summary: LensSummary }) {
  const [transcripts, setTranscripts] = useState(readTranscriptOptIn);
  // Bumped by every retry/dismiss to make all pollers refetch immediately.
  const [nonce, setNonce] = useState(0);
  const retry = () => setNonce((n) => n + 1);

  const live = usePoller<LiveSessionsResponse>(
    () => fetchLiveSessions({ transcripts }),
    LIVE_POLL_MS,
    [transcripts, nonce],
  );
  const limits = usePoller<LimitsPayload>(fetchLimits, SLOW_POLL_MS, [nonce]);
  const connections = usePoller<ConnectionsPayload>(
    fetchConnections,
    CONNECTIONS_POLL_MS,
    [nonce],
  );

  const periods = useMemo(() => periodSums(summary.days), [summary.days]);

  const sessions = live?.sessions ?? [];
  const running = useMemo(
    () => sessions.filter((session) => session.state === "Working"),
    [sessions],
  );
  const waiting = useMemo(
    () => sessions.filter((session) => session.state === "Needs Attention"),
    [sessions],
  );
  const idle = useMemo(
    () =>
      sessions.filter(
        (session) => session.state === "Quiet" || session.state === "Unknown",
      ),
    [sessions],
  );

  const ended = useMemo(
    () =>
      [...(live?.ended ?? [])].sort((a, b) =>
        b.endedAt.localeCompare(a.endedAt),
      ),
    [live],
  );

  const endedToday = useMemo(() => {
    const today = new Date().toDateString();
    return ended.filter(
      (session) => new Date(session.endedAt).toDateString() === today,
    ).length;
  }, [ended]);

  const agentBurn = useMemo(() => {
    if (limits?.agents && limits.agents.length > 0) {
      return limits.agents.map((agent) => ({
        source: agent.source,
        costUsd: agent.todayCostUsd,
      }));
    }
    // Fallback (demo / limits offline): range totals per agent from the summary.
    return summary.sources.map((row) => ({
      source: row.source,
      costUsd: row.costUsd,
    }));
  }, [limits, summary.sources]);

  // Per-profile Claude spend ("default", "azl", "izl", …). Only meaningful
  // when the Mac actually runs more than one profile.
  const claudeAccounts = useMemo(() => {
    const accounts = limits?.agents?.find(
      (agent) => agent.source === "claude",
    )?.accounts;
    return accounts && accounts.length > 1 ? accounts : [];
  }, [limits]);

  const kindChips = useMemo(() => {
    const counts = connections?.counts;
    if (!counts) {
      return [];
    }
    return (Object.keys(KIND_LABEL) as ConnectionKind[])
      .map((kind) => ({ kind, count: counts[kind] ?? 0 }))
      .filter((entry) => entry.count > 0);
  }, [connections]);

  // "Most recent" = shortest elapsed: the connection started most recently.
  const recentConnections = useMemo(
    () =>
      [...(connections?.sessions ?? [])]
        .filter((session) => session.kind !== "agent")
        .sort((a, b) => a.elapsedSeconds - b.elapsedSeconds)
        .slice(0, 3),
    [connections],
  );

  const dismiss = async (id: string) => {
    await dismissEndedSession(id);
    retry();
  };

  const subtitle = live
    ? `${live.counts.working} running · ${live.counts.needsAttention} waiting · ${endedToday} ended`
    : "Local service offline — showing spend data only";

  return (
    <div className="workspace">
      <WorkspaceHeader title="Now" subtitle={subtitle}>
        <span
          className="header-toggle"
          title="Reads the last lines of Terminal.app tabs locally via AppleScript. Nothing leaves this Mac."
        >
          Transcripts
          <Toggle
            on={transcripts}
            onChange={(next) => {
              setTranscripts(next);
              writeTranscriptOptIn(next);
            }}
            label="Include Terminal.app transcripts"
          />
        </span>
      </WorkspaceHeader>

      <div
        className={
          waiting.length > 0 ? "content now-grid attention" : "content now-grid"
        }
      >
        {/* ---- Top strip: Today / Quotas / Connections ---- */}
        <div className="now-top">
          <Panel label="Today" flush>
            <div className="today-hero">
              <div className="today-cost">
                {formatCurrency(periods.today?.costUsd ?? 0)}
              </div>
              <div className="today-sub tnum">
                {formatTokens(periods.today?.totalTokens ?? 0)} tokens today
              </div>
            </div>
            <div className="today-agents">
              {agentBurn.map((agent) => (
                <Fragment key={agent.source}>
                  <div className="agent-mini">
                    <span
                      className="dot"
                      style={{ background: sourceAccent(agent.source) }}
                    />
                    <span className="name">{agentLabel(agent.source)}</span>
                    <span className="cost">
                      {formatCurrency(agent.costUsd)}
                    </span>
                  </div>
                  {agent.source === "claude"
                    ? claudeAccounts.map((account) => (
                        <div className="agent-mini sub" key={account.account}>
                          <span className="name">{account.account}</span>
                          <span className="cost">
                            {formatCurrency(account.todayCostUsd)}
                          </span>
                        </div>
                      ))
                    : null}
                </Fragment>
              ))}
            </div>
          </Panel>

          <Panel
            label="Quotas"
            action={
              limits?.bestAccount ? (
                <span
                  className={`tag ${severityClass(limits.bestAccount.severity)}`}
                >
                  Best: {limits.bestAccount.label}
                </span>
              ) : undefined
            }
          >
            {!limits ? (
              <div className="quota-list">
                <ErrorBanner
                  message="Quota data is read from this Mac's keychain by the local service."
                  onRetry={retry}
                />
              </div>
            ) : limits.accounts.length === 0 ? (
              <div className="center-muted">
                No Claude accounts configured on this Mac.
              </div>
            ) : (
              <div className="quota-list">
                {limits.accounts.map((account) => (
                  <QuotaRow key={account.label} account={account} />
                ))}
              </div>
            )}
          </Panel>

          <Panel label="Connections" count={connections?.counts.total}>
            {!connections ? (
              <div className="quota-list">
                <ErrorBanner
                  message="Connections are read from this Mac's terminals by the local service."
                  onRetry={retry}
                />
              </div>
            ) : kindChips.length === 0 ? (
              <div className="center-muted">
                No remote connections right now.
              </div>
            ) : (
              <>
                <div className="conn-chips">
                  {kindChips.map((entry) => (
                    <span
                      key={entry.kind}
                      className="pbadge"
                      style={{ color: KIND_COLOR[entry.kind] }}
                    >
                      {KIND_LABEL[entry.kind]} {entry.count}
                    </span>
                  ))}
                </div>
                <div className="conn-list">
                  {recentConnections.length === 0 ? (
                    <div className="center-muted">
                      Only agent sessions are connected.
                    </div>
                  ) : (
                    recentConnections.map((session) => (
                      <div className="conn-row" key={session.id}>
                        <span className="conn-title">{session.title}</span>
                        <span className="conn-target" title={session.target}>
                          {session.target}
                        </span>
                        <span className="conn-elapsed tnum">
                          {formatDuration(session.elapsedSeconds * 1000)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </Panel>
        </div>

        {/* ---- Attention strip (only when something waits on you) ---- */}
        {waiting.length > 0 ? (
          <div className="attention-strip" role="status">
            <AlertTriangle size={13} aria-hidden="true" />
            <span>
              {waiting.length} need attention — {waiting[0]?.projectName}:{" "}
              {waiting[0]?.reason}
            </span>
          </div>
        ) : null}

        {/* ---- Kanban ---- */}
        <div className="kanban-grid">
          <KanbanColumn
            label="Running"
            count={live ? running.length : undefined}
            offline={!live}
            onRetry={retry}
            empty={
              <EmptyState icon={<Radio size={18} />} title="No running agents">
                Start Claude Code, Codex, Kimi, or Grok in a terminal on this
                Mac and it appears here within seconds.
              </EmptyState>
            }
          >
            {running.map((session) => (
              <SessionCard key={session.id} session={session} tone="ok" />
            ))}
          </KanbanColumn>

          <KanbanColumn
            label="Waiting for input"
            count={live ? waiting.length : undefined}
            attention={waiting.length > 0}
            offline={!live}
            onRetry={retry}
            empty={
              <EmptyState
                icon={<CheckCircle2 size={18} />}
                title="Nothing waiting for input"
                tone="ok"
              >
                Agents that pause for an answer or approval land here.
              </EmptyState>
            }
          >
            {waiting.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                tone="warn"
                fullReason
              />
            ))}
          </KanbanColumn>

          <KanbanColumn
            label="Idle"
            count={live ? idle.length : undefined}
            offline={!live}
            onRetry={retry}
            empty={
              <EmptyState icon={<Moon size={18} />} title="No idle agents">
                Quiet sessions and ones Lens can't classify show up here.
              </EmptyState>
            }
          >
            {idle.map((session) => (
              <SessionCard key={session.id} session={session} tone="off" />
            ))}
          </KanbanColumn>

          <KanbanColumn
            label="Ended"
            count={live ? ended.length : undefined}
            offline={!live}
            onRetry={retry}
            empty={
              <EmptyState
                icon={<Archive size={18} />}
                title="No ended sessions"
              >
                Agent sessions that exited in the last 48 hours are archived
                here.
              </EmptyState>
            }
          >
            {ended.map((session) => (
              <EndedCard
                key={session.id}
                session={session}
                onDismiss={dismiss}
              />
            ))}
          </KanbanColumn>
        </div>
      </div>
    </div>
  );
}

function KanbanColumn({
  label,
  count,
  attention,
  offline,
  onRetry,
  empty,
  children,
}: {
  label: string;
  count?: number;
  attention?: boolean;
  offline: boolean;
  onRetry: () => void;
  empty: ReactNode;
  children: ReactNode;
}) {
  return (
    <Panel
      label={label}
      count={count}
      attention={attention}
      className="kanban-col"
    >
      {offline ? (
        <ErrorBanner
          message="Live feed offline — sessions are read from this Mac's terminals."
          onRetry={onRetry}
        />
      ) : count === 0 ? (
        empty
      ) : (
        children
      )}
    </Panel>
  );
}

function SessionCard({
  session,
  tone,
  fullReason,
}: {
  session: LiveSession;
  tone: "ok" | "warn" | "off";
  fullReason?: boolean;
}) {
  return (
    <article className="session-card">
      <div className="session-head">
        <span
          className={`dot ${tone}${tone === "ok" ? " pulse" : ""}`}
          title={session.state}
        />
        <span className={providerBadgeClass(session.provider)}>
          {session.provider ?? "Agent"}
        </span>
      </div>
      <div className="session-title" title={session.workingDirectory}>
        {session.projectName}
      </div>
      {session.reason ? (
        <div
          className={fullReason ? "session-reason full" : "session-reason"}
          title={session.reason}
        >
          {session.reason}
        </div>
      ) : null}
      <div className="session-meta">
        {session.host} · {ttyShort(session.tty)} ·{" "}
        {relativeTime(session.lastObservedAt)}
      </div>
    </article>
  );
}

function EndedCard({
  session,
  onDismiss,
}: {
  session: EndedSession;
  onDismiss: (id: string) => void;
}) {
  return (
    <article className="session-card ended">
      <div className="session-head">
        <span className={providerBadgeClass(session.provider)}>
          {session.provider ?? "Agent"}
        </span>
        <button
          type="button"
          className="session-dismiss"
          aria-label="Dismiss"
          title="Archive this ended session"
          onClick={() => void onDismiss(session.id)}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      <div className="session-title" title={session.workingDirectory}>
        {session.projectName}
      </div>
      <div className="session-meta">ended {relativeTime(session.endedAt)}</div>
    </article>
  );
}

function QuotaRow({ account }: { account: AccountUsageRow }) {
  const session = account.usage?.session ?? null;
  const weekly = account.usage?.weeklyAll ?? null;
  return (
    <div className="quota-row">
      <div className="quota-top">
        <span className="quota-name">{account.label}</span>
        {account.stale ? <span className="quota-flag">stale</span> : null}
        {session ? (
          <span className={`quota-pct tnum ${severityClass(session.severity)}`}>
            {Math.round(session.percent)}%
          </span>
        ) : (
          <span
            className="quota-pct off"
            title={account.error ?? "No usage data for this account."}
          >
            {account.error ? "error" : "—"}
          </span>
        )}
        {weekly ? (
          <span className="quota-week tnum">
            wk {Math.round(weekly.percent)}%
          </span>
        ) : null}
      </div>
      <ProgressBar
        percent={session?.percent ?? 0}
        severity={session?.severity ?? "normal"}
      />
    </div>
  );
}

// "ttys003" from "/dev/ttys003".
function ttyShort(tty: string): string {
  return tty.replace(/^\/dev\//u, "");
}
