// Active remote connections across all terminal sessions — a TypeScript port
// of Sesshy's session detection (SSH, databases, tunnels, cloud CLIs) layered
// next to the agent-session monitor in live.ts.
//
// Detection is 100% subprocess-based (ps + lsof + git), matching Sesshy:
//   1. `ps -ax -o pid= -o ppid= -o tty= -o etimes= -o command=` snapshot
//      (falls back to `etime=` on macOS ps builds without `etimes`)
//   2. candidate filter: real TTY, skip interactive shell/viewer binaries
//   3. `lsof -a -n -P -p <pids> -i` for socket endpoints (batched)
//   4. classify: ssh family / kubectl port-forward / databases / agent catalog
//      / cloud-CLI registry / fallback "has remote socket"
//   5. terminal attribution via parent-chain walk, git enrichment per cwd
//
// Deviations from Sesshy: mysql/redis-cli/mongosh were added next to psql,
// and "zed"/"code" join the terminal-name map.
//
// Command lines are always redacted before leaving this module.

import { basename } from "node:path";
import {
  agentTitleFor,
  agentTitleFromPath,
  type CommandRunner,
  defaultRunner,
} from "./live.js";

export type ConnectionKind =
  | "ssh"
  | "database"
  | "tunnel"
  | "cloud"
  | "agent"
  | "other";

export interface SocketEndpoint {
  local: string;
  remote: string;
  state?: string;
}

export interface ConnectionSession {
  id: string; // "<pid>:<tty>"
  pid: number;
  tty: string;
  terminalName: string;
  kind: ConnectionKind;
  title: string; // "SSH", "PostgreSQL", "Port Forward", "AWS", ...
  target: string; // host / db / resource / context the session points at
  subtitle: string; // remote endpoint, port mapping, or cwd
  commandLine: string; // redacted
  workingDirectory?: string;
  elapsedSeconds: number;
  connections: SocketEndpoint[];
  gitBranch?: string;
  gitRepoRoot?: string;
}

export interface ConnectionsPayload {
  generatedAt: string;
  counts: Record<ConnectionKind | "total", number>;
  sessions: ConnectionSession[];
}

export interface ProcessSnapshot {
  pid: number;
  parentPid: number;
  tty: string;
  elapsedSeconds: number;
  commandLine: string;
}

export interface SocketConnection {
  pid: number;
  localEndpoint: string;
  remoteEndpoint: string;
  state?: string;
}

// ---------------------------------------------------------------------------
// ps / lsof parsing (ported from Sesshy's ProcessSnapshotParser)
// ---------------------------------------------------------------------------

// Elapsed time comes from ps as either integer seconds (`etimes`, Sesshy's
// keyword) or `[[dd-]hh:]mm:ss` (`etime`, the only form some macOS ps builds
// accept). Both parse to seconds.
export function parseElapsedSeconds(token: string): number | null {
  if (/^\d+$/u.test(token)) {
    return Number(token);
  }
  const match = token.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})$/u);
  if (!match) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  if (!minutes || !seconds) {
    return null;
  }
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

export function parsePsSnapshots(output: string): ProcessSnapshot[] {
  const snapshots: ProcessSnapshot[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/u);
    if (!match) {
      continue;
    }
    const [, pid, parentPid, tty, elapsed, commandLine] = match;
    const elapsedSeconds = elapsed ? parseElapsedSeconds(elapsed) : null;
    if (!pid || !parentPid || !tty || elapsedSeconds === null || !commandLine) {
      continue;
    }
    snapshots.push({
      pid: Number(pid),
      parentPid: Number(parentPid),
      tty,
      elapsedSeconds,
      commandLine,
    });
  }
  return snapshots;
}

export function parseLsofConnections(output: string): SocketConnection[] {
  const connections: SocketConnection[] = [];
  for (const line of output.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 10) {
      continue;
    }
    const pid = Number(parts[1]);
    if (!Number.isInteger(pid)) {
      continue;
    }
    const stateToken = parts[parts.length - 1] ?? "";
    let state: string | undefined;
    let endpoint: string;
    if (stateToken.startsWith("(")) {
      state = stateToken.replace(/[()]/gu, "");
      endpoint = parts[parts.length - 2] ?? "";
    } else {
      endpoint = stateToken;
    }
    const arrow = endpoint.indexOf("->");
    const localEndpoint = arrow >= 0 ? endpoint.slice(0, arrow) : endpoint;
    const remoteEndpoint = arrow >= 0 ? endpoint.slice(arrow + 2) : endpoint;
    connections.push({ pid, localEndpoint, remoteEndpoint, state });
  }
  return connections;
}

