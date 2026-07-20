export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
    style: "currency",
  }).format(value);
}

// Always shows cents. Use where a precise cost matters (per-repo, per-prompt).
export function formatCurrencyExact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: value >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 KB";
  }
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) {
    return "0m";
  }
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 100) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${hours}h`;
}

export function percent(value: number, total: number): string {
  if (total <= 0) {
    return "0%";
  }
  return `${Math.round((value / total) * 100)}%`;
}

export function percentValue(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return (value / total) * 100;
}

// Two-letter monogram from a display name, e.g. "Northstar Health" -> "NH".
export function initials(name: string): string {
  const words = name
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const first = words[0];
  if (!first) {
    return "?";
  }
  const second = words[1];
  if (!second) {
    return first.slice(0, 2).toUpperCase();
  }
  return ((first[0] ?? "") + (second[0] ?? "")).toUpperCase();
}

const ACCENTS: Array<[string, string]> = [
  ["#f59e0b", "#d97706"],
  ["#06b6d4", "#0891b2"],
  ["#8b5cf6", "#6d28d9"],
  ["#ec4899", "#be185d"],
  ["#14b8a6", "#0d9488"],
  ["#3b82f6", "#2563eb"],
  ["#10b981", "#059669"],
  ["#f43f5e", "#e11d48"],
];

// Deterministic gradient for a name so avatars stay stable across renders.
export function accentFor(key: string): { from: string; to: string } {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  const pair =
    ACCENTS[hash % ACCENTS.length] ?? (["#3b82f6", "#2563eb"] as const);
  return { from: pair[0], to: pair[1] };
}

export function gradientFor(key: string): string {
  const { from, to } = accentFor(key);
  return `linear-gradient(145deg, ${from}, ${to})`;
}

// Friendly model names for non-technical readers.
const MODEL_NAMES: Record<string, string> = {
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-fable-5": "Claude Fable 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
};

export function modelLabel(model: string): string {
  if (MODEL_NAMES[model]) {
    return MODEL_NAMES[model];
  }
  return model
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) =>
      part.length <= 2
        ? part.toUpperCase()
        : (part[0] ?? "").toUpperCase() + part.slice(1),
    )
    .join(" ");
}

export function sourceLabel(source: string): string {
  if (source === "claude") {
    return "Claude Code";
  }
  if (source === "codex") {
    return "Codex CLI";
  }
  if (source === "kimi") {
    return "Kimi Code";
  }
  if (source === "grok") {
    return "Grok CLI";
  }
  return source;
}

// Short agent names (no "Code"/"CLI" suffix) for compact badges and cards.
export function agentLabel(source: string): string {
  if (source === "claude") {
    return "Claude";
  }
  if (source === "codex") {
    return "Codex";
  }
  if (source === "kimi") {
    return "Kimi";
  }
  if (source === "grok") {
    return "Grok";
  }
  return source;
}

// Per-agent accent used for dots, badges and chart series.
export function sourceAccent(source: string): string {
  if (source === "claude") {
    return "#D97757";
  }
  if (source === "codex") {
    return "#10A37F";
  }
  if (source === "kimi") {
    return "#8B7CFF";
  }
  if (source === "grok") {
    return "#5B8DC9";
  }
  return "#6E5BFF";
}

// Live-session provider names (from the terminal scanner) -> the same accent
// family as usage sources, plus neutral fallbacks for providers we don't bill.
export function providerAccent(provider: string | null | undefined): string {
  if (!provider) {
    return "#626D82";
  }
  const key = provider.toLowerCase();
  if (key === "gemini") {
    return "#5EA3E8";
  }
  if (key === "aider") {
    return "#9AA4B8";
  }
  return sourceAccent(key);
}

// Live provider name -> pbadge modifier class (p-claude/p-codex/…). Unknown
// providers fall back to the neutral badge.
export function providerBadgeClass(
  provider: string | null | undefined,
): string {
  const key = provider?.toLowerCase() ?? "";
  if (key === "claude" || key === "codex" || key === "kimi" || key === "grok") {
    return `pbadge p-${key}`;
  }
  return "pbadge";
}

// Usage-source id -> pbadge modifier class.
export function sourceBadgeClass(source: string): string {
  return providerBadgeClass(source);
}

// "2m ago" style relative time.
export function relativeTime(iso: string | undefined): string {
  if (!iso) {
    return "";
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diffMs = Date.now() - then;
  const min = Math.round(diffMs / 60_000);
  if (min < 1) {
    return "just now";
  }
  if (min < 60) {
    return `${min}m ago`;
  }
  const hours = Math.round(min / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function shortDate(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return day;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
}

// Reset timestamps on usage limits: clock time when the reset is today,
// weekday + clock when it's further out. Local time, matching the macOS UI.
export function formatResetTime(iso: string | null | undefined): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (sameDay) {
    return time;
  }
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(
    date,
  );
  return `${day} ${time}`;
}

// Compact token counts: 86.8M / 1.2K. One decimal only when it carries
// information (so 900 -> "900", not "900.0").
export function formatTokensCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
