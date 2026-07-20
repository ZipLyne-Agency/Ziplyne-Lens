import type { LensSummary, PromptLibraryRecord } from "@ziplyne/core/browser";
import { ArrowRight, FolderGit2, GitBranch, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { OpenButtons } from "../components/OpenButtons.js";
import { EmptyState } from "../components/States.js";
import { Panel, WorkspaceHeader } from "../components/Workspace.js";
import {
  fetchProjects,
  fetchPrompts,
  fetchSummary,
  type ProjectEntry,
  type ProjectsPayload,
} from "../lib/api.js";
import { type ProjectView, toProjectViews } from "../lib/derive.js";
import {
  formatCurrency,
  formatCurrencyExact,
  formatNumber,
  formatTokens,
  relativeTime,
  shortDate,
  sourceAccent,
} from "../lib/format.js";

const REGISTRY_POLL_MS = 30_000;

interface ProjectsProps {
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  canManage: boolean;
  /** Bumped by App after cleans/hides so the 30d view re-scans. */
  refreshToken: number;
  /** Jump to Library with this project preselected. */
  onOpenPrompts: (clientId: string) => void;
}

interface ListEntry {
  project: ProjectView;
  registry?: ProjectEntry;
  lastActiveAt?: string;
}

export function Projects({
  selectedId,
  onSelect,
  canManage,
  refreshToken,
  onOpenPrompts,
}: ProjectsProps) {
  // This workspace always shows trailing-30d numbers, independent of the
  // range picked on the Spend screen.
  const [summary30, setSummary30] = useState<LensSummary | undefined>();
  const [registry, setRegistry] = useState<ProjectsPayload | undefined>();
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    void refreshToken;
    fetchSummary({ range: "30d", source: "all" }).then((response) => {
      if (!cancelled && response) {
        setSummary30(response.summary);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      const next = await fetchProjects();
      inFlight = false;
      if (cancelled) {
        return;
      }
      if (next) {
        setRegistry(next);
      }
      timer = window.setTimeout(() => void tick(), REGISTRY_POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const projects = useMemo(
    () => (summary30 ? toProjectViews(summary30) : []),
    [summary30],
  );

  const registryByName = useMemo(() => {
    const map = new Map<string, ProjectEntry>();
    for (const entry of registry?.projects ?? []) {
      map.set(entry.name.toLowerCase(), entry);
    }
    return map;
  }, [registry]);

  // Spend projects enriched with registry liveness, sorted by recency —
  // unassigned always last and muted.
  const entries = useMemo<ListEntry[]>(() => {
    const needle = search.trim().toLowerCase();
    const merged: ListEntry[] = projects.map((project) => {
      const reg = registryByName.get(project.name.toLowerCase());
      const lastDay = project.days[project.days.length - 1]?.day;
      return {
        project,
        registry: reg,
        lastActiveAt: reg?.lastActiveAt ?? lastDay,
      };
    });
    return merged
      .filter(
        (entry) => !needle || entry.project.name.toLowerCase().includes(needle),
      )
      .sort((a, b) => {
        if (a.project.isUnassigned !== b.project.isUnassigned) {
          return a.project.isUnassigned ? 1 : -1;
        }
        return (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "");
      });
  }, [projects, registryByName, search]);

  const selectedEntry =
    entries.find((entry) => entry.project.id === selectedId) ?? entries[0];

  return (
    <div className="workspace">
      <WorkspaceHeader
        title="Projects"
        subtitle={`${entries.filter((e) => !e.project.isUnassigned).length} projects · ${formatCurrency(summary30?.totals.costUsd ?? 0)} tracked · 30 days`}
      />

      <div className="content projects-grid">
        <Panel
          label="Projects"
          count={entries.length}
          action={
            <span className="proj-search">
              <Search size={11} aria-hidden="true" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter…"
                aria-label="Filter projects"
              />
            </span>
          }
        >
          {!summary30 ? (
            <div className="center-muted">Loading projects…</div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={<FolderGit2 size={18} />}
              title="No projects found"
            >
              {search
                ? "No projects match this filter."
                : "Once an agent logs usage in a repository on this Mac, it lands here."}
            </EmptyState>
          ) : (
            entries.map((entry) => (
              <ProjectListRow
                key={entry.project.id}
                entry={entry}
                selected={
                  selectedEntry !== undefined &&
                  entry.project.id === selectedEntry.project.id
                }
                onSelect={onSelect}
              />
            ))
          )}
        </Panel>

        {selectedEntry ? (
          <ProjectDetail
            entry={selectedEntry}
            canManage={canManage}
            onOpenPrompts={onOpenPrompts}
          />
        ) : (
          <Panel label="Detail">
            <div className="center-muted">
              Select a project to see its costs.
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

function ProjectListRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ListEntry;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { project, registry } = entry;
  const classes = [
    "row",
    "clickable",
    selected ? "selected" : "",
    project.isUnassigned ? "muted-row" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      onClick={() => onSelect(project.id)}
    >
      {registry?.live ? (
        <span className="dot ok pulse" title="Live session open now" />
      ) : null}
      <div className="row-main">
        <span className="proj-name">{project.name}</span>
        <span className="row-meta">
          {entry.lastActiveAt ? relativeTime(entry.lastActiveAt) : "—"}
          {project.isUnassigned
            ? ` · ${project.repositories} ${project.repositories === 1 ? "repo" : "repos"}`
            : ""}
        </span>
      </div>
      <span className="tag tnum" title="Spend, trailing 30 days">
        {formatCurrencyExact(project.costUsd)}
      </span>
    </button>
  );
}

function ProjectDetail({
  entry,
  canManage,
  onOpenPrompts,
}: {
  entry: ListEntry;
  canManage: boolean;
  onOpenPrompts: (clientId: string) => void;
}) {
  const { project, registry } = entry;
  const [prompts, setPrompts] = useState<PromptLibraryRecord[]>([]);
  const [promptTotal, setPromptTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchPrompts({
      range: "30d",
      source: "all",
      clientId: project.id,
      search: "",
      includeContent: false,
    }).then((response) => {
      if (cancelled || !response) {
        return;
      }
      setPrompts(response.library.prompts.slice(0, 5));
      setPromptTotal(
        response.library.promptCounts[project.id] ??
          response.library.totals.prompts,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const maxDayCost = project.days.reduce(
    (max, day) => Math.max(max, day.costUsd),
    0,
  );

  return (
    <Panel label={project.isUnassigned ? "Unassigned usage" : "Detail"} flush>
      <div className="pd">
        <div className="pd-head">
          <div style={{ minWidth: 0 }}>
            <div className="pd-name">{project.name}</div>
            <div className="pd-sub">
              {project.isUnassigned
                ? "Usage that hasn't been matched to a project yet"
                : (project.owner ?? "Local repository")}
            </div>
          </div>
          {registry?.gitBranch ? (
            <span className="tag" title="Git branch">
              <GitBranch size={11} aria-hidden="true" />
              <span className="mono">{registry.gitBranch}</span>
            </span>
          ) : null}
          {registry ? (
            <OpenButtons
              path={registry.path}
              url={registry.repoUrl}
              name={project.name}
            />
          ) : null}
        </div>

        <div className="stat-strip">
          <div className="stat-box">
            <div className="stat-k">30d cost</div>
            <div className="stat-v tnum">{formatCurrency(project.costUsd)}</div>
          </div>
          <div className="stat-box">
            <div className="stat-k">Sessions</div>
            <div className="stat-v tnum">{project.sessions}</div>
          </div>
          <div className="stat-box">
            <div className="stat-k">Prompts</div>
            <div className="stat-v tnum">{promptTotal.toLocaleString()}</div>
          </div>
          <div className="stat-box">
            <div className="stat-k">Tokens</div>
            <div className="stat-v tnum">
              {formatTokens(project.totalTokens)}
            </div>
          </div>
        </div>

        <div>
          <div className="section-label" style={{ marginBottom: 6 }}>
            Daily spend
          </div>
          {project.days.length === 0 ? (
            <div className="center-muted" style={{ minHeight: 60 }}>
              No daily spend recorded in the last 30 days.
            </div>
          ) : (
            <div className="day-bars" role="img" aria-label="Daily spend chart">
              {project.days.map((day) => (
                <span
                  key={day.day}
                  className={day.costUsd > 0 ? "bar" : "bar empty"}
                  style={{
                    height:
                      day.costUsd > 0
                        ? `${Math.max(3, (day.costUsd / (maxDayCost || 1)) * 100)}%`
                        : undefined,
                  }}
                  title={`${shortDate(day.day)} — ${formatCurrencyExact(day.costUsd)}`}
                />
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="section-label" style={{ marginBottom: 2 }}>
            Recent prompts
            <span className="link">
              <button
                type="button"
                className="assign-link"
                onClick={() => onOpenPrompts(project.id)}
              >
                Open in Library <ArrowRight size={10} aria-hidden="true" />
              </button>
            </span>
          </div>
          {prompts.length === 0 ? (
            <div className="center-muted" style={{ minHeight: 60 }}>
              No prompts recorded for this project.
            </div>
          ) : (
            prompts.map((prompt) => (
              <button
                type="button"
                className="row"
                key={prompt.id}
                onClick={() => onOpenPrompts(project.id)}
                style={{ paddingLeft: 0, paddingRight: 0 }}
              >
                <span
                  className="dot"
                  style={{ background: sourceAccent(prompt.source) }}
                />
                <div className="row-main">
                  <span className="row-title">{promptTitle(prompt)}</span>
                </div>
                <span className="row-side">
                  {formatNumber(prompt.estimatedTokens)} tok ·{" "}
                  {relativeTime(prompt.timestamp)}
                </span>
              </button>
            ))
          )}
        </div>

        {canManage && project.isUnassigned ? (
          <div className="banner info">
            <span>
              Add a rule in ~/.ziplyne-lens/config.json to match these
              repositories to a project.
            </span>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function promptTitle(prompt: PromptLibraryRecord): string {
  const text = prompt.preview.trim();
  if (!text || prompt.privacy === "encrypted") {
    return "Encrypted prompt";
  }
  const firstLine = text.split("\n")[0] ?? text;
  return firstLine.length > 88 ? `${firstLine.slice(0, 88)}…` : firstLine;
}