// Shell-like tokenizer: single/double quotes group, backslash escapes the
// next character, unquoted whitespace splits. Ported from Sesshy.
export function shellSplit(commandLine: string): string[] {
  const results: string[] = [];
  let current = "";
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let isEscaping = false;

  for (const character of commandLine) {
    if (isEscaping) {
      current += character;
      isEscaping = false;
      continue;
    }
    if (character === "\\") {
      isEscaping = true;
      continue;
    }
    if (character === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
      continue;
    }
    if (character === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
      continue;
    }
    if (/\s/u.test(character) && !inSingleQuotes && !inDoubleQuotes) {
      if (current.length > 0) {
        results.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current.length > 0) {
    results.push(current);
  }
  return results;
}

function executableNameOf(commandLine: string): string {
  const first = shellSplit(commandLine)[0] ?? commandLine;
  return basename(first).toLowerCase();
}

// ---------------------------------------------------------------------------
// Candidate filter (Sesshy's SessionScannerSupport.candidateProcesses)
// ---------------------------------------------------------------------------

const IGNORED_INTERACTIVE_EXECUTABLES = new Set([
  "bash",
  "cat",
  "fish",
  "less",
  "login",
  "man",
  "nano",
  "screen",
  "sh",
  "tail",
  "tmux",
  "top",
  "vim",
  "vi",
  "zsh",
]);

// ---------------------------------------------------------------------------
// Endpoint filtering (loopback/listen endpoints are not remote connections)
// ---------------------------------------------------------------------------

export function isLocalEndpoint(endpoint: string): boolean {
  const lowercased = endpoint.toLowerCase();
  return (
    lowercased.startsWith("127.") ||
    lowercased.startsWith("localhost") ||
    lowercased.startsWith("[::1]") ||
    lowercased.startsWith("::1") ||
    lowercased.startsWith("0.0.0.0") ||
    lowercased.startsWith("*:")
  );
}

function primaryRemoteEndpoint(
  connections: readonly SocketConnection[],
): string | null {
  const hit = connections.find(
    (connection) =>
      connection.localEndpoint !== connection.remoteEndpoint &&
      !isLocalEndpoint(connection.remoteEndpoint),
  );
  return hit?.remoteEndpoint ?? null;
}

// ---------------------------------------------------------------------------
// ssh family target extraction (option-value skipping, ported from Sesshy)
// ---------------------------------------------------------------------------

const SSH_OPTION_ARGS = new Set([
  "-i",
  "-p",
  "-l",
  "-J",
  "-F",
  "-o",
  "-S",
  "-W",
  "-L",
  "-R",
  "-D",
  "-b",
  "-c",
  "-E",
  "-m",
  "-Q",
  "-w",
]);

export function extractSshTarget(args: readonly string[]): string | null {
  let skipNext = false;
  for (const token of args.slice(1)) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (SSH_OPTION_ARGS.has(token)) {
      skipNext = true;
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return token;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Database target parsing (psql ported from Sesshy; mysql/redis-cli/mongosh
// follow the same pattern)
// ---------------------------------------------------------------------------

export interface DatabaseTarget {
  host: string;
  database: string;
}

function parseUrlTarget(token: string): DatabaseTarget | null {
  try {
    const url = new URL(token);
    const segments = url.pathname.split("/").filter(Boolean);
    return {
      host: url.hostname || "localhost",
      database: segments[segments.length - 1] ?? "",
    };
  } catch {
    return null;
  }
}

export function parsePostgresTarget(args: readonly string[]): DatabaseTarget {
  const rest = args.slice(1);
  const first = rest[0];
  if (first?.includes("://")) {
    const parsed = parseUrlTarget(first);
    if (parsed) {
      return parsed;
    }
  }

  let host = "localhost";
  let database = "";
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (token === "-h" || token === "--host") {
      index += 1;
      host = rest[index] ?? host;
      continue;
    }
    if (token === "-d" || token === "--dbname") {
      index += 1;
      database = rest[index] ?? database;
      continue;
    }
    if (!token.startsWith("-") && !database) {
      database = token;
    }
  }
  return { host, database };
}

export function parseMysqlTarget(args: readonly string[]): DatabaseTarget {
  let host = "localhost";
  let database = "";
  const rest = args.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (token === "-h" || token === "--host") {
      index += 1;
      host = rest[index] ?? host;
      continue;
    }
    if (token.startsWith("--host=")) {
      host = token.slice("--host=".length) || host;
      continue;
    }
    if (token === "-D" || token === "--database") {
      index += 1;
      database = rest[index] ?? database;
      continue;
    }
    if (token.startsWith("--database=")) {
      database = token.slice("--database=".length) || database;
      continue;
    }
    // mysql's -p takes its password inline (or prompts); it never consumes
    // the next token, unlike -u/-P/-S which do.
    if (token === "-p" || token.startsWith("--password")) {
      continue;
    }
    if (
      token === "-u" ||
      token === "--user" ||
      token === "-P" ||
      token === "--port" ||
      token === "-S" ||
      token === "--socket"
    ) {
      index += 1;
      continue;
    }
    if (!token.startsWith("-") && !database) {
      database = token;
    }
  }
  return { host, database };
}

export function parseRedisTarget(args: readonly string[]): DatabaseTarget {
  let host = "localhost";
  const rest = args.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (token === "-h" || token === "--host") {
      index += 1;
      host = rest[index] ?? host;
      continue;
    }
    if (token.startsWith("--host=")) {
      host = token.slice("--host=".length) || host;
    }
  }
  return { host, database: "" };
}

export function parseMongoTarget(args: readonly string[]): DatabaseTarget {
  const rest = args.slice(1);
  const urlToken = rest.find((token) => token.includes("://"));
  if (urlToken) {
    const parsed = parseUrlTarget(urlToken);
    if (parsed) {
      return parsed;
    }
  }

  let host = "localhost";
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--host") {
      index += 1;
      host = rest[index] ?? host;
      continue;
    }
    if (token.startsWith("--host=")) {
      host = token.slice("--host=".length) || host;
    }
  }
  return { host, database: "" };
}

