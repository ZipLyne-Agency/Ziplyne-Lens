import type {
  ClientRule,
  LensSummary,
  PromptLibrary,
} from "@ziplyne/core/browser";
import { FolderGit2, Moon, RefreshCw, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CommandPalette,
  type PaletteAction,
} from "./components/CommandPalette.js";
import { Sidebar, WORKSPACES, type WorkspaceId } from "./components/Sidebar.js";
import {
  fetchGitStatus,
  fetchHealth,
  fetchLiveSessions,
  fetchPrompts,
  fetchSummary,
  type GitStatus,
  type ProjectConfigPatch,
  type ProjectOverrideValue,
  type RangePreset,
  type SourceFilter,
  saveProjectConfig,
} from "./lib/api.js";
import { toProjectViews } from "./lib/derive.js";
import { formatCurrency } from "./lib/format.js";
import {
  applyTheme,
  currentResolvedTheme,
  onThemeChange,
  type ResolvedTheme,
  toggleExplicitTheme,
} from "./lib/theme.js";
import { Library } from "./screens/Library.js";
import { Now } from "./screens/Now.js";
import { Projects } from "./screens/Projects.js";
import { Spend } from "./screens/Spend.js";
import { System } from "./screens/System.js";

export function App() {
  const [activeNav, setActiveNav] = useState<WorkspaceId>("now");
  const [range, setRange] = useState<RangePreset>("30d");
  const [summary, setSummary] = useState<LensSummary | undefined>();
  const [rules, setRules] = useState<ClientRule[]>([]);
  const [mode, setMode] = useState<"local" | "demo">("demo");
  const [connection, setConnection] = useState<
    "checking" | "connected" | "offline"
  >("checking");
  const [scan, setScan] = useState({
    scannedFiles: 0,
    errors: [] as Array<{ message: string }>,
  });
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [overrides, setOverrides] = useState<
    Record<string, ProjectOverrideValue>
  >({});
  const [autoMatch, setAutoMatch] = useState(true);
  const [gitStatus, setGitStatus] = useState<GitStatus | undefined>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [attentionCount, setAttentionCount] = useState(0);
  const [selectedProjectId, setSelectedProjectId] = useState<
    string | undefined
  >();
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    applyTheme(),
  );

  // Prompt library state (Library workspace + sidebar badge).
  const [promptLibrary, setPromptLibrary] = useState<
    PromptLibrary | undefined
  >();
  const [promptLoading, setPromptLoading] = useState(true);
  const [promptSearch, setPromptSearch] = useState("");
  const [promptSource, setPromptSource] = useState<SourceFilter>("all");
  const [libraryClientId, setLibraryClientId] = useState<string | undefined>();
  const [includePromptContent, setIncludePromptContent] = useState(false);

  const requestKey = `${range}:${refreshToken}`;
  const canManage = mode === "local";

  // Reflect theme changes coming from the palette or the OS (auto mode).
  useEffect(
    () =>
      onThemeChange(() => {
        setResolvedTheme(currentResolvedTheme());
      }),
    [],
  );

  // ⌘K / Ctrl-K opens the command palette from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ⌘1…⌘5 switches workspaces.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      const index = Number.parseInt(event.key, 10) - 1;
      const workspace = WORKSPACES[index];
      if (workspace) {
        event.preventDefault();
        setActiveNav(workspace.id);
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const next = await fetchHealth();
      if (!cancelled) {
        setConnection(next?.ok ? "connected" : "offline");
      }
    };
    check();
    const interval = window.setInterval(check, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  // Light-touch poll for the sidebar's Now attention badge. Skipped while
  // the window is hidden so an idle app never shells out to ps.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.hidden) {
        return;
      }
      const payload = await fetchLiveSessions({ transcripts: false });
      if (!cancelled) {
        setAttentionCount(payload?.counts.needsAttention ?? 0);
      }
    };
    load();
    const interval = window.setInterval(load, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(
      () => setRefreshToken((value) => value + 1),
      15_000,
    );
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    const [selectedRange] = requestKey.split(":") as [RangePreset, string];
    setLoading(true);
    fetchSummary({ range: selectedRange, source: "all" })
      .then((response) => {
        if (cancelled) {
          return;
        }
        if (!response) {
          // Desktop: the local scan isn't ready yet. Keep the loading screen
          // (never demo data) and retry shortly until real data arrives.
          retry = window.setTimeout(
            () => setRefreshToken((value) => value + 1),
            2500,
          );
          return;
        }
        setSummary(response.summary);
        setRules(response.rules);
        setMode(response.mode);
        setScan(response.scan);
        if (response.config) {
          setOverrides(response.config.overrides);
          setAutoMatch(response.config.autoMatch);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          retry = window.setTimeout(
            () => setRefreshToken((value) => value + 1),
            2500,
          );
        }
      });
    return () => {
      cancelled = true;
      if (retry) {
        window.clearTimeout(retry);
      }
    };
  }, [requestKey]);

  // Prompt library fetch. Search is debounced 250ms so typing doesn't fire a
  // re-scan per keystroke; every other input refetches immediately.
  useEffect(() => {
    let cancelled = false;
    void refreshToken;
    const timer = window.setTimeout(
      () => {
        setPromptLoading(true);
        fetchPrompts({
          range,
          source: promptSource,
          clientId: libraryClientId ?? "all",
          search: promptSearch,
          includeContent: includePromptContent,
        })
          .then((response) => {
            if (!cancelled && response) {
              setPromptLibrary(response.library);
              setPromptLoading(false);
            }
          })
          .catch(() => {
            // Leave the library in its loading state; the summary retry loop
            // triggers another attempt once the sidecar responds.
          });
      },
      promptSearch ? 250 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    includePromptContent,
    libraryClientId,
    promptSearch,
    promptSource,
    range,
    refreshToken,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (mode !== "local") {
      setGitStatus(undefined);
      return;
    }
    fetchGitStatus().then((status) => {
      if (!cancelled) {
        setGitStatus(status);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const applyConfig = useCallback(async (patch: ProjectConfigPatch) => {
    const saved = await saveProjectConfig(patch);
    if (saved) {
      setOverrides(saved.overrides);
      setAutoMatch(saved.autoMatch);
    }
    // Re-scan so hidden/renamed/auto-match changes flow through every metric.
    setRefreshToken((value) => value + 1);
  }, []);

  const setProjectHidden = useCallback(
    (id: string, hidden: boolean) =>
      applyConfig({ overrides: { [id]: { hidden } } }),
    [applyConfig],
  );
  const toggleAutoMatch = useCallback(
    (next: boolean) => applyConfig({ autoMatch: next }),
    [applyConfig],
  );
  const handleCleaned = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

  const projects = useMemo(
    () => (summary ? toProjectViews(summary) : []),
    [summary],
  );

  const openLibraryForProject = useCallback((clientId: string) => {
    setLibraryClientId(clientId);
    setActiveNav("library");
  }, []);

  const libraryClientName = useMemo(
    () =>
      libraryClientId
        ? projects.find((project) => project.id === libraryClientId)?.name
        : undefined,
    [projects, libraryClientId],
  );

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const actions: PaletteAction[] = WORKSPACES.map((workspace, index) => ({
      id: `workspace-${workspace.id}`,
      section: "Workspaces",
      label: workspace.label,
      hint: `⌘${index + 1}`,
      icon: workspace.icon,
      run: () => setActiveNav(workspace.id),
    }));
    for (const project of projects
      .filter((project) => !project.isUnassigned)
      .slice(0, 6)) {
      actions.push({
        id: `project-${project.id}`,
        section: "Projects",
        label: project.name,
        hint: formatCurrency(project.costUsd),
        icon: FolderGit2,
        run: () => {
          setSelectedProjectId(project.id);
          setActiveNav("projects");
        },
      });
    }
    actions.push({
      id: "action-refresh",
      section: "Actions",
      label: "Refresh data",
      hint: "Re-scan now",
      icon: RefreshCw,
      run: () => setRefreshToken((value) => value + 1),
    });
    actions.push({
      id: "action-theme",
      section: "Actions",
      label:
        resolvedTheme === "dark"
          ? "Switch to light theme"
          : "Switch to dark theme",
      icon: resolvedTheme === "dark" ? Sun : Moon,
      run: () => toggleExplicitTheme(),
    });
    return actions;
  }, [projects, resolvedTheme]);

  if (!summary) {
    return (
      <main className="boot">
        <div className="boot-inner">
          <div className="brand-mark">
            <svg
              aria-hidden="true"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 6h14L6 18h13" />
            </svg>
          </div>
          <h1>ZipLyne Lens</h1>
          <p>
            {loading
              ? "Loading your AI coding spend…"
              : "Start the local service to see your AI coding spend. Lens keeps everything on this Mac."}
          </p>
          {loading ? (
            <div className="boot-skeleton" aria-hidden="true">
              <div className="skeleton" style={{ height: 12 }} />
              <div className="skeleton" style={{ height: 12, width: "72%" }} />
              <div className="skeleton" style={{ height: 12, width: "48%" }} />
            </div>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <div className="app">
      <Sidebar
        active={activeNav}
        onNavigate={setActiveNav}
        attentionCount={attentionCount}
        promptCount={promptLibrary?.totals.prompts ?? 0}
        connection={connection}
        mode={mode}
        version={__APP_VERSION__}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      {activeNav === "now" ? (
        <Now summary={summary} />
      ) : activeNav === "spend" ? (
        <Spend
          summary={summary}
          projects={projects}
          range={range}
          onRangeChange={setRange}
          onAssignUnassigned={() => {
            setSelectedProjectId("unassigned");
            setActiveNav("projects");
          }}
        />
      ) : activeNav === "projects" ? (
        <Projects
          selectedId={selectedProjectId}
          onSelect={setSelectedProjectId}
          canManage={canManage}
          refreshToken={refreshToken}
          onOpenPrompts={openLibraryForProject}
        />
      ) : activeNav === "library" ? (
        <Library
          library={promptLibrary}
          loading={promptLoading}
          search={promptSearch}
          onSearchChange={setPromptSearch}
          source={promptSource}
          onSourceChange={setPromptSource}
          clientId={libraryClientId}
          clientName={libraryClientName}
          onClearClient={() => setLibraryClientId(undefined)}
          includeContent={includePromptContent}
          onIncludeContentChange={setIncludePromptContent}
        />
      ) : (
        <System
          mode={mode}
          connection={connection}
          scannedFiles={scan.scannedFiles}
          scanErrorCount={scan.errors.length}
          rulesCount={rules.length}
          sources={summary.sources}
          autoMatch={autoMatch}
          canManage={canManage}
          gitStatus={gitStatus}
          projects={projects}
          overrides={overrides}
          onToggleAutoMatch={toggleAutoMatch}
          onHide={(id) => setProjectHidden(id, true)}
          onUnhide={(id) => setProjectHidden(id, false)}
          onCleaned={handleCleaned}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />
    </div>
  );
}
