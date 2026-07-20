import type {
  Attribution,
  ClientRule,
  ProjectConfig,
  UsageEvent,
} from "./types.js";

const UNASSIGNED: Attribution = {
  clientId: "unassigned",
  clientName: "Unassigned",
  confidence: "none",
};

export function attributeClient(
  cwd: string | undefined,
  rules: ClientRule[],
): Attribution {
  if (!cwd) {
    return UNASSIGNED;
  }
  const normalizedCwd = normalizePath(cwd);
  for (const rule of rules) {
    const needle = normalizePath(rule.match);
    if (normalizedCwd.includes(needle)) {
      return {
        clientId: rule.clientId,
        clientName: rule.clientName,
        confidence: "high",
        rule: rule.match,
      };
    }
  }
  return UNASSIGNED;
}

// Full project resolution: manual rules win, then git-repo auto-matching (when
// enabled), then unassigned. A project is a single git REPOSITORY (owner/repo),
// not the GitHub org — each repo is its own project. A rename override replaces
// the display name for the resolved project id.
export function resolveAttribution(
  event: Pick<UsageEvent, "cwd" | "repoOwner" | "repoName">,
  rules: ClientRule[],
  config?: ProjectConfig,
): Attribution {
  const ruled = attributeClient(event.cwd, rules);
  if (ruled.clientId !== "unassigned") {
    return applyOverride(ruled, config);
  }
  const autoMatch = config?.autoMatch ?? true;
  if (autoMatch && event.repoName) {
    // Key by owner/repo so same-named repos under different owners stay
    // distinct; show just the repo name as the default label.
    const clientId = event.repoOwner
      ? `${event.repoOwner}/${event.repoName}`
      : event.repoName;
    return applyOverride(
      {
        clientId,
        clientName: event.repoName,
        confidence: "medium",
      },
      config,
    );
  }
  return UNASSIGNED;
}

// A project is hidden when its resolved id carries a hidden override.
export function isProjectHidden(
  attribution: Attribution,
  config?: ProjectConfig,
): boolean {
  return config?.overrides?.[attribution.clientId]?.hidden === true;
}

function applyOverride(
  attribution: Attribution,
  config?: ProjectConfig,
): Attribution {
  const name = config?.overrides?.[attribution.clientId]?.name;
  return name ? { ...attribution, clientName: name } : attribution;
}

export function inferProjectKey(
  cwd: string | undefined,
  fallback: string,
): string {
  const raw = cwd || fallback;
  const cleaned = raw
    .replace(/^\/Users\/[^/]+\//u, "")
    .replace(/^-Users-[^-]+-/u, "")
    .replaceAll("/", "-")
    .replaceAll("\\", "-")
    .replace(/\.jsonl$/u, "")
    .trim();
  if (!cleaned) {
    return "Unknown";
  }
  const parts = cleaned.split("-").filter(Boolean);
  if (parts.length > 2 && parts[0] === "Users") {
    return parts.slice(2).join("-");
  }
  return parts.join("-") || "Unknown";
}

function normalizePath(value: string): string {
  return value.toLowerCase().replaceAll("\\", "/");
}