// ---------------------------------------------------------------------------
// Cloud-CLI registry (Sesshy's 30 built-in CLISessionDefinitions) + context
// flag extraction
// ---------------------------------------------------------------------------

export interface CloudCliDefinition {
  executables: string[];
  title: string;
  contextFlags: string[];
  credentialPaths: string[];
}

const CLOUD_CLI_DEFINITIONS: CloudCliDefinition[] = [
  {
    executables: ["aws"],
    title: "AWS CLI",
    contextFlags: [],
    credentialPaths: [
      "~/.aws/credentials",
      "~/.aws/config",
      "~/.aws/sso/cache",
    ],
  },
  {
    executables: ["gcloud"],
    title: "Google Cloud CLI",
    contextFlags: [],
    credentialPaths: [
      "~/.config/gcloud/credentials.db",
      "~/.config/gcloud/application_default_credentials.json",
    ],
  },
  {
    executables: ["az"],
    title: "Azure CLI",
    contextFlags: [],
    credentialPaths: [
      "~/.azure/msal_token_cache.json",
      "~/.azure/accessTokens.json",
    ],
  },
  {
    executables: ["gh"],
    title: "GitHub CLI",
    contextFlags: [],
    credentialPaths: ["~/.config/gh/hosts.yml"],
  },
  {
    executables: ["vercel"],
    title: "Vercel CLI",
    contextFlags: [],
    credentialPaths: ["~/.config/com.vercel.cli/auth.json"],
  },
  {
    executables: ["supabase"],
    title: "Supabase CLI",
    contextFlags: [],
    credentialPaths: [
      "~/.supabase/access-token",
      "~/.config/supabase/access-token",
    ],
  },
  {
    executables: ["fly", "flyctl"],
    title: "Fly.io CLI",
    contextFlags: [],
    credentialPaths: ["~/.fly/config.yml"],
  },
  {
    executables: ["railway"],
    title: "Railway CLI",
    contextFlags: [],
    credentialPaths: [],
  },
  {
    executables: ["render"],
    title: "Render CLI",
    contextFlags: [],
    credentialPaths: [],
  },
  {
    executables: ["heroku"],
    title: "Heroku CLI",
    contextFlags: [],
    credentialPaths: ["~/.netrc", "~/.config/heroku"],
  },
  {
    executables: ["doctl"],
    title: "DigitalOcean CLI",
    contextFlags: [],
    credentialPaths: [],
  },
  {
    executables: ["stripe"],
    title: "Stripe CLI",
    contextFlags: [],
    credentialPaths: ["~/.config/stripe/config.toml"],
  },
  {
    executables: ["wrangler"],
    title: "Cloudflare Wrangler",
    contextFlags: [],
    credentialPaths: [
      "~/.wrangler/config/default.toml",
      "~/.config/.wrangler/config/default.toml",
    ],
  },
  {
    executables: ["cloudflared"],
    title: "Cloudflare Tunnel",
    contextFlags: [],
    credentialPaths: [],
  },
  {
    executables: ["tailscale"],
    title: "Tailscale CLI",
    contextFlags: [],
    credentialPaths: [],
  },
  {
    executables: ["terraform"],
    title: "Terraform",
    contextFlags: [],
    credentialPaths: ["~/.terraform.d/credentials.tfrc.json"],
  },
  {
    executables: ["tofu"],
    title: "OpenTofu",
    contextFlags: [],
    credentialPaths: [],
  },
  {
    executables: ["pulumi"],
    title: "Pulumi CLI",
    contextFlags: [],
    credentialPaths: ["~/.pulumi/credentials.json"],
  },
  {
    executables: ["vault"],
    title: "Vault CLI",
    contextFlags: [],
    credentialPaths: ["~/.vault-token"],
  },
  {
    executables: ["op"],
    title: "1Password CLI",
    contextFlags: [],
    credentialPaths: ["~/.config/op/config"],
  },
  {
    executables: ["doppler"],
    title: "Doppler CLI",
    contextFlags: [],
    credentialPaths: ["~/.doppler/.doppler.yaml"],
  },
  {
    executables: ["sentry-cli"],
    title: "Sentry CLI",
    contextFlags: [],
    credentialPaths: ["~/.sentryclirc"],
  },
  {
    executables: ["shopify"],
    title: "Shopify CLI",
    contextFlags: [],
    credentialPaths: [],
  },
  {
    executables: ["linear"],
    title: "Linear CLI",
    contextFlags: [],
    credentialPaths: [],
  },
  {
    executables: ["huggingface-cli", "hf"],
    title: "Hugging Face CLI",
    contextFlags: [],
    credentialPaths: [],
  },
  {
    executables: ["databricks"],
    title: "Databricks CLI",
    contextFlags: [],
    credentialPaths: [],
  },
  {
    executables: ["snow"],
    title: "Snowflake CLI",
    contextFlags: [],
    credentialPaths: [],
  },
  {
    executables: ["netlify"],
    title: "Netlify CLI",
    contextFlags: [],
    credentialPaths: ["~/.config/netlify/config.json"],
  },
  {
    executables: ["firebase"],
    title: "Firebase CLI",
    contextFlags: [],
    credentialPaths: ["~/.config/configstore/firebase-tools.json"],
  },
  {
    executables: ["eas"],
    title: "Expo EAS CLI",
    contextFlags: [],
    credentialPaths: [],
  },
];

