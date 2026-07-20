import { isProjectHidden, resolveAttribution } from "./attribution.js";
import type {
  AccountSummaryRow,
  Attribution,
  ClientRule,
  ClientSummaryRow,
  DaySummaryRow,
  LensSummary,
  ModelSlice,
  ModelSummaryRow,
  ProjectConfig,
  ProjectSummaryRow,
  SourceSummaryRow,
  SummaryRow,
  UsageEvent,
} from "./types.js";

interface MutableRow extends SummaryRow {
  sessionIds: Set<string>;
  projectKeys: Set<string>;
}

// Active-time is estimated by counting distinct 5-minute windows in which the
// agent logged any activity. This reflects real working time: idle gaps (a
// session resumed days later) contribute nothing, unlike a raw first-to-last
// span which would count the whole calendar gap.
const ACTIVE_BUCKET_MS = 5 * 60_000;

// A client row additionally tracks per-model, per-day, and active-time windows so
// the project detail view can chart them without a second scan.
interface MutableClientRow extends ClientSummaryRow, MutableRow {
  modelMap: Map<string, ModelSlice>;
  dayMap: Map<string, DaySummaryRow>;
  activeBuckets: Set<number>;
}

export function aggregateUsage(
  events: UsageEvent[],
  rules: ClientRule[] = [],
  config?: ProjectConfig,
): LensSummary {
  const clients = new Map<string, MutableClientRow>();
  const projects = new Map<string, ProjectSummaryRow & MutableRow>();
  const sources = new Map<string, SourceSummaryRow & MutableRow>();
  const accounts = new Map<string, AccountSummaryRow & MutableRow>();
  const models = new Map<string, ModelSummaryRow & MutableRow>();
  const days = new Map<string, DaySummaryRow>();
  const unassigned: UsageEvent[] = [];
  const totals = emptyTotals();
  const allSessions = new Set<string>();
  const allProjects = new Set<string>();

  for (const event of events) {
    const attribution = resolveAttribution(event, rules, config);
    // Hidden projects are excluded from every metric, not just the project list.
    if (isProjectHidden(attribution, config)) {
      continue;
    }
    addToTotals(totals, event);
    allSessions.add(event.sessionId);
    allProjects.add(event.projectKey);
    if (attribution.clientId === "unassigned") {
      unassigned.push(event);
    }
    upsertClient(clients, attribution, event);
    upsertProject(projects, attribution, event);
    upsertSource(sources, event);
    if (event.account) {
      upsertAccount(accounts, event.account, event);
    }
    upsertModel(models, event);
    upsertDay(days, event);
  }

  totals.sessions = allSessions.size;
  totals.projects = allProjects.size;
  return {
    generatedAt: new Date().toISOString(),
    totals,
    clients: sortRows([...clients.values()].map(finalizeClientRow)),
    projects: sortRows([...projects.values()].map(finalizeProjectRow)),
    sources: sortRows([...sources.values()].map(finalizeSourceRow)),
    accounts: sortRows([...accounts.values()].map(finalizeAccountRow)),
    models: sortRows([...models.values()].map(finalizeModelRow)),
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    unassigned: unassigned.sort((a, b) => b.costUsd - a.costUsd).slice(0, 50),
  };
}

function upsertClient(
  rows: Map<string, MutableClientRow>,
  attribution: Attribution,
  event: UsageEvent,
): void {
  const row =
    rows.get(attribution.clientId) ??
    makeMutableClientRow(
      attribution.clientId,
      attribution.clientName,
      attribution.confidence,
    );
  addToRow(row, event);
  addClientBreakdowns(row, event);
  if (attribution.clientId === "unassigned") {
    row.unassignedEvents += 1;
  }
  rows.set(attribution.clientId, row);
}

// Accumulate the per-model, per-day, and per-session-span detail for a client.
function addClientBreakdowns(row: MutableClientRow, event: UsageEvent): void {
  const model = row.modelMap.get(event.model) ?? {
    model: event.model,
    costUsd: 0,
    totalTokens: 0,
  };
  model.costUsd = round(model.costUsd + event.costUsd);
  model.totalTokens += event.totalTokens;
  row.modelMap.set(event.model, model);

  const day = row.dayMap.get(event.day) ?? {
    day: event.day,
    costUsd: 0,
    totalTokens: 0,
  };
  day.costUsd = round(day.costUsd + event.costUsd);
  day.totalTokens += event.totalTokens;
  row.dayMap.set(event.day, day);

  const ms = Date.parse(event.timestamp);
  if (!Number.isNaN(ms)) {
    row.activeBuckets.add(Math.floor(ms / ACTIVE_BUCKET_MS));
  }
}

function upsertProject(
  rows: Map<string, ProjectSummaryRow & MutableRow>,
  attribution: Attribution,
  event: UsageEvent,
): void {
  const id = `${attribution.clientId}:${event.projectKey}`;
  const row =
    rows.get(id) ??
    ({
      ...makeMutableRow(id, event.projectKey),
      projectKey: event.projectKey,
      clientId: attribution.clientId,
      clientName: attribution.clientName,
      confidence: attribution.confidence,
    } as ProjectSummaryRow & MutableRow);
  row.cwd = row.cwd ?? event.cwd;
  addToRow(row, event);
  rows.set(id, row);
}

