import type { SourceSummaryRow } from "@ziplyne/core/browser";
import {
  CloudOff,
  Database,
  EyeOff,
  Github,
  KeyRound,
  Lock,
  MonitorSmartphone,
  Moon,
  PackageCheck,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  SearchX,
  SlidersHorizontal,
  Sun,
  TerminalSquare,
  Trash2,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CleanDialog } from "../components/CleanDialog.js";
import { ProgressBar, severityClass } from "../components/ProgressBar.js";
import { EmptyState, ErrorBanner, Skeleton } from "../components/States.js";
import { Toggle } from "../components/Toggle.js";
import { Panel, WorkspaceHeader } from "../components/Workspace.js";
import {
  type AccountUsageRow,
  type AgentBurn,
  fetchLimits,
  fetchSources,
  fetchTools,
  type GitStatus,
  type LimitsPayload,
  type ProjectOverrideValue,
  type ShapedLimit,
  type SourceInfo,
  type ToolState,
  type ToolsPayload,
} from "../lib/api.js";
import type { ProjectView } from "../lib/derive.js";
import {
  agentLabel,
  formatCurrency,
  formatResetTime,
  formatTokens,
  relativeTime,
  sourceAccent,
} from "../lib/format.js";
import { readTranscriptOptIn, writeTranscriptOptIn } from "../lib/prefs.js";
import {
  getThemeChoice,
  onThemeChange,
  setThemeChoice,
  type ThemeChoice,
} from "../lib/theme.js";
import {
  type AppUpdateCheck,
  checkForAppUpdate,
  installAppUpdate,
} from "../lib/updater.js";

type SystemTab = "sources" | "tools" | "accounts" | "data" | "preferences";

const TABS: Array<{ id: SystemTab; label: string; icon: typeof Radio }> = [
  { id: "sources", label: "Sources", icon: Radio },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "accounts", label: "Accounts", icon: KeyRound },
  { id: "data", label: "Data", icon: Database },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
];

const TAB_SUBTITLE: Record<SystemTab, string> = {
  sources: "Where Lens reads usage on this Mac",
  tools: "CLI tools installed and logged in on this Mac",
  accounts: "Claude account quotas from this Mac's keychain",
  data: "Tidy up projects and reclaim space from stale logs",
  preferences: "Appearance, live sessions, and privacy",
};

const AGENT_IDS = ["claude", "codex", "kimi", "grok"] as const;

const TOOLS_POLL_MS = 60_000;

interface SystemProps {
  mode: "local" | "demo";
  connection: "checking" | "connected" | "offline";
  scannedFiles: number;
  scanErrorCount: number;
  rulesCount: number;
  sources: SourceSummaryRow[];
  autoMatch: boolean;
  canManage: boolean;
  gitStatus: GitStatus | undefined;
  projects: ProjectView[];
  overrides: Record<string, ProjectOverrideValue>;
  onToggleAutoMatch: (next: boolean) => void;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onCleaned: () => void;
}

export function System(props: SystemProps) {
  const [tab, setTab] = useState<SystemTab>("sources");

  return (
    <div className="workspace">
      <WorkspaceHeader title="System" subtitle={TAB_SUBTITLE[tab]} />
      <div className="content system-grid">
        <div className="tab-rail" role="tablist" aria-label="System sections">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? "tab-item active" : "tab-item"}
              onClick={() => setTab(item.id)}
            >
              <item.icon size={14} aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>

        {tab === "sources" ? (
          <SourcesTab
            mode={props.mode}
            connection={props.connection}
            scannedFiles={props.scannedFiles}
            scanErrorCount={props.scanErrorCount}
            rulesCount={props.rulesCount}
            sources={props.sources}
            autoMatch={props.autoMatch}
            gitStatus={props.gitStatus}
          />
        ) : tab === "tools" ? (
          <ToolsTab />
        ) : tab === "accounts" ? (
          <AccountsTab />
        ) : tab === "data" ? (
          <DataTab
            projects={props.projects}
            overrides={props.overrides}
            canManage={props.canManage}
            autoMatch={props.autoMatch}
            onToggleAutoMatch={props.onToggleAutoMatch}
            onHide={props.onHide}
            onUnhide={props.onUnhide}
            onCleaned={props.onCleaned}
          />
        ) : (
          <PreferencesTab />
        )}
      </div>
    </div>
  );
}