const cloudRegistry = new Map<string, CloudCliDefinition>();
for (const definition of CLOUD_CLI_DEFINITIONS) {
  for (const executable of definition.executables) {
    cloudRegistry.set(executable, definition);
  }
}

const CLOUD_CONTEXT_FLAGS = new Set([
  "--account",
  "--app",
  "--context",
  "--hostname",
  "--namespace",
  "--org",
  "--profile",
  "--project",
  "--project-id",
  "--scope",
  "--sso-session",
  "--team",
  "--workspace",
  "-p",
]);

// First context-flag value wins (--flag value or --flag=value); otherwise the
// first two positional tokens identify the invocation ("s3 ls", "pr list").
// Unknown single-dash flags are assumed to take a value and skipped with it,
// matching Sesshy's cliContext.
export function cliContextTarget(
  args: readonly string[],
  customContextFlags: readonly string[] = [],
): string | null {
  const allFlags = new Set([...CLOUD_CONTEXT_FLAGS, ...customContextFlags]);
  const tokens = args.slice(1);
  const commandParts: string[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (token === undefined) {
      continue;
    }

    if (allFlags.has(token)) {
      const value = tokens[index];
      index += 1;
      if (value !== undefined && !value.startsWith("-")) {
        return value;
      }
      continue;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > 0) {
        const flag = token.slice(0, eq);
        const value = token.slice(eq + 1);
        if (allFlags.has(flag) && value) {
          return value;
        }
      }
      continue;
    }

    if (token.startsWith("-")) {
      index += 1;
      continue;
    }

    if (commandParts.length < 2) {
      commandParts.push(token);
    }
  }

  return commandParts.length > 0 ? commandParts.join(" ") : null;
}