function upsertSource(
  rows: Map<string, SourceSummaryRow & MutableRow>,
  event: UsageEvent,
): void {
  const row =
    rows.get(event.source) ??
    ({
      ...makeMutableRow(event.source, event.source),
      source: event.source,
    } as SourceSummaryRow & MutableRow);
  addToRow(row, event);
  rows.set(event.source, row);
}

function upsertModel(
  rows: Map<string, ModelSummaryRow & MutableRow>,
  event: UsageEvent,
): void {
  const row =
    rows.get(event.model) ??
    ({
      ...makeMutableRow(event.model, event.model),
      model: event.model,
    } as ModelSummaryRow & MutableRow);
  addToRow(row, event);
  rows.set(event.model, row);
}

function upsertDay(rows: Map<string, DaySummaryRow>, event: UsageEvent): void {
  const row = rows.get(event.day) ?? {
    day: event.day,
    costUsd: 0,
    totalTokens: 0,
  };
  row.costUsd = round(row.costUsd + event.costUsd);
  row.totalTokens += event.totalTokens;
  rows.set(event.day, row);
}

function makeMutableClientRow(
  clientId: string,
  clientName: string,
  confidence: ClientSummaryRow["confidence"],
): MutableClientRow {
  return {
    ...makeMutableRow(clientId, clientName),
    clientId,
    clientName,
    confidence,
    unassignedEvents: 0,
    models: [],
    days: [],
    activeMs: 0,
    avgSessionMs: 0,
    modelMap: new Map(),
    dayMap: new Map(),
    activeBuckets: new Set(),
  } as MutableClientRow;
}

function makeMutableRow(id: string, name: string): MutableRow {
  return {
    id,
    name,
    costUsd: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    sessions: 0,
    projects: 0,
    eventCount: 0,
    sessionIds: new Set(),
    projectKeys: new Set(),
  };
}

function addToTotals(row: LensSummary["totals"], event: UsageEvent): void {
  row.costUsd = round(row.costUsd + event.costUsd);
  row.totalTokens += event.totalTokens;
  row.inputTokens += event.inputTokens;
  row.outputTokens += event.outputTokens;
  row.cacheCreationTokens += event.cacheCreationTokens;
  row.cacheReadTokens += event.cacheReadTokens;
  row.reasoningTokens += event.reasoningTokens;
  row.eventCount += 1;
}

function addToRow(row: MutableRow, event: UsageEvent): void {
  row.costUsd = round(row.costUsd + event.costUsd);
  row.totalTokens += event.totalTokens;
  row.inputTokens += event.inputTokens;
  row.outputTokens += event.outputTokens;
  row.cacheCreationTokens += event.cacheCreationTokens;
  row.cacheReadTokens += event.cacheReadTokens;
  row.reasoningTokens += event.reasoningTokens;
  row.sessionIds.add(event.sessionId);
  row.projectKeys.add(event.projectKey);
  row.sessions = row.sessionIds.size;
  row.projects = row.projectKeys.size;
  row.eventCount += 1;
}

function emptyTotals(): LensSummary["totals"] {
  return {
    costUsd: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    sessions: 0,
    projects: 0,
    eventCount: 0,
  };
}

function finalizeClientRow(row: MutableClientRow): ClientSummaryRow {
  const activeMs = row.activeBuckets.size * ACTIVE_BUCKET_MS;
  const sessionCount = row.sessionIds.size;
  const models = [...row.modelMap.values()].sort(
    (a, b) => b.costUsd - a.costUsd,
  );
  const days = [...row.dayMap.values()].sort((a, b) =>
    a.day.localeCompare(b.day),
  );
  const {
    sessionIds: _sessionIds,
    projectKeys: _projectKeys,
    modelMap: _modelMap,
    dayMap: _dayMap,
    activeBuckets: _activeBuckets,
    ...clean
  } = row;
  return {
    ...clean,
    models,
    days,
    activeMs,
    avgSessionMs: sessionCount > 0 ? Math.round(activeMs / sessionCount) : 0,
  };
}

function finalizeProjectRow(
  row: ProjectSummaryRow & MutableRow,
): ProjectSummaryRow {
  const { sessionIds: _sessionIds, projectKeys: _projectKeys, ...clean } = row;
  return clean;
}

function finalizeSourceRow(
  row: SourceSummaryRow & MutableRow,
): SourceSummaryRow {
  const { sessionIds: _sessionIds, projectKeys: _projectKeys, ...clean } = row;
  return clean;
}

function upsertAccount(
  rows: Map<string, AccountSummaryRow & MutableRow>,
  account: string,
  event: UsageEvent,
): void {
  const key = `${event.source}:${account}`;
  const row =
    rows.get(key) ??
    ({
      ...makeMutableRow(key, account),
      source: event.source,
      account,
    } as AccountSummaryRow & MutableRow);
  addToRow(row, event);
  rows.set(key, row);
}

function finalizeAccountRow(
  row: AccountSummaryRow & MutableRow,
): AccountSummaryRow {
  const { sessionIds: _sessionIds, projectKeys: _projectKeys, ...clean } = row;
  return clean;
}

function finalizeModelRow(row: ModelSummaryRow & MutableRow): ModelSummaryRow {
  const { sessionIds: _sessionIds, projectKeys: _projectKeys, ...clean } = row;
  return clean;
}

function sortRows<T extends { costUsd: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.costUsd - a.costUsd);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