/* ============================ SOURCES ============================ */

function SourcesTab({
  mode,
  connection,
  scannedFiles,
  scanErrorCount,
  rulesCount,
  sources,
  autoMatch,
  gitStatus,
}: {
  mode: "local" | "demo";
  connection: "checking" | "connected" | "offline";
  scannedFiles: number;
  scanErrorCount: number;
  rulesCount: number;
  sources: SourceSummaryRow[];
  autoMatch: boolean;
  gitStatus: GitStatus | undefined;
}) {
  const [sourceInfos, setSourceInfos] = useState<SourceInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchSources().then((response) => {
      if (!cancelled && response) {
        setSourceInfos(response.sources);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const tokensBySource = new Map(
    sources.map((row) => [row.source, row.totalTokens] as const),
  );
  const sourceName = (id: string): string =>
    sourceInfos.find((info) => info.id === id)?.name ?? agentLabel(id);

  const githubLabel = !gitStatus
    ? "Checking"
    : gitStatus.installed && gitStatus.authenticated
      ? "Signed in"
      : gitStatus.installed
        ? "Installed, not signed in"
        : "Not installed";
  const githubConnected = Boolean(
    gitStatus?.installed && gitStatus?.authenticated,
  );

  return (
    <div className="sys-stack">
      {scanErrorCount > 0 ? (
        <div className="banner warn">
          <span>
            {scanErrorCount} files could not be read. Lens skipped them and kept
            going.
          </span>
        </div>
      ) : null}

      <Panel label="Agents" flush>
        {AGENT_IDS.map((id) => {
          const tokens = tokensBySource.get(id) ?? 0;
          const detected = tokens > 0;
          return (
            <div className="row" key={id}>
              <span className="dot" style={{ background: sourceAccent(id) }} />
              <div className="row-main">
                <span className="row-title">{sourceName(id)}</span>
                <span className="row-meta">
                  {detected
                    ? `${formatTokens(tokens)} tokens indexed`
                    : "No usage detected yet"}
                </span>
              </div>
              <span className={detected ? "tag ok" : "tag"}>
                {detected ? "Detected" : "Not detected"}
              </span>
            </div>
          );
        })}
        <div className="row">
          <Github
            size={14}
            aria-hidden="true"
            style={{ color: githubConnected ? "var(--t1)" : "var(--t3)" }}
          />
          <div className="row-main">
            <span className="row-title">GitHub CLI</span>
            <span className="row-meta">
              {githubConnected
                ? "Used to group repositories by owner"
                : "Optional. Improves automatic project matching"}
            </span>
          </div>
          <span className={githubConnected ? "tag ok" : "tag"}>
            {githubLabel}
          </span>
        </div>
      </Panel>

      <Panel label="Configuration" flush>
        <div className="kv">
          <span className="k">Data source</span>
          <span className="v">
            {mode === "local" ? "This Mac" : "Sample data"}
          </span>
        </div>
        <div className="kv">
          <span className="k">Local service</span>
          <span className="v">
            {connection === "connected"
              ? "Connected"
              : connection === "checking"
                ? "Checking"
                : "Offline"}
          </span>
        </div>
        <div className="kv">
          <span className="k">Config file</span>
          <span className="v mono" style={{ fontSize: 11 }}>
            ~/.ziplyne-lens/config.json
          </span>
        </div>
        <div className="kv">
          <span className="k">Auto-matching</span>
          <span className="v">{autoMatch ? "On" : "Off"}</span>
        </div>
        <div className="kv">
          <span className="k">Files indexed</span>
          <span className="v tnum">{scannedFiles.toLocaleString()}</span>
        </div>
        <div className="kv">
          <span className="k">Manual rules</span>
          <span className="v tnum">{rulesCount}</span>
        </div>
      </Panel>
    </div>
  );
}

/* ============================ TOOLS ============================ */

const TOOL_STATE_FILTERS: Array<{ id: "all" | ToolState; label: string }> = [
  { id: "all", label: "All" },
  { id: "loggedIn", label: "Logged in" },
  { id: "installed", label: "Installed" },
];

const URGENCY_ROW: Record<string, string> = {
  expired: "expired",
  imminent: "imminent",
  soon: "soon",
};

function ToolsTab() {
  const [payload, setPayload] = useState<ToolsPayload | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState<"all" | ToolState>("all");
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      const next = await fetchTools();
      inFlight = false;
      if (cancelled) {
        return;
      }
      if (next) {
        setPayload(next);
        setError(null);
      } else {
        setError(
          "Could not reach the local service. The CLI inventory is scanned on this Mac.",
        );
      }
      timer = window.setTimeout(() => void tick(), TOOLS_POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const refreshNow = async () => {
    setRefreshing(true);
    const next = await fetchTools();
    setRefreshing(false);
    if (next) {
      setPayload(next);
      setError(null);
    }
  };

  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const tool of payload?.tools ?? []) {
      if (tool.kind) {
        set.add(tool.kind);
      }
    }
    return [...set].sort();
  }, [payload]);

  const tools = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (payload?.tools ?? []).filter((tool) => {
      if (kindFilter !== "all" && tool.kind !== kindFilter) {
        return false;
      }
      if (stateFilter !== "all" && tool.state !== stateFilter) {
        return false;
      }
      if (
        needle &&
        !tool.title.toLowerCase().includes(needle) &&
        !tool.executable.toLowerCase().includes(needle)
      ) {
        return false;
      }
      return true;
    });
  }, [payload, kindFilter, stateFilter, search]);

  const expiring = useMemo(
    () => (payload?.expiring ?? []).filter((item) => item.urgency !== "ok"),
    [payload],
  );

  if (error && !payload) {
    return (
      <div className="sys-stack">
        <ErrorBanner message={error} onRetry={refreshNow} />
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="sys-stack">
        <Skeleton height={64} radius={10} />
        <Skeleton height={240} radius={10} />
      </div>
    );
  }

  return (
    <div className="sys-fill">
      <div className="count-strip">
        <div className="stat-box">
          <div className="stat-k">Logged in</div>
          <div className="stat-v tnum">{payload.counts.loggedIn}</div>
        </div>
        <div className="stat-box">
          <div className="stat-k">Installed</div>
          <div className="stat-v tnum">{payload.counts.installed}</div>
        </div>
        <div className="stat-box">
          <div className="stat-k">Discovered</div>
          <div className="stat-v tnum">{payload.counts.discovered}</div>
        </div>
      </div>

      {expiring.length > 0 ? (
        <Panel label="Expiring credentials" count={expiring.length} flush>
          {expiring.map((item) => (
            <div
              className={`expiry-row ${URGENCY_ROW[item.urgency] ?? "soon"}`}
              key={`${item.provider}:${item.label}`}
            >
              <span className="expiry-dot" aria-hidden="true" />
              <span className="expiry-provider">{item.provider}</span>
              <span className="expiry-label" title={item.evidencePath}>
                {item.label}
              </span>
              <span className="expiry-when tnum">
                {expiryCountdown(item.expiresAt)}
              </span>
            </div>
          ))}
        </Panel>
      ) : null}

      <Panel
        label="CLI inventory"
        count={tools.length}
        action={
          <>
            <div
              className="segmented"
              role="toolbar"
              aria-label="Filter by state"
            >
              {TOOL_STATE_FILTERS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={option.id === stateFilter ? "active" : ""}
                  aria-pressed={option.id === stateFilter}
                  onClick={() => setStateFilter(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <select
              className="select"
              style={{ height: 24, fontSize: 11 }}
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value)}
              aria-label="Filter by kind"
            >
              <option value="all">All kinds</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <span className="proj-search" style={{ maxWidth: 150 }}>
              <Search size={11} aria-hidden="true" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter tools…"
                aria-label="Filter tools"
              />
            </span>
            <button
              type="button"
              className="icon-btn"
              style={{ width: 22, height: 22 }}
              onClick={refreshNow}
              disabled={refreshing}
              aria-label="Refresh CLI tools"
              title="Refresh now"
            >
              <RefreshCw size={12} />
            </button>
          </>
        }
      >
        {tools.length === 0 ? (
          <EmptyState icon={<SearchX size={18} />} title="No tools match">
            {payload.tools.length === 0
              ? "The inventory checks Homebrew, cargo, bun, pnpm, go, and version-manager shims for known CLIs."
              : "Adjust the filters or clear the search."}
          </EmptyState>
        ) : (
          tools.map((tool) => (
            <div className="tool-row" key={tool.executable}>
              <div className="tool-main">
                <div className="tool-title">
                  <span>{tool.title}</span>
                  {tool.executable !== tool.title ? (
                    <span className="exec mono">{tool.executable}</span>
                  ) : null}
                </div>
                {tool.state === "loggedIn" && tool.credentialPath ? (
                  <div className="tool-cred" title={tool.credentialPath}>
                    {tool.credentialPath}
                  </div>
                ) : null}
              </div>
              <div className="tool-side">
                {tool.source === "discovered" ? (
                  <span className="tag">discovered</span>
                ) : null}
                {tool.kind ? <span className="tag">{tool.kind}</span> : null}
                <span className={tool.state === "loggedIn" ? "tag ok" : "tag"}>
                  {tool.state === "loggedIn" ? "Logged in" : "Installed"}
                </span>
              </div>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

/* ============================ ACCOUNTS ============================ */

function AccountsTab() {
  const [payload, setPayload] = useState<LimitsPayload | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      const next = await fetchLimits();
      inFlight = false;
      if (cancelled) {
        return;
      }
      if (next) {
        setPayload(next);
        setError(null);
      } else {
        setError(
          "Could not reach the local service. Quota data comes from this Mac's keychain and local logs.",
        );
      }
      timer = window.setTimeout(() => void tick(), TOOLS_POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const refreshNow = async () => {
    setRefreshing(true);
    const next = await fetchLimits();
    setRefreshing(false);
    if (next) {
      setPayload(next);
      setError(null);
    }
  };

  if (error && !payload) {
    return (
      <div className="sys-stack">
        <ErrorBanner message={error} onRetry={refreshNow} />
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="sys-stack">
        <Skeleton height={48} radius={10} />
        <div className="accounts-grid">
          <Skeleton height={170} radius={10} />
          <Skeleton height={170} radius={10} />
        </div>
      </div>
    );
  }

  const best = payload.bestAccount;

  return (
    <div className="sys-stack">
      <div className="best-banner">
        <span
          className={`dot ${best ? severityClass(best.severity) : "off"}`}
        />
        {best ? (
          <span>
            <span className="bb-title">{best.label}</span>{" "}
            <span className="tnum" style={{ color: "var(--t2)" }}>
              — {best.worstPct}% used
            </span>{" "}
            <span className="bb-sub">
              · best account right now (lowest worst-limit)
            </span>
          </span>
        ) : (
          <span className="bb-sub">
            No quota data yet — Lens reads Claude OAuth usage from this Mac's
            keychain.
          </span>
        )}
        <button
          type="button"
          className="icon-btn"
          style={{ marginLeft: "auto" }}
          onClick={refreshNow}
          disabled={refreshing}
          aria-label="Refresh accounts"
          title="Refresh now"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {payload.accounts.length === 0 ? (
        <Panel label="Claude accounts">
          <EmptyState
            icon={<KeyRound size={18} />}
            title="No accounts configured"
          >
            Add accounts to ~/.ziplyne-lens/config.json to track their quotas.
          </EmptyState>
        </Panel>
      ) : (
        <div className="accounts-grid">
          {payload.accounts.map((account) => (
            <AccountCard
              key={account.label}
              account={account}
              agents={payload.agents}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountCard({
  account,
  agents,
}: {
  account: AccountUsageRow;
  agents: AgentBurn[];
}) {
  const usage = account.usage;
  // Local per-profile spend, matched case-insensitively from the Claude
  // agent's account breakdown. Nothing extra when the Mac has no match.
  const local = agents
    .find((agent) => agent.source === "claude")
    ?.accounts?.find(
      (burn) => burn.account.toLowerCase() === account.label.toLowerCase(),
    );
  return (
    <div className="panel account-card">
      <div className="account-head">
        <span className="account-label">{account.label}</span>
        <span className="account-email">{account.email}</span>
        {account.stale ? (
          <span className="tag warn">
            stale
            {account.fetchedAt ? ` · ${relativeTime(account.fetchedAt)}` : ""}
          </span>
        ) : null}
      </div>
      <div className="account-cmd mono">$ {account.command}</div>
      {!usage ? (
        <div className="banner error">
          <span>{account.error ?? "No usage data for this account."}</span>
        </div>
      ) : (
        <>
          <LimitRow name="Session" limit={usage.session} />
          <LimitRow name="Weekly" limit={usage.weeklyAll} />
          {usage.weeklyScoped.map((limit) => (
            <LimitRow
              key={limit.scope ?? limit.kind}
              name={limit.scope ?? "Scoped"}
              limit={limit}
            />
          ))}
        </>
      )}
      {local ? (
        <div className="account-local tnum">
          Local: {formatCurrency(local.todayCostUsd)} today ·{" "}
          {formatCurrency(local.weekCostUsd)} this week
        </div>
      ) : null}
    </div>
  );
}

function LimitRow({
  name,
  limit,
}: {
  name: string;
  limit: ShapedLimit | null;
}) {
  if (!limit) {
    return null;
  }
  const tone = severityClass(limit.severity);
  const reset = formatResetTime(limit.resetsAt);
  return (
    <div className="limit-row">
      <div className="limit-row-top">
        <span className="limit-row-name">{name}</span>
        <span className={`limit-row-pct tnum ${tone}`}>
          {Math.round(limit.percent)}%
        </span>
        {reset ? <span className="limit-row-reset">resets {reset}</span> : null}
      </div>
      <ProgressBar percent={limit.percent} severity={limit.severity} />
    </div>
  );
}

/* ============================ DATA ============================ */

function DataTab({
  projects,
  overrides,
  canManage,
  autoMatch,
  onToggleAutoMatch,
  onHide,
  onUnhide,
  onCleaned,
}: {
  projects: ProjectView[];
  overrides: Record<string, ProjectOverrideValue>;
  canManage: boolean;
  autoMatch: boolean;
  onToggleAutoMatch: (next: boolean) => void;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onCleaned: () => void;
}) {
  const [cleanTarget, setCleanTarget] = useState<ProjectView | undefined>();
  const hidden = Object.entries(overrides).filter(
    ([, override]) => override.hidden,
  );
  // Unassigned is never the headline — it manages last, muted.
  const managed = [
    ...projects.filter((project) => !project.isUnassigned),
    ...projects.filter((project) => project.isUnassigned),
  ];

  return (
    <div className="sys-fill">
      <Panel
        label="Manage projects"
        count={projects.length}
        action={
          !canManage ? (
            <span style={{ color: "var(--t3)" }}>
              Connect the local service to manage data
            </span>
          ) : undefined
        }
      >
        {projects.length === 0 ? (
          <EmptyState
            icon={<TerminalSquare size={18} />}
            title="No projects yet"
          >
            Usage matched to a project shows up here with hide and clean
            actions.
          </EmptyState>
        ) : (
          managed.map((project) => (
            <div
              className={project.isUnassigned ? "row muted-row" : "row"}
              key={project.id}
            >
              <div className="row-main">
                <span className="row-title">{project.name}</span>
                <span className="row-meta tnum">
                  {formatCurrency(project.costUsd)}
                  {project.isUnassigned
                    ? ` · ${project.repositories} ${project.repositories === 1 ? "repo" : "repos"}`
                    : ""}
                </span>
              </div>
              <div className="row-actions">
                {!project.isUnassigned ? (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => onHide(project.id)}
                    disabled={!canManage}
                  >
                    <EyeOff size={13} /> Hide
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn danger sm"
                  onClick={() => setCleanTarget(project)}
                  disabled={!canManage}
                >
                  <Trash2 size={13} /> Clean
                </button>
              </div>
            </div>
          ))
        )}
      </Panel>

      {hidden.length > 0 ? (
        <Panel label="Hidden projects" count={hidden.length} flush>
          {hidden.map(([id, override]) => (
            <div className="row" key={id}>
              <EyeOff
                size={13}
                aria-hidden="true"
                style={{ color: "var(--t3)" }}
              />
              <div className="row-main">
                <span className="row-title">{override.name ?? id}</span>
                <span className="row-meta">Excluded from all analytics</span>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => onUnhide(id)}
                  disabled={!canManage}
                >
                  <RotateCcw size={13} /> Unhide
                </button>
              </div>
            </div>
          ))}
        </Panel>
      ) : null}

      <Panel label="Matching" flush>
        <div className="set-item">
          <div className="set-body">
            <div className="set-label">Group repositories by GitHub owner</div>
            <div className="set-desc">
              Uses each repo's git remote to roll repositories up into a project
              per owner. Turn off to rely only on manual rules.
            </div>
          </div>
          <Toggle
            on={autoMatch}
            onChange={onToggleAutoMatch}
            label="Group repositories by GitHub owner"
            disabled={!canManage}
          />
        </div>
      </Panel>

      {cleanTarget ? (
        <CleanDialog
          projectId={cleanTarget.id}
          projectName={cleanTarget.name}
          onClose={() => setCleanTarget(undefined)}
          onDone={onCleaned}
        />
      ) : null}
    </div>
  );
}

/* ============================ PREFERENCES ============================ */

const THEME_OPTIONS: Array<{
  id: ThemeChoice;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: "auto", label: "Auto", icon: <MonitorSmartphone size={13} /> },
  { id: "dark", label: "Dark", icon: <Moon size={13} /> },
  { id: "light", label: "Light", icon: <Sun size={13} /> },
];

function PreferencesTab() {
  const [theme, setTheme] = useState<ThemeChoice>(getThemeChoice);
  const [transcripts, setTranscripts] = useState(readTranscriptOptIn);
  const [update, setUpdate] = useState<AppUpdateCheck>();
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<string>();

  // Stay in sync when the theme is changed from the ⌘K palette.
  useEffect(() => onThemeChange(() => setTheme(getThemeChoice())), []);

  const checkForUpdates = async () => {
    setUpdateBusy(true);
    setUpdateProgress(undefined);
    setUpdate(await checkForAppUpdate());
    setUpdateBusy(false);
  };

  const installUpdate = async () => {
    setUpdateBusy(true);
    const result = await installAppUpdate((downloaded, total) => {
      setUpdateProgress(
        total
          ? `Downloading ${Math.min(100, Math.round((downloaded / total) * 100))}%`
          : "Downloading update…",
      );
    });
    if (!result.ok) {
      setUpdate({ status: "error", message: result.message });
      setUpdateBusy(false);
    }
  };

  return (
    <div className="sys-stack">
      <Panel label="Appearance" flush>
        <div className="set-item">
          <div className="set-body">
            <div className="set-label">Theme</div>
            <div className="set-desc">
              Auto follows your macOS appearance. The choice is saved on this
              Mac.
            </div>
          </div>
          <div className="segmented">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={theme === option.id ? "active" : ""}
                aria-pressed={theme === option.id}
                onClick={() => {
                  setThemeChoice(option.id);
                  setTheme(option.id);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                {option.icon}
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </Panel>

      <Panel label="Live sessions" flush>
        <div className="set-item">
          <div className="set-body">
            <div className="set-label">Terminal transcript previews</div>
            <div className="set-desc">
              Shows the last lines of each agent's Terminal.app tab in the Now
              workspace. Read locally via AppleScript; never uploaded.
            </div>
          </div>
          <Toggle
            on={transcripts}
            onChange={(next) => {
              setTranscripts(next);
              writeTranscriptOptIn(next);
            }}
            label="Terminal transcript previews"
          />
        </div>
      </Panel>

      <Panel label="Updates" flush>
        <div className="set-item">
          <PackageCheck
            size={14}
            aria-hidden="true"
            style={{ color: "var(--t3)", flex: "none" }}
          />
          <div className="set-body">
            <div className="set-label">ZipLyne Lens {__APP_VERSION__}</div>
            <div className="set-desc" aria-live="polite">
              {updateProgress ?? updateStatusText(update)}
            </div>
          </div>
          {update?.status === "available" ? (
            <button
              type="button"
              className="btn primary sm"
              disabled={updateBusy}
              onClick={installUpdate}
            >
              Update to {update.version}
            </button>
          ) : (
            <button
              type="button"
              className="btn ghost sm"
              disabled={updateBusy}
              onClick={checkForUpdates}
            >
              {updateBusy ? "Checking…" : "Check for updates"}
            </button>
          )}
        </div>
      </Panel>

      <Panel label="Privacy" flush>
        <div className="set-item">
          <Lock
            size={14}
            aria-hidden="true"
            style={{ color: "var(--t3)", flex: "none" }}
          />
          <div className="set-body">
            <div className="set-label">Secrets redacted in previews</div>
            <div className="set-desc">
              API keys, tokens, and emails are stripped from every prompt
              preview. Always on.
            </div>
          </div>
          <span className="tag ok">On</span>
        </div>
        <div className="set-item">
          <CloudOff
            size={14}
            aria-hidden="true"
            style={{ color: "var(--t3)", flex: "none" }}
          />
          <div className="set-body">
            <div className="set-label">Everything stays on this Mac</div>
            <div className="set-desc">
              Lens reads local log files and never uploads them. No account, no
              cloud, no telemetry.
            </div>
          </div>
          <span className="tag ok">On</span>
        </div>
      </Panel>
    </div>
  );
}

function updateStatusText(update: AppUpdateCheck | undefined): string {
  if (!update) {
    return "Updates are downloaded from GitHub and verified before installation.";
  }
  if (update.status === "available") {
    return update.notes
      ? `Version ${update.version} is available. ${update.notes}`
      : `Version ${update.version} is available.`;
  }
  if (update.status === "current") {
    return "You are using the latest version.";
  }
  if (update.status === "unsupported") {
    return "In-app updates are available in the installed desktop app.";
  }
  return `Could not check for updates: ${update.message}`;
}

// "expires in 12m" / "expired 2d ago".
function expiryCountdown(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) {
    return "";
  }
  const diff = ms - Date.now();
  const absMin = Math.max(1, Math.round(Math.abs(diff) / 60_000));
  let span: string;
  if (absMin < 60) {
    span = `${absMin}m`;
  } else if (absMin < 60 * 24) {
    span = `${Math.round(absMin / 60)}h`;
  } else {
    span = `${Math.round(absMin / (60 * 24))}d`;
  }
  return diff < 0 ? `expired ${span} ago` : `expires in ${span}`;
}
