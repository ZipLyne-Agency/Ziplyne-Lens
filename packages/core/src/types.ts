export type UsageSource = "claude" | "codex" | "kimi" | "grok";

export type CostSource = "recorded" | "calculated" | "missing-pricing";

export type AttributionConfidence = "high" | "medium" | "none";

export interface UsageEvent {
  id: string;
  source: UsageSource;
  timestamp: string;
  day: string;
  sessionId: string;
  projectKey: string;
  cwd?: string;
  gitBranch?: string;
  repoOwner?: string;
  repoName?: string;
  // Which local profile the event came from. Claude Code users often run
  // several accounts side by side (~/.claude, ~/.claude-azl, ~/.claude-izl,
  // ...); this is the directory suffix, e.g. "default" | "azl" | "izl".
  account?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  costSource: CostSource;
}

export interface UsageInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}

export interface ParseContext {
  filePath: string;
  // Claude Code profile the file belongs to (see claudeAccountFor in scan.ts).
  account?: string;
}

export type PromptPrivacy =
  | "plain"
  | "redacted"
  | "encrypted"
  | "metadata-only";

export interface PromptRecord {
  id: string;
  source: UsageSource;
  timestamp: string;
  day: string;
  sessionId: string;
  projectKey: string;
  cwd?: string;
  gitBranch?: string;
  repoOwner?: string;
  repoName?: string;
  model?: string;
  role: "user";
  preview: string;
  content?: string;
  contentLength: number;
  estimatedTokens: number;
  privacy: PromptPrivacy;
  tags: string[];
}

export interface PromptLibraryRecord extends PromptRecord {
  clientId: string;
  clientName: string;
  confidence: AttributionConfidence;
  rule?: string;
}

export interface PromptLibrary {
  generatedAt: string;
  totals: {
    prompts: number;
    visiblePrompts: number;
    encryptedPrompts: number;
    estimatedTokens: number;
    clients: number;
  };
  // Prompt count per resolved project id (clientId), ignoring search/limit.
  promptCounts: Record<string, number>;
  prompts: PromptLibraryRecord[];
}

export interface ClientRule {
  clientId: string;
  clientName: string;
  match: string;
}

// Per-project user overrides, keyed by project id (a rule clientId or a git
// owner). Lets a project be renamed or hidden from all analytics.
export interface ProjectOverride {
  name?: string;
  hidden?: boolean;
}

export interface ProjectConfig {
  overrides?: Record<string, ProjectOverride>;
  // When true (the default), repositories are grouped into projects by their
  // git remote owner. When false, only manual clientRules apply.
  autoMatch?: boolean;
}

export interface Attribution {
  clientId: string;
  clientName: string;
  confidence: AttributionConfidence;
  rule?: string;
}

export interface SummaryRow {
  id: string;
  name: string;
  costUsd: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  sessions: number;
  projects: number;
  eventCount: number;
}

export interface ProjectSummaryRow extends SummaryRow {
  projectKey: string;
  clientId: string;
  clientName: string;
  confidence: AttributionConfidence;
  cwd?: string;
}

export interface ModelSlice {
  model: string;
  costUsd: number;
  totalTokens: number;
}

export interface ClientSummaryRow extends SummaryRow {
  clientId: string;
  clientName: string;
  confidence: AttributionConfidence;
  unassignedEvents: number;
  // Per-client breakdowns for the project detail view.
  models: ModelSlice[];
  days: DaySummaryRow[];
  // Agent working time, approximated by counting distinct 5-minute windows in
  // which the agent logged any activity (so idle calendar gaps in a resumed
  // session don't inflate it). avgSessionMs = activeMs / session count.
  activeMs: number;
  avgSessionMs: number;
}

export interface SourceSummaryRow extends SummaryRow {
  source: UsageSource;
}

// Per local-profile breakdown within a source (multi-account Claude setups).
export interface AccountSummaryRow extends SummaryRow {
  source: UsageSource;
  account: string;
}

export interface ModelSummaryRow extends SummaryRow {
  model: string;
}

export interface DaySummaryRow {
  day: string;
  costUsd: number;
  totalTokens: number;
}

export interface LensSummary {
  generatedAt: string;
  totals: {
    costUsd: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    reasoningTokens: number;
    sessions: number;
    projects: number;
    eventCount: number;
  };
  clients: ClientSummaryRow[];
  projects: ProjectSummaryRow[];
  sources: SourceSummaryRow[];
  accounts: AccountSummaryRow[];
  models: ModelSummaryRow[];
  days: DaySummaryRow[];
  unassigned: UsageEvent[];
}
