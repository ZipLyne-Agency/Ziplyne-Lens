import type { LensSummary } from "@ziplyne/core/browser";
import { RangeTabs } from "../components/RangeTabs.js";
import { SpendChart } from "../components/SpendChart.js";
import { Panel, WorkspaceHeader } from "../components/Workspace.js";
import type { RangePreset } from "../lib/api.js";
import type { ProjectView } from "../lib/derive.js";
import {
  agentLabel,
  formatCurrency,
  formatCurrencyExact,
  formatTokens,
  modelLabel,
  percentValue,
  sourceAccent,
} from "../lib/format.js";

const RANGE_LABEL: Record<RangePreset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
  all: "All time",
};

interface SpendProps {
  summary: LensSummary;
  projects: ProjectView[];
  range: RangePreset;
  onRangeChange: (range: RangePreset) => void;
  /** Jump to Projects with the unassigned bucket selected. */
  onAssignUnassigned: () => void;
}

export function Spend({
  summary,
  projects,
  range,
  onRangeChange,
  onAssignUnassigned,
}: SpendProps) {
  const total = summary.totals.costUsd || 1;
  const agents = [...summary.sources].sort((a, b) => b.costUsd - a.costUsd);
  const models = [...summary.models].sort((a, b) => b.costUsd - a.costUsd);
  // Unassigned is never the headline: it sorts last and renders muted in
  // every cost breakdown.
  const namedProjects = projects
    .filter((project) => !project.isUnassigned)
    .sort((a, b) => b.costUsd - a.costUsd);
  const unassignedProject = projects.find((project) => project.isUnassigned);
  const repos = [...summary.projects].sort((a, b) => {
    const aUn = a.clientId === "unassigned" ? 1 : 0;
    const bUn = b.clientId === "unassigned" ? 1 : 0;
    return aUn - bUn || b.costUsd - a.costUsd;
  });

  return (
    <div className="workspace">
      <WorkspaceHeader
        title="Spend"
        subtitle={`${RANGE_LABEL[range]} · ${formatCurrency(summary.totals.costUsd)} · ${formatTokens(summary.totals.totalTokens)} tokens`}
      >
        <RangeTabs range={range} onChange={onRangeChange} />
      </WorkspaceHeader>

      <div className="content spend-grid">
        <div className="spend-top">
          <Panel label="Spend over time" flush>
            <div className="chart-fill">
              <SpendChart days={summary.days} />
            </div>
          </Panel>

          <Panel label="By agent" count={agents.length}>
            {agents.length === 0 ? (
              <div className="center-muted">No agent spend in this range.</div>
            ) : (
              agents.map((agent) => (
                <div className="row" key={agent.source}>
                  <span
                    className="dot"
                    style={{ background: sourceAccent(agent.source) }}
                  />
                  <div className="row-main">
                    <span className="row-title">
                      {agentLabel(agent.source)}
                    </span>
                  </div>
                  <ShareBar pct={percentValue(agent.costUsd, total)} />
                  <span className="row-side">
                    {formatCurrencyExact(agent.costUsd)}
                  </span>
                </div>
              ))
            )}
          </Panel>
        </div>

        <div className="spend-bottom">
          <Panel
            label="By project"
            action={
              <span className="panel-stat tnum">
                {formatCurrency(summary.totals.costUsd)}
              </span>
            }
          >
            {namedProjects.length === 0 && !unassignedProject ? (
              <div className="center-muted">
                No project spend in this range.
              </div>
            ) : (
              <>
                {namedProjects.map((project) => (
                  <div className="row" key={project.id}>
                    <div className="row-main">
                      <span className="row-title">{project.name}</span>
                    </div>
                    <ShareBar pct={project.shareOfSpend} />
                    <span className="row-side">
                      {formatCurrencyExact(project.costUsd)}
                    </span>
                  </div>
                ))}
                {unassignedProject && unassignedProject.costUsd > 0 ? (
                  <div className="row muted-row" key={unassignedProject.id}>
                    <div className="row-main">
                      <span className="row-title">Unassigned</span>
                    </div>
                    <button
                      type="button"
                      className="assign-link"
                      onClick={onAssignUnassigned}
                      title="Match this usage to a project"
                    >
                      Assign →
                    </button>
                    <ShareBar pct={unassignedProject.shareOfSpend} />
                    <span className="row-side">
                      {formatCurrencyExact(unassignedProject.costUsd)}
                    </span>
                  </div>
                ) : null}
              </>
            )}
          </Panel>

          <Panel
            label="By model"
            action={
              <span className="panel-stat tnum">
                {formatCurrency(summary.totals.costUsd)}
              </span>
            }
          >
            {models.length === 0 ? (
              <div className="center-muted">No model spend in this range.</div>
            ) : (
              models.map((model) => (
                <div className="row" key={model.model}>
                  <div className="row-main">
                    <span className="row-title">{modelLabel(model.model)}</span>
                  </div>
                  <ShareBar pct={percentValue(model.costUsd, total)} />
                  <span className="row-side">
                    {formatCurrencyExact(model.costUsd)}
                  </span>
                </div>
              ))
            )}
          </Panel>

          <Panel
            label="By repository"
            action={
              <span className="panel-stat tnum">
                {formatCurrency(summary.totals.costUsd)}
              </span>
            }
          >
            {repos.length === 0 ? (
              <div className="center-muted">
                No repository spend in this range.
              </div>
            ) : (
              repos.map((repo) => {
                const muted = repo.clientId === "unassigned";
                return (
                  <div
                    className={muted ? "row muted-row" : "row"}
                    key={repo.id}
                  >
                    <div className="row-main">
                      <span className="row-title">{repo.projectKey}</span>
                    </div>
                    <ShareBar pct={percentValue(repo.costUsd, total)} />
                    <span className="row-side">
                      {formatCurrencyExact(repo.costUsd)}
                    </span>
                  </div>
                );
              })
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function ShareBar({ pct }: { pct: number }) {
  return (
    <span className="share" aria-hidden="true">
      <span style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </span>
  );
}
