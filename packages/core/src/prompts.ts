import { resolveAttribution } from "./attribution.js";
import type {
  ClientRule,
  ProjectConfig,
  PromptLibrary,
  PromptLibraryRecord,
  PromptRecord,
} from "./types.js";

export interface PromptLibraryOptions {
  includeContent?: boolean;
  search?: string;
  clientId?: string;
  limit?: number;
  config?: ProjectConfig;
}

export function buildPromptLibrary(
  records: PromptRecord[],
  rules: ClientRule[],
  options: PromptLibraryOptions = {},
): PromptLibrary {
  const search = options.search?.trim().toLowerCase();
  const limit = options.limit ?? 250;
  const hiddenIds = new Set(
    Object.entries(options.config?.overrides ?? {})
      .filter(([, override]) => override.hidden)
      .map(([id]) => id),
  );
  // Attribute every record once (dropping hidden projects), then derive both the
  // filtered/limited view and the true per-project counts from it. Counts ignore
  // search/limit so the project detail shows the real total, not the page size.
  const attributed = records
    .map((record) =>
      withAttribution(record, rules, options.config, options.includeContent),
    )
    .filter((record) => !hiddenIds.has(record.clientId));

  const promptCounts: Record<string, number> = {};
  for (const record of attributed) {
    promptCounts[record.clientId] = (promptCounts[record.clientId] ?? 0) + 1;
  }

  // Parsers key prompts by session + timestamp, which can collide when one
  // message is logged in two forms (e.g. Codex's user_message event and its
  // response_item twin). React lists key on id, so make collisions unique
  // deterministically instead of dropping what might be distinct prompts.
  const seenIds = new Map<string, number>();
  const uniquePrompts = attributed.map((record) => {
    const seen = seenIds.get(record.id) ?? 0;
    seenIds.set(record.id, seen + 1);
    return seen === 0 ? record : { ...record, id: `${record.id}#${seen + 1}` };
  });

  const prompts = uniquePrompts
    .filter((record) =>
      options.clientId ? record.clientId === options.clientId : true,
    )
    .filter((record) => (search ? promptMatches(record, search) : true))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      prompts: records.length,
      visiblePrompts: records.filter((record) => record.privacy !== "encrypted")
        .length,
      encryptedPrompts: records.filter(
        (record) => record.privacy === "encrypted",
      ).length,
      estimatedTokens: prompts.reduce(
        (sum, record) => sum + record.estimatedTokens,
        0,
      ),
      clients: new Set(prompts.map((record) => record.clientId)).size,
    },
    promptCounts,
    prompts,
  };
}

export function redactPromptText(text: string): string {
  return (
    text
      .replace(
        /\b(?:api[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*["']?[^\s"',;]+/giu,
        "[redacted secret]",
      )
      // Provider key shapes (specific patterns run before the generic hex rule).
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/gu, "[redacted key]")
      .replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/gu, "[redacted key]")
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu, "[redacted key]")
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "[redacted token]")
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, "[redacted token]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gu, "Bearer [redacted]")
      .replace(/\b[A-Fa-f0-9]{32,}\b/gu, "[redacted token]")
      // All-caps key shapes (AWS-style, hex with letter prefixes like
      // "KEY019F..."): a 24+ run of capitals/digits is never prose.
      .replace(/\b[A-Z0-9]{24,}\b/gu, "[redacted key]")
      .replace(
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
        "[redacted email]",
      )
  );
}

export function promptPreview(text: string, maxLength = 180): string {
  const compact = redactPromptText(text).replace(/\s+/gu, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1).trim()}...`;
}

export function estimatedPromptTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function withAttribution(
  record: PromptRecord,
  rules: ClientRule[],
  config?: ProjectConfig,
  includeContent = false,
): PromptLibraryRecord {
  const attribution = resolveAttribution(
    // Forward repoName too: auto-match now keys on owner/repo, so omitting it
    // would collapse every prompt to "unassigned" (breaking the per-project
    // filter and letting a hidden project's prompts leak into the all view).
    { cwd: record.cwd, repoOwner: record.repoOwner, repoName: record.repoName },
    rules,
    config,
  );
  const sanitized = includeContent
    ? record
    : {
        ...record,
        content: undefined,
        privacy: record.privacy === "plain" ? "redacted" : record.privacy,
      };
  return { ...sanitized, ...attribution };
}

function promptMatches(record: PromptLibraryRecord, search: string): boolean {
  return [
    record.preview,
    record.content,
    record.clientName,
    record.projectKey,
    record.model,
    record.source,
    ...record.tags,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(search));
}
