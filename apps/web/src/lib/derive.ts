import type {
  ClientSummaryRow,
  DaySummaryRow,
  LensSummary,
  ModelSlice,
  ProjectSummaryRow,
} from "@ziplyne/core/browser";
import { percentValue } from "./format.js";

// The billable entity. In the data model this is a "client" row; the product
// calls it a Project. Its git repos are Repositories.
export interface ProjectView {
  id: string;
  name: string;
  owner?: string;
  costUsd: number;
  totalTokens: number;
  sessions: number;
  repositories: number;
  confidence: "high" | "medium" | "none";
  isUnassigned: boolean;
  shareOfSpend: number;
  models: ModelSlice[];
  days: DaySummaryRow[];
  activeMs: number;
  avgSessionMs: number;
}

export interface RepositoryView {
  id: string;
  name: string;
  projectName: string;
  cwd?: string;
  costUsd: number;
  totalTokens: number;
  sessions: number;
}

export interface MixSlice {
  key: string;
  label: string;
  costUsd: number;
  pct: number;
}

export interface Delta {
  pct: number;
  direction: "up" | "down" | "flat";
  hasBasis: boolean;
}

export function toProjectViews(summary: LensSummary): ProjectView[] {
  const total = summary.totals.costUsd || 1;
  return summary.clients.map((row: ClientSummaryRow) => ({
    id: row.clientId,
    name: row.clientId === "unassigned" ? "Unassigned" : row.clientName,
    // Auto-matched projects are keyed "owner/repo"; expose the owner as context.
    owner: row.clientId.includes("/") ? row.clientId.split("/")[0] : undefined,
    costUsd: row.costUsd,
    totalTokens: row.totalTokens,
    sessions: row.sessions,
    repositories: row.projects,
    confidence: row.confidence,
    isUnassigned: row.clientId === "unassigned",
    shareOfSpend: percentValue(row.costUsd, total),
    models: row.models,
    days: row.days,
    activeMs: row.activeMs,
    avgSessionMs: row.avgSessionMs,
  }));
}

export function repositoriesForProject(
  summary: LensSummary,
  projectId: string,
): RepositoryView[] {
  return summary.projects
    .filter((row: ProjectSummaryRow) => row.clientId === projectId)
    .map((row) => ({
      id: row.id,
      name: row.projectKey,
      projectName:
        row.clientId === "unassigned" ? "Unassigned" : row.clientName,
      cwd: row.cwd,
      costUsd: row.costUsd,
      totalTokens: row.totalTokens,
      sessions: row.sessions,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

export function modelMix(summary: LensSummary): MixSlice[] {
  const total = summary.totals.costUsd || 1;
  return summary.models
    .map((row) => ({
      key: row.model,
      label: row.model,
      costUsd: row.costUsd,
      pct: percentValue(row.costUsd, total),
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 5);
}

export function sourceMix(summary: LensSummary): MixSlice[] {
  const total = summary.totals.costUsd || 1;
  return summary.sources
    .map((row) => ({
      key: row.source,
      label: row.source,
      costUsd: row.costUsd,
      pct: percentValue(row.costUsd, total),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

// Period-over-period delta: sum the most recent half of the day series vs the
// prior half. Honest and basis-aware; returns hasBasis=false when there are too
// few days to compare, so the UI can hide the chip instead of faking a trend.
export function spendDelta(days: DaySummaryRow[]): Delta {
  return deltaFromSeries(days.map((d) => d.costUsd));
}

export function tokenDelta(days: DaySummaryRow[]): Delta {
  return deltaFromSeries(days.map((d) => d.totalTokens));
}

function deltaFromSeries(series: number[]): Delta {
  if (series.length < 4) {
    return { pct: 0, direction: "flat", hasBasis: false };
  }
  const mid = Math.floor(series.length / 2);
  const prior = sum(series.slice(0, mid));
  const recent = sum(series.slice(mid));
  if (prior <= 0) {
    return { pct: 0, direction: "flat", hasBasis: false };
  }
  const pct = ((recent - prior) / prior) * 100;
  const direction = pct > 1 ? "up" : pct < -1 ? "down" : "flat";
  return { pct: Math.abs(pct), direction, hasBasis: true };
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

export interface CostVelocity {
  perDay: number;
  peakDay: DaySummaryRow | undefined;
  activeDays: number;
}

export interface PeriodSums {
  today: DaySummaryRow | undefined;
  yesterday: DaySummaryRow | undefined;
  week: { costUsd: number; totalTokens: number };
  priorWeek: { costUsd: number; totalTokens: number };
}

// Hero-metric windows. Event days are UTC (the parsers slice ISO timestamps),
// so "today" and the 7-day windows use UTC days too — same rule as the API's
// per-agent burn.
export function periodSums(days: DaySummaryRow[]): PeriodSums {
  const byDay = new Map(days.map((day) => [day.day, day] as const));
  const utcDay = (offset: number): string =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const windowSum = (
    fromOffset: number,
    toOffset: number,
  ): { costUsd: number; totalTokens: number } => {
    let costUsd = 0;
    let totalTokens = 0;
    for (let offset = fromOffset; offset <= toOffset; offset += 1) {
      const row = byDay.get(utcDay(offset));
      if (row) {
        costUsd += row.costUsd;
        totalTokens += row.totalTokens;
      }
    }
    return { costUsd, totalTokens };
  };
  return {
    today: byDay.get(utcDay(0)),
    yesterday: byDay.get(utcDay(-1)),
    week: windowSum(-6, 0),
    priorWeek: windowSum(-13, -7),
  };
}

export function costVelocity(summary: LensSummary): CostVelocity {
  const days = summary.days;
  const activeDays = days.length || 1;
  const peakDay = days.reduce<DaySummaryRow | undefined>(
    (peak, day) => (!peak || day.costUsd > peak.costUsd ? day : peak),
    undefined,
  );
  return {
    perDay: summary.totals.costUsd / activeDays,
    peakDay,
    activeDays: days.length,
  };
}

export interface TopSpendUnit {
  id: string;
  name: string;
  costUsd: number;
  pct: number;
}

export interface TopSpend {
  title: string;
  units: TopSpendUnit[];
}

// The Overview "top spend" list. When usage has been matched into projects we
// rank projects; before any matching exists (the default state, everything
// unassigned) we rank repositories instead, so the card is never empty.
export function topSpendUnits(
  summary: LensSummary,
  projects: ProjectView[],
): TopSpend {
  const total = summary.totals.costUsd || 1;
  const billable = projects
    .filter((project) => !project.isUnassigned)
    .sort((a, b) => b.costUsd - a.costUsd);
  if (billable.length > 0) {
    return {
      title: "Top projects",
      units: billable.slice(0, 5).map((project) => ({
        id: project.id,
        name: project.name,
        costUsd: project.costUsd,
        pct: project.shareOfSpend,
      })),
    };
  }
  return {
    title: "Top repositories",
    units: [...summary.projects]
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 5)
      .map((row) => ({
        id: row.id,
        name: row.projectKey,
        costUsd: row.costUsd,
        pct: percentValue(row.costUsd, total),
      })),
  };
}

export function topProject(projects: ProjectView[]): ProjectView | undefined {
  return projects
    .filter((project) => !project.isUnassigned)
    .reduce<ProjectView | undefined>(
      (top, project) => (!top || project.costUsd > top.costUsd ? project : top),
      undefined,
    );
}

export function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) {
    return "Good morning";
  }
  if (hour < 18) {
    return "Good afternoon";
  }
  return "Good evening";
}

export function longDate(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
}