// ---------------------------------------------------------------------------
// Terminal attribution (parent-chain walk, ported from Sesshy's
// terminalName; "zed"/"code" added per ZipLyne's host list)
// ---------------------------------------------------------------------------

const KNOWN_TERMINALS: ReadonlyArray<readonly [string, string]> = [
  ["alacritty", "Alacritty"],
  ["ghostty", "Ghostty"],
  ["hyper", "Hyper"],
  ["iterm2", "iTerm2"],
  ["kitty", "Kitty"],
  ["warp", "Warp"],
  ["wezterm", "WezTerm"],
  ["zed", "Zed"],
  ["terminal", "Terminal"],
  ["code", "VS Code"],
];

export function terminalNameFor(
  process: ProcessSnapshot,
  processesByPid: ReadonlyMap<number, ProcessSnapshot>,
): string {
  const seen = new Set<number>();
  let current: ProcessSnapshot | undefined = process;

  while (current && !seen.has(current.pid)) {
    seen.add(current.pid);
    const parent = processesByPid.get(current.parentPid);
    if (!parent) {
      break;
    }

    const executable = executableNameOf(parent.commandLine);
    const exact = KNOWN_TERMINALS.find(([needle]) => needle === executable);
    if (exact) {
      return exact[1];
    }

    const fullCommand = parent.commandLine.toLowerCase();
    const match = KNOWN_TERMINALS.find(([needle]) =>
      fullCommand.includes(needle),
    );
    if (match) {
      return match[1];
    }

    current = parent;
  }

  return process.tty;
}

// ---------------------------------------------------------------------------
// Redaction (ported from Sesshy's CommandRedaction)
// ---------------------------------------------------------------------------

const REDACTION_MASK = "•••••";

const SENSITIVE_FLAG_FRAGMENTS = [
  "password",
  "passwd",
  "token",
  "secret",
  "api-key",
  "api_key",
  "apikey",
  "auth",
  "credential",
  "private-key",
  "private_key",
  "access-key",
  "access_key",
];

const SENSITIVE_ENV_FRAGMENTS = [
  "PASSWORD",
  "PASSWD",
  "TOKEN",
  "SECRET",
  "API_KEY",
  "APIKEY",
  "AUTH",
  "CREDENTIAL",
  "PRIVATE_KEY",
  "ACCESS_KEY",
  "SESSION_KEY",
];

function redactUrlUserInfo(token: string): string | null {
  const schemeIndex = token.indexOf("://");
  if (schemeIndex < 0) {
    return null;
  }
  const atIndex = token.indexOf("@", schemeIndex + 3);
  if (atIndex < 0) {
    return null;
  }
  const userInfo = token.slice(schemeIndex + 3, atIndex);
  const colon = userInfo.indexOf(":");
  if (colon < 0) {
    return null;
  }
  const passwordStart = schemeIndex + 3 + colon + 1;
  return token.slice(0, passwordStart) + REDACTION_MASK + token.slice(atIndex);
}

// Masks --flag value, --flag=value, ENV=value and scheme://user:pass@ forms.
export function redactCommandLine(commandLine: string): string {
  const tokens = commandLine.split(" ");
  let redactNext = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }

    if (redactNext) {
      if (token.length > 0) {
        tokens[index] = REDACTION_MASK;
      }
      redactNext = false;
      continue;
    }

    const eq = token.indexOf("=");

    // --password=value / --api-key=value
    if (token.startsWith("-") && eq >= 0) {
      const flag = token.slice(0, eq).toLowerCase();
      if (
        SENSITIVE_FLAG_FRAGMENTS.some((fragment) => flag.includes(fragment))
      ) {
        tokens[index] = `${token.slice(0, eq)}=${REDACTION_MASK}`;
      }
      continue;
    }

    // --password value
    if (token.startsWith("-")) {
      const flag = token.toLowerCase();
      if (
        SENSITIVE_FLAG_FRAGMENTS.some((fragment) => flag.includes(fragment))
      ) {
        redactNext = true;
      }
      continue;
    }

    // PGPASSWORD=value env assignment
    if (eq >= 0) {
      const name = token.slice(0, eq).toUpperCase();
      if (SENSITIVE_ENV_FRAGMENTS.some((fragment) => name.includes(fragment))) {
        tokens[index] = `${token.slice(0, eq)}=${REDACTION_MASK}`;
      }
    }

    // scheme://user:pass@host → scheme://user:•••••@host
    if (token.includes("://")) {
      const redacted = redactUrlUserInfo(token);
      if (redacted) {
        tokens[index] = redacted;
      }
    }
  }

  return tokens.join(" ");
}

// ---------------------------------------------------------------------------
// Classification (ported from Sesshy's SessionClassifier, branch order kept)
// ---------------------------------------------------------------------------

interface ClassifyContext {
  process: ProcessSnapshot;
  terminalName: string;
  workingDirectory?: string;
  connections: SocketConnection[];
}

function buildSession(
  context: ClassifyContext,
  kind: ConnectionKind,
  title: string,
  target: string,
  subtitle: string,
): ConnectionSession {
  return {
    id: `${context.process.pid}:${context.process.tty}`,
    pid: context.process.pid,
    tty: context.process.tty,
    terminalName: context.terminalName,
    kind,
    title,
    target,
    subtitle,
    commandLine: redactCommandLine(context.process.commandLine),
    workingDirectory: context.workingDirectory,
    elapsedSeconds: context.process.elapsedSeconds,
    connections: context.connections.map((connection) => ({
      local: connection.localEndpoint,
      remote: connection.remoteEndpoint,
      state: connection.state,
    })),
  };
}

function classifyProcess(context: ClassifyContext): ConnectionSession | null {
  const args = shellSplit(context.process.commandLine);
  const executable = executableNameOf(context.process.commandLine);

  if (["ssh", "sftp", "scp", "mosh-client"].includes(executable)) {
    const target = extractSshTarget(args) ?? executable;
    const subtitle = context.connections[0]?.remoteEndpoint ?? "";
    return buildSession(context, "ssh", "SSH", target, subtitle);
  }

  if (executable === "kubectl") {
    const index = args.indexOf("port-forward");
    if (index < 0 || index + 1 >= args.length) {
      // Other kubectl subcommands are not remote sessions.
      return null;
    }
    const target = args[index + 1] ?? executable;
    const mapping =
      args.slice(index + 2).find((token) => token.includes(":")) ?? "";
    return buildSession(context, "tunnel", "Port Forward", target, mapping);
  }

  if (executable === "psql") {
    const parsed = parsePostgresTarget(args);
    return buildSession(
      context,
      "database",
      "Postgres",
      parsed.host,
      parsed.database,
    );
  }

  if (executable === "mysql") {
    const parsed = parseMysqlTarget(args);
    return buildSession(
      context,
      "database",
      "MySQL",
      parsed.host,
      parsed.database,
    );
  }

  if (executable === "redis-cli") {
    const parsed = parseRedisTarget(args);
    return buildSession(
      context,
      "database",
      "Redis",
      parsed.host,
      parsed.database,
    );
  }

  if (executable === "mongosh") {
    const parsed = parseMongoTarget(args);
    return buildSession(
      context,
      "database",
      "MongoDB",
      parsed.host,
      parsed.database,
    );
  }

  const agentTitle =
    agentTitleFor(executable) ??
    agentTitleFromPath(context.process.commandLine);
  if (agentTitle) {
    const cwd = context.workingDirectory;
    const target = cwd ? basename(cwd) || executable : executable;
    return buildSession(context, "agent", agentTitle, target, cwd ?? "");
  }

  const definition = cloudRegistry.get(executable);
  if (definition) {
    const target =
      cliContextTarget(args, definition.contextFlags) ?? executable;
    const subtitle = primaryRemoteEndpoint(context.connections) ?? "";
    return buildSession(context, "cloud", definition.title, target, subtitle);
  }

  const remoteEndpoint = primaryRemoteEndpoint(context.connections);
  if (remoteEndpoint) {
    return buildSession(context, "other", "CLI", executable, remoteEndpoint);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Scan pipeline (ported from Sesshy's SessionScanner)
// ---------------------------------------------------------------------------

const LSOF_BATCH_SIZE = 200;
const GIT_CACHE_TTL_MS = 60_000;

interface GitContext {
  branch?: string;
  repoRoot?: string;
}

const gitContextCache = new Map<string, { at: number; context: GitContext }>();

export interface ScanConnectionsOptions {
  runner?: CommandRunner;
  now?: () => number;
}

function pidBatches(pids: number[], size = LSOF_BATCH_SIZE): number[][] {
  const batches: number[][] = [];
  for (let start = 0; start < pids.length; start += size) {
    batches.push(pids.slice(start, start + size));
  }
  return batches;
}

async function runLsofBatches(
  runner: CommandRunner,
  batches: number[][],
  prefix: string[],
  suffix: string[],
): Promise<string> {
  const outputs: string[] = [];
  for (const batch of batches) {
    outputs.push(
      await runner("/usr/sbin/lsof", [
        ...prefix,
        "-p",
        batch.join(","),
        ...suffix,
      ]),
    );
  }
  return outputs.join("\n");
}

function parseWorkingDirectories(output: string): Map<number, string> {
  const result = new Map<number, string>();
  let currentPid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      currentPid = Number.isInteger(pid) ? pid : null;
    } else if (line.startsWith("n") && currentPid !== null) {
      result.set(currentPid, line.slice(1));
    }
  }
  return result;
}

async function gitContextFor(
  directory: string,
  runner: CommandRunner,
  now: () => number,
): Promise<GitContext> {
  const cached = gitContextCache.get(directory);
  const at = now();
  if (cached && at - cached.at < GIT_CACHE_TTL_MS) {
    return cached.context;
  }

  const [branchOutput, rootOutput] = await Promise.all([
    runner(
      "/usr/bin/git",
      ["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"],
      4_000,
    ),
    runner(
      "/usr/bin/git",
      ["-C", directory, "rev-parse", "--show-toplevel"],
      4_000,
    ),
  ]);
  const context: GitContext = {
    branch: branchOutput.trim() || undefined,
    repoRoot: rootOutput.trim() || undefined,
  };
  gitContextCache.set(directory, { at, context });
  return context;
}

function readProcessTable(
  runner: CommandRunner,
  elapsedKeyword: "etimes=" | "etime=",
): Promise<string> {
  return runner("/bin/ps", [
    "-ax",
    "-o",
    "pid=",
    "-o",
    "ppid=",
    "-o",
    "tty=",
    "-o",
    elapsedKeyword,
    "-o",
    "command=",
  ]);
}

export async function scanConnections(
  options: ScanConnectionsOptions = {},
): Promise<ConnectionSession[]> {
  const runner = options.runner ?? defaultRunner;
  const now = options.now ?? Date.now;

  // Sesshy's `etimes` keyword is rejected by some macOS ps builds
  // ("keyword not found", non-zero exit, runner returns ""). Fall back to
  // the portable `etime` form; parsePsSnapshots accepts both formats.
  let psOutput = await readProcessTable(runner, "etimes=");
  if (!psOutput.trim()) {
    psOutput = await readProcessTable(runner, "etime=");
  }
  const processes = parsePsSnapshots(psOutput);
  const candidates = processes.filter(
    (process) =>
      process.tty !== "??" &&
      !IGNORED_INTERACTIVE_EXECUTABLES.has(
        executableNameOf(process.commandLine),
      ),
  );
  if (candidates.length === 0) {
    return [];
  }

  const batches = pidBatches(candidates.map((process) => process.pid));
  const [connectionsOutput, cwdOutput] = await Promise.all([
    runLsofBatches(runner, batches, ["-a", "-n", "-P"], ["-i"]),
    runLsofBatches(runner, batches, ["-a"], ["-d", "cwd", "-Fn"]),
  ]);

  const connections = parseLsofConnections(connectionsOutput);
  const workingDirectories = parseWorkingDirectories(cwdOutput);
  const processesByPid = new Map(
    processes.map((process) => [process.pid, process]),
  );
  const connectionsByPid = new Map<number, SocketConnection[]>();
  for (const connection of connections) {
    const group = connectionsByPid.get(connection.pid);
    if (group) {
      group.push(connection);
    } else {
      connectionsByPid.set(connection.pid, [connection]);
    }
  }

  const sessions: ConnectionSession[] = [];
  for (const process of candidates) {
    const session = classifyProcess({
      process,
      terminalName: terminalNameFor(process, processesByPid),
      workingDirectory: workingDirectories.get(process.pid),
      connections: connectionsByPid.get(process.pid) ?? [],
    });
    if (session) {
      sessions.push(session);
    }
  }

  // Git enrichment, one resolve per unique cwd per 60s (Sesshy's
  // GitContextResolver TTL).
  const uniqueDirectories = [
    ...new Set(
      sessions
        .map((session) => session.workingDirectory)
        .filter((directory): directory is string => Boolean(directory)),
    ),
  ];
  const contexts = new Map<string, GitContext>();
  await Promise.all(
    uniqueDirectories.map(async (directory) => {
      contexts.set(directory, await gitContextFor(directory, runner, now));
    }),
  );

  return sessions.map((session) => {
    const context = session.workingDirectory
      ? contexts.get(session.workingDirectory)
      : undefined;
    if (!context || (!context.branch && !context.repoRoot)) {
      return session;
    }
    return {
      ...session,
      gitBranch: context.branch,
      gitRepoRoot: context.repoRoot,
    };
  });
}

// ---------------------------------------------------------------------------
// Payload shaping + route entry point (5s cache so dashboard polls stay cheap)
// ---------------------------------------------------------------------------

const KIND_SORT_ORDER: Record<ConnectionKind, number> = {
  ssh: 0,
  database: 1,
  tunnel: 2,
  cloud: 3,
  agent: 4,
  other: 5,
};

export function shapeConnectionsPayload(
  sessions: ConnectionSession[],
  generatedAt: Date = new Date(),
): ConnectionsPayload {
  const sorted = [...sessions].sort((a, b) => {
    const kindOrder = KIND_SORT_ORDER[a.kind] - KIND_SORT_ORDER[b.kind];
    if (kindOrder !== 0) {
      return kindOrder;
    }
    return a.target.localeCompare(b.target);
  });

  const counts: Record<ConnectionKind | "total", number> = {
    total: sessions.length,
    ssh: 0,
    database: 0,
    tunnel: 0,
    cloud: 0,
    agent: 0,
    other: 0,
  };
  for (const session of sessions) {
    counts[session.kind] += 1;
  }

  return {
    generatedAt: generatedAt.toISOString(),
    counts,
    sessions: sorted,
  };
}

const PAYLOAD_CACHE_TTL_MS = 5_000;
let payloadCache: { at: number; payload: ConnectionsPayload } | null = null;

function emptyConnectionsPayload(): ConnectionsPayload {
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      total: 0,
      ssh: 0,
      database: 0,
      tunnel: 0,
      cloud: 0,
      agent: 0,
      other: 0,
    },
    sessions: [],
  };
}

export async function getConnectionsPayload(): Promise<ConnectionsPayload> {
  const now = Date.now();
  if (payloadCache && now - payloadCache.at < PAYLOAD_CACHE_TTL_MS) {
    return payloadCache.payload;
  }

  try {
    const payload = shapeConnectionsPayload(await scanConnections());
    payloadCache = { at: now, payload };
    return payload;
  } catch {
    // A scanner hiccup must never throw into the route.
    return emptyConnectionsPayload();
  }
}
