// CLI inventory + login evidence — a TypeScript port of Sesshy's
// CLIInventoryScanner: which networked CLIs are installed on this Mac and
// which ones show evidence of being logged in.
//
// Scans managed bin dirs (homebrew, cargo, bun, deno, pnpm, go, version-
// manager shims, ...) plus dirs discovered from shell rc files, then matches
// executables against the CLI registry (built-ins + user file + any registry
// JSON Sesshy already downloaded to ~/Library/Application Support/Sesshy).
// "Login evidence" = first existing credential path (registry-defined,
// heuristic per ecosystem, env-var presence, or conventional config paths).
//
// Unlike the Swift original this module never shells out: everything Sesshy
// reads via files (registry JSON, rc files, go env files, credential files)
// is read directly, so there is no CommandRunner — dependencies are injected
// as { home, env, now } (the same idea as live.ts's runner injection, but
// for the filesystem effects this scanner actually depends on).

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ToolState = "loggedIn" | "installed";
export type ToolSource = "registry" | "discovered";

export interface ToolItem {
  executable: string;
  title: string;
  kind: string; // "cloud" | "database" | "agent" | "network" | ...
  state: ToolState;
  source: ToolSource;
  installedPath?: string;
  credentialPath?: string;
}

export type CredentialUrgency = "expired" | "imminent" | "soon" | "ok";

export interface CredentialExpiryItem {
  provider: string; // "aws" | "gcloud" | "vercel"
  label: string;
  expiresAt: string; // ISO
  urgency: CredentialUrgency;
  evidencePath: string;
}

export interface ToolsPayload {
  generatedAt: string;
  counts: {
    total: number;
    loggedIn: number;
    installed: number;
    discovered: number;
  };
  tools: ToolItem[];
  expiring: CredentialExpiryItem[];
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface InventoryDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  now: Date;
  // Test escape hatch: when set, replaces the fully computed search paths
  // (managed dirs, versioned globs, rc-derived dirs) with this exact list.
  searchPaths?: string[];
}

export function defaultInventoryDeps(): InventoryDeps {
  return { home: homedir(), env: process.env, now: new Date() };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function expandTilde(path: string, home: string): string {
  if (path === "~") {
    return home;
  }
  if (path.startsWith("~/")) {
    return home.endsWith("/")
      ? `${home}${path.slice(2)}`
      : `${home}/${path.slice(2)}`;
  }
  return path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return !info.isDirectory() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI registry (port of CLIRegistry / CLISessionDefinition from SessionCore)
// ---------------------------------------------------------------------------

export interface CLIRegistryDefinition {
  executables: string[];
  title: string;
  kind: string;
  contextFlags: string[];
  credentialPaths: string[];
}

export interface MergedRegistry {
  definitions: CLIRegistryDefinition[];
  byExecutable: Map<string, CLIRegistryDefinition>;
}

const knownKinds = new Set([
  "ssh",
  "database",
  "tunnel",
  "cloud",
  "agent",
  "network",
  "generic",
]);

function definition(
  executables: string[],
  title: string,
  kind: string,
  credentialPaths: string[] = [],
): CLIRegistryDefinition {
  return { executables, title, kind, contextFlags: [], credentialPaths };
}

// The 30 built-in definitions, ported verbatim from SessionCore.swift.
export const builtInRegistryDefinitions: CLIRegistryDefinition[] = [
  definition(["aws"], "AWS CLI", "cloud", [
    "~/.aws/credentials",
    "~/.aws/config",
    "~/.aws/sso/cache",
  ]),
  definition(["gcloud"], "Google Cloud CLI", "cloud", [
    "~/.config/gcloud/credentials.db",
    "~/.config/gcloud/application_default_credentials.json",
  ]),
  definition(["az"], "Azure CLI", "cloud", [
    "~/.azure/msal_token_cache.json",
    "~/.azure/accessTokens.json",
  ]),
  definition(["gh"], "GitHub CLI", "cloud", ["~/.config/gh/hosts.yml"]),
  definition(["vercel"], "Vercel CLI", "cloud", [
    "~/.config/com.vercel.cli/auth.json",
  ]),
  definition(["supabase"], "Supabase CLI", "cloud", [
    "~/.supabase/access-token",
    "~/.config/supabase/access-token",
  ]),
  definition(["fly", "flyctl"], "Fly.io CLI", "cloud", ["~/.fly/config.yml"]),
  definition(["railway"], "Railway CLI", "cloud"),
  definition(["render"], "Render CLI", "cloud"),
  definition(["heroku"], "Heroku CLI", "cloud", [
    "~/.netrc",
    "~/.config/heroku",
  ]),
  definition(["doctl"], "DigitalOcean CLI", "cloud"),
  definition(["stripe"], "Stripe CLI", "cloud", [
    "~/.config/stripe/config.toml",
  ]),
  definition(["wrangler"], "Cloudflare Wrangler", "cloud", [
    "~/.wrangler/config/default.toml",
    "~/.config/.wrangler/config/default.toml",
  ]),
  definition(["cloudflared"], "Cloudflare Tunnel", "cloud"),
  definition(["tailscale"], "Tailscale CLI", "cloud"),
  definition(["terraform"], "Terraform", "cloud", [
    "~/.terraform.d/credentials.tfrc.json",
  ]),
  definition(["tofu"], "OpenTofu", "cloud"),
  definition(["pulumi"], "Pulumi CLI", "cloud", ["~/.pulumi/credentials.json"]),
  definition(["vault"], "Vault CLI", "cloud", ["~/.vault-token"]),
  definition(["op"], "1Password CLI", "cloud", ["~/.config/op/config"]),
  definition(["doppler"], "Doppler CLI", "cloud", ["~/.doppler/.doppler.yaml"]),
  definition(["sentry-cli"], "Sentry CLI", "cloud", ["~/.sentryclirc"]),
  definition(["shopify"], "Shopify CLI", "cloud"),
  definition(["linear"], "Linear CLI", "cloud"),
  definition(["huggingface-cli", "hf"], "Hugging Face CLI", "cloud"),
  definition(["databricks"], "Databricks CLI", "cloud"),
  definition(["snow"], "Snowflake CLI", "cloud"),
  definition(["netlify"], "Netlify CLI", "cloud", [
    "~/.config/netlify/config.json",
  ]),
  definition(["firebase"], "Firebase CLI", "cloud", [
    "~/.config/configstore/firebase-tools.json",
  ]),
  definition(["eas"], "Expo EAS CLI", "cloud"),
];

function isBareExecutableTitle(def: CLIRegistryDefinition): boolean {
  const normalizedTitle = def.title.trim().toLowerCase();
  return def.executables.some(
    (executable) => executable.trim().toLowerCase() === normalizedTitle,
  );
}

function isPackageStyleTitle(def: CLIRegistryDefinition): boolean {
  const trimmed = def.title.trim();
  if (!trimmed || trimmed.includes(" ") || trimmed !== trimmed.toLowerCase()) {
    return false;
  }
  return trimmed.includes("-") || trimmed.includes("_");
}

function isLowInformationTitle(def: CLIRegistryDefinition): boolean {
  return isBareExecutableTitle(def) || isPackageStyleTitle(def);
}

// Port of CLISessionDefinition.mergingMetadata(from:): the incoming
// definition wins, except a low-information incoming title / generic kind
// yields to a richer existing one, and empty contextFlags/credentialPaths
// inherit from the existing definition.
function mergeDefinitionMetadata(
  incoming: CLIRegistryDefinition,
  existing: CLIRegistryDefinition,
): CLIRegistryDefinition {
  return {
    executables: dedupe([...incoming.executables, ...existing.executables]),
    title:
      isLowInformationTitle(incoming) && !isLowInformationTitle(existing)
        ? existing.title
        : incoming.title,
    kind:
      incoming.kind === "generic" && existing.kind !== "generic"
        ? existing.kind
        : incoming.kind,
    contextFlags: incoming.contextFlags.length
      ? incoming.contextFlags
      : existing.contextFlags,
    credentialPaths: incoming.credentialPaths.length
      ? incoming.credentialPaths
      : existing.credentialPaths,
  };
}

// Port of CLIRegistry.init/merging: later definition groups merge into the
// map keyed by lowercased executable; earlier groups (built-ins first) carry
// the richer metadata that low-information later entries inherit.
export function buildMergedRegistry(
  groups: CLIRegistryDefinition[][],
): MergedRegistry {
  const byExecutable = new Map<string, CLIRegistryDefinition>();
  for (const definitions of groups) {
    for (const def of definitions) {
      const merged = def.executables
        .map((executable) => byExecutable.get(executable.toLowerCase()))
        .filter((existing): existing is CLIRegistryDefinition => !!existing)
        .reduce((acc, existing) => mergeDefinitionMetadata(acc, existing), def);
      for (const executable of merged.executables) {
        byExecutable.set(executable.toLowerCase(), merged);
      }
    }
  }
  const definitions = [...new Set(byExecutable.values())].sort((a, b) =>
    compareStrings(a.executables[0] ?? a.title, b.executables[0] ?? b.title),
  );
  return { definitions, byExecutable };
}

// Lenient per-tool sanitation: Swift fails the whole file when a tool is
// malformed; here a bad entry is dropped so one bad tool can't poison a
// 24MB catalog file.
function sanitizeTool(raw: unknown): CLIRegistryDefinition | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const tool = raw as Record<string, unknown>;
  const executables = Array.isArray(tool.executables)
    ? tool.executables.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];
  if (!executables.length) {
    return null;
  }
  const first = executables[0] ?? "";
  const title =
    typeof tool.title === "string" && tool.title.length > 0
      ? tool.title
      : first;
  const kind =
    typeof tool.kind === "string" && knownKinds.has(tool.kind)
      ? tool.kind
      : "generic";
  const contextFlags = Array.isArray(tool.contextFlags)
    ? tool.contextFlags.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const credentialPaths = Array.isArray(tool.credentialPaths)
    ? tool.credentialPaths.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return { executables, title, kind, contextFlags, credentialPaths };
}

// Catalog files in ~/Library/Application Support/Sesshy/Registries can be
// huge on a machine that pre-downloaded them all; skip anything past 8MB.
const REGISTRY_FILE_MAX_BYTES = 8 * 1024 * 1024;

async function loadRegistryFile(
  path: string,
): Promise<CLIRegistryDefinition[] | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > REGISTRY_FILE_MAX_BYTES) {
      return null;
    }
    const json: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!json || typeof json !== "object") {
      return null;
    }
    const tools = (json as Record<string, unknown>).tools;
    if (!Array.isArray(tools)) {
      return null;
    }
    return tools
      .map(sanitizeTool)
      .filter((tool): tool is CLIRegistryDefinition => !!tool);
  } catch {
    return null;
  }
}

function sesshySupportDir(home: string): string {
  return join(home, "Library", "Application Support", "Sesshy");
}

// Built-ins + user file + every *.json in the Registries dir (sorted by
// name), merged with dedupe-by-executable. Never throws; unreadable or
// malformed files are skipped.
export async function loadMergedRegistry(
  deps: InventoryDeps,
): Promise<MergedRegistry> {
  const groups: CLIRegistryDefinition[][] = [builtInRegistryDefinitions];
  const base = sesshySupportDir(deps.home);

  const userFile = await loadRegistryFile(join(base, "CLIRegistry.json"));
  if (userFile) {
    groups.push(userFile);
  }

  let names: string[] = [];
  try {
    names = await readdir(join(base, "Registries"));
  } catch {
    names = [];
  }
  for (const name of names
    .filter((entry) => entry.toLowerCase().endsWith(".json"))
    .sort(compareStrings)) {
    const definitions = await loadRegistryFile(join(base, "Registries", name));
    if (definitions) {
      groups.push(definitions);
    }
  }

  return buildMergedRegistry(groups);
}

// ---------------------------------------------------------------------------
// Managed executable paths (port of ManagedExecutablePaths)
// ---------------------------------------------------------------------------

const ignoredDirectoryPaths = new Set([
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
]);

const managedPaths = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/local/bin",
  "/opt/local/sbin",
  "/usr/pkg/bin",
  "/usr/pkg/sbin",
  "/opt/pkg/bin",
  "/opt/pkg/sbin",
  "~/bin",
  "~/.bin",
  "~/.local/bin",
  "~/.local/sbin",
  "~/.cargo/bin",
  "~/.bun/bin",
  "~/.deno/bin",
  "~/.npm-global/bin",
  "~/.local/share/pnpm",
  "~/Library/pnpm",
  "~/.yarn/bin",
  "~/.asdf/shims",
  "~/.mise/shims",
  "~/.local/share/mise/shims",
  "~/.volta/bin",
  "~/.proto/shims",
  "~/.proto/bin",
  "~/.version-fox/shims",
  "~/go/bin",
  "~/.dotnet/tools",
  "~/.composer/vendor/bin",
  "~/.config/composer/vendor/bin",
  "~/.rbenv/shims",
  "~/.pyenv/shims",
  "~/.nodenv/shims",
  "~/.goenv/shims",
  "~/.jenv/shims",
  "~/.phpenv/shims",
  "~/.plenv/shims",
  "~/.luaenv/shims",
  "~/.mint/bin",
  "~/.swiftpm/bin",
  "~/.swiftenv/shims",
  "~/.local/share/rtx/shims",
  "~/.rtx/shims",
  "~/miniconda3/bin",
  "~/anaconda3/bin",
  "~/miniforge3/bin",
  "~/mambaforge/bin",
  "~/.micromamba/bin",
  "~/.nix-profile/bin",
  "~/.local/state/nix/profile/bin",
  "/nix/var/nix/profiles/default/bin",
  "~/.pub-cache/bin",
  "~/.cabal/bin",
  "~/.ghcup/bin",
  "~/.foundry/bin",
  "~/.rye/shims",
  "~/.pixi/bin",
  "~/.local/share/aquaproj-aqua/bin",
  "~/.krew/bin",
  "~/.poetry/bin",
  "~/.local/share/coursier/bin",
  "~/Library/Application Support/Coursier/bin",
  "~/.juliaup/bin",
  "~/.elan/bin",
  "~/.nimble/bin",
  "~/.mix/escripts",
  "~/.luarocks/bin",
  "~/.tfenv/bin",
  "~/.tgenv/bin",
  "~/google-cloud-sdk/bin",
  "~/Library/Application Support/JetBrains/Toolbox/scripts",
  "~/Library/Android/sdk/platform-tools",
  "~/Library/Android/sdk/emulator",
  "~/Library/Android/sdk/cmdline-tools/latest/bin",
  "~/Library/Android/sdk/tools/bin",
  "~/flutter/bin",
  "~/development/flutter/bin",
];

const versionedManagedPathPatterns = [
  "/opt/homebrew/opt/*/bin",
  "/opt/homebrew/opt/*/sbin",
  "/usr/local/opt/*/bin",
  "/usr/local/opt/*/sbin",
  "~/Library/Python/*/bin",
  "~/.local/share/gem/ruby/*/bin",
  "~/.sdkman/candidates/*/current/bin",
  "~/.nvm/versions/node/*/bin",
  "~/.local/share/fnm/node-versions/*/installation/bin",
  "~/.local/share/mise/installs/*/*/bin",
  "~/.local/share/rtx/installs/*/*/bin",
  "~/.proto/tools/*/*/bin",
  "~/.version-fox/cache/*/*/*/bin",
  "~/.local/share/uv/tools/*/bin",
  "~/.local/pipx/venvs/*/bin",
  "~/Library/Application Support/pipx/venvs/*/bin",
  "~/.opam/*/bin",
  "~/.rvm/gems/*/bin",
  "~/.pkgx/*/v*/bin",
  "~/.pkgx/*/*/v*/bin",
  "~/.pkgx/*/*/*/v*/bin",
  "~/miniconda3/envs/*/bin",
  "~/anaconda3/envs/*/bin",
  "~/miniforge3/envs/*/bin",
  "~/mambaforge/envs/*/bin",
  "~/.conda/envs/*/bin",
  "~/.mamba/envs/*/bin",
  "~/.micromamba/envs/*/bin",
];

const defaultShellConfigurationPaths = [
  "~/.zprofile",
  "~/.zshrc",
  "~/.bash_profile",
  "~/.bashrc",
  "~/.profile",
  "~/.config/fish/config.fish",
];

const defaultPackageManagerConfigurationPaths = [
  "~/.npmrc",
  "~/.config/npm/npmrc",
  "~/.pnpmrc",
  "~/.config/pnpm/rc",
];

const defaultGoEnvironmentConfigurationPaths = [
  "~/Library/Application Support/go/env",
  "~/.config/go/env",
];

const shellConfiguredInstallRootVariables = new Set([
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "AQUA_ROOT_DIR",
  "ASDF_DATA_DIR",
  "BUN_INSTALL",
  "CABAL_DIR",
  "CARGO_HOME",
  "CLOUDSDK_ROOT_DIR",
  "COMPOSER_HOME",
  "DART_HOME",
  "DENO_INSTALL",
  "ELAN_HOME",
  "FLUTTER_ROOT",
  "FNM_DIR",
  "FOUNDRY_DIR",
  "GEM_HOME",
  "GHCUP_INSTALL_BASE_PREFIX",
  "GOBIN",
  "GOENV_ROOT",
  "GOPATH",
  "HOMEBREW_PREFIX",
  "JENV_ROOT",
  "JULIAUP_DEPOT_PATH",
  "KREW_ROOT",
  "LUAENV_ROOT",
  "MISE_DATA_DIR",
  "MIX_HOME",
  "NIMBLE_DIR",
  "NODENV_ROOT",
  "NVM_DIR",
  "OPAMROOT",
  "PHPENV_ROOT",
  "PIXI_HOME",
  "PIPX_BIN_DIR",
  "PLENV_ROOT",
  "PNPM_HOME",
  "POETRY_HOME",
  "PROTO_HOME",
  "PUB_CACHE",
  "PYENV_ROOT",
  "RBENV_ROOT",
  "RTX_DATA_DIR",
  "RVM_PATH",
  "RYE_HOME",
  "SDKMAN_DIR",
  "SWIFTENV_ROOT",
  "UV_TOOL_BIN_DIR",
  "UV_TOOL_DIR",
  "VFOX_HOME",
  "VOLTA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

// ---------------------------------------------------------------------------
// Shell line parsing (ports of the private ManagedExecutablePaths helpers)
// ---------------------------------------------------------------------------

function stripShellComment(line: string): string {
  let result = "";
  let quote: string | null = null;
  for (const character of line) {
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      result += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      continue;
    }
    if (character === "#") {
      break;
    }
    result += character;
  }
  return result;
}

function shellTokens(line: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: string | null = null;
  for (const character of line) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ";") {
      break;
    }
    if (/\s/u.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (token) {
    tokens.push(token);
  }
  return tokens;
}

function valuePrefixBeforeCommandSeparator(value: string): string {
  let result = "";
  let quote: string | null = null;
  for (const character of value) {
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      result += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      continue;
    }
    if (character === ";") {
      break;
    }
    result += character;
  }
  return result;
}

function trimMatchingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0] ?? "";
  const last = value[value.length - 1] ?? "";
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

interface ShellAssignment {
  name: string;
  value: string;
}

function fishEnvironmentAssignment(line: string): ShellAssignment | null {
  const tokens = shellTokens(line);
  if (tokens[0] !== "set") {
    return null;
  }
  const variableIndex = tokens.findIndex(
    (token, index) => index > 0 && !token.startsWith("-"),
  );
  if (variableIndex < 0 || variableIndex + 1 >= tokens.length) {
    return null;
  }
  const name = tokens[variableIndex] ?? "";
  const value = tokens.slice(variableIndex + 1).join(" ");
  if (!name || !value) {
    return null;
  }
  return { name, value };
}

function shellEnvironmentAssignment(line: string): ShellAssignment | null {
  const trimmedLine = stripShellComment(line).trim();
  if (!trimmedLine) {
    return null;
  }
  if (trimmedLine.startsWith("set ")) {
    return fishEnvironmentAssignment(trimmedLine);
  }
  const assignmentLine = trimmedLine.startsWith("export ")
    ? trimmedLine.slice("export ".length).trim()
    : trimmedLine;
  const token = shellTokens(
    valuePrefixBeforeCommandSeparator(assignmentLine),
  )[0];
  if (!token) {
    return null;
  }
  const separator = token.indexOf("=");
  if (separator < 0) {
    return null;
  }
  const name = token.slice(0, separator).trim();
  const value = token.slice(separator + 1);
  if (!name || !value) {
    return null;
  }
  return { name, value };
}

function normalizedConfiguredPathValue(
  value: string,
  home: string,
): string | null {
  const trimmed = trimMatchingQuotes(value.trim());
  if (!trimmed) {
    return null;
  }
  const expanded = trimmed
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax
    .replaceAll("${HOME}", home)
    .replaceAll("$HOME", home);
  if (
    expanded !== "~" &&
    !expanded.startsWith("~/") &&
    !expanded.startsWith("/")
  ) {
    return null;
  }
  return expandTilde(expanded, home);
}

function normalizedShellPathEntry(value: string, home: string): string | null {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed === "$PATH" ||
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax
    trimmed === "${PATH}" ||
    trimmed.includes("$PATH") ||
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax
    trimmed.includes("${PATH}")
  ) {
    return null;
  }
  const expanded = trimmed
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell syntax
    .replaceAll("${HOME}", home)
    .replaceAll("$HOME", home);
  if (
    expanded !== "~" &&
    !expanded.startsWith("~/") &&
    !expanded.startsWith("/")
  ) {
    return null;
  }
  return expandTilde(expanded, home);
}

function splitPathAssignmentValue(value: string): string[] {
  const trimmedValue = trimMatchingQuotes(value.trim());
  return trimmedValue
    .split(":")
    .filter(Boolean)
    .map((entry) => trimMatchingQuotes(entry.trim()));
}

function fishPathEntries(line: string, home: string): string[] {
  const tokens = shellTokens(line);
  const pathIndex = tokens.indexOf("PATH");
  if (pathIndex < 0) {
    return [];
  }
  return tokens
    .slice(pathIndex + 1)
    .map((token) => normalizedShellPathEntry(token, home))
    .filter((entry): entry is string => !!entry);
}

function shellPathEntries(line: string, home: string): string[] {
  const trimmedLine = stripShellComment(line).trim();
  if (!trimmedLine) {
    return [];
  }
  if (trimmedLine.startsWith("set ")) {
    return fishPathEntries(trimmedLine, home);
  }
  const assignment = shellEnvironmentAssignment(trimmedLine);
  if (assignment?.name !== "PATH") {
    return [];
  }
  return splitPathAssignmentValue(assignment.value)
    .map((entry) => normalizedShellPathEntry(entry, home))
    .filter((entry): entry is string => !!entry);
}

function goPathBinPaths(value: string, home: string): string[] {
  return trimMatchingQuotes(value.trim())
    .split(":")
    .filter(Boolean)
    .map((entry) => normalizedConfiguredPathValue(entry, home))
    .filter((entry): entry is string => !!entry)
    .map((entry) => `${entry}/bin`);
}

// ---------------------------------------------------------------------------
// Search-path discovery (rc files, npmrc/pnpmrc, go env, env roots, globs)
// ---------------------------------------------------------------------------

function xdgConfigPath(
  home: string,
  env: NodeJS.ProcessEnv,
  components: string[],
): string | null {
  const value = env.XDG_CONFIG_HOME;
  const root = value ? normalizedConfiguredPathValue(value, home) : null;
  if (!root) {
    return null;
  }
  return join(root, ...components);
}

function shellConfigurationPaths(
  home: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const xdgFish = xdgConfigPath(home, env, ["fish", "config.fish"]);
  return xdgFish
    ? [...defaultShellConfigurationPaths, xdgFish]
    : defaultShellConfigurationPaths;
}

function packageManagerConfigurationPaths(
  home: string,
  env: NodeJS.ProcessEnv,
): string[] {
  return [
    ...defaultPackageManagerConfigurationPaths,
    xdgConfigPath(home, env, ["npm", "npmrc"]),
    xdgConfigPath(home, env, ["pnpm", "rc"]),
  ].filter((path): path is string => !!path);
}

function goEnvironmentConfigurationPaths(
  home: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const xdgGo = xdgConfigPath(home, env, ["go", "env"]);
  return xdgGo
    ? [...defaultGoEnvironmentConfigurationPaths, xdgGo]
    : defaultGoEnvironmentConfigurationPaths;
}

// Install-root variables (NVM_DIR, CARGO_HOME, ...) assigned in rc files,
// merged under the process env (process env wins, same as the Swift merge).
async function shellConfiguredEnvironmentVariables(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const path of shellConfigurationPaths(home, env)) {
    const contents = await readTextFile(expandTilde(path, home));
    if (contents === null) {
      continue;
    }
    for (const line of contents.split("\n")) {
      const assignment = shellEnvironmentAssignment(line);
      if (
        assignment &&
        shellConfiguredInstallRootVariables.has(assignment.name)
      ) {
        values[assignment.name] = assignment.value;
      }
    }
  }
  return values;
}

function environmentConfiguredBaseSearchPaths(
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  const path = (name: string, appending: string[] = []): string | null => {
    const value = env[name];
    const root = value ? normalizedConfiguredPathValue(value, home) : null;
    return root ? join(root, ...appending) : null;
  };

  const directPaths = [
    path("PNPM_HOME"),
    path("XDG_DATA_HOME", ["pnpm"]),
    path("GOBIN"),
    path("PIPX_BIN_DIR"),
    path("UV_TOOL_BIN_DIR"),
  ];
  const androidSDKPaths = [
    path("ANDROID_HOME", ["platform-tools"]),
    path("ANDROID_HOME", ["emulator"]),
    path("ANDROID_HOME", ["cmdline-tools", "latest", "bin"]),
    path("ANDROID_HOME", ["tools", "bin"]),
    path("ANDROID_SDK_ROOT", ["platform-tools"]),
    path("ANDROID_SDK_ROOT", ["emulator"]),
    path("ANDROID_SDK_ROOT", ["cmdline-tools", "latest", "bin"]),
    path("ANDROID_SDK_ROOT", ["tools", "bin"]),
  ];
  const binPaths = [
    path("HOMEBREW_PREFIX", ["bin"]),
    path("HOMEBREW_PREFIX", ["sbin"]),
    path("CARGO_HOME", ["bin"]),
    path("BUN_INSTALL", ["bin"]),
    path("DENO_INSTALL", ["bin"]),
    path("FLUTTER_ROOT", ["bin"]),
    path("DART_HOME", ["bin"]),
    path("CABAL_DIR", ["bin"]),
    path("GHCUP_INSTALL_BASE_PREFIX", [".ghcup", "bin"]),
    path("FOUNDRY_DIR", ["bin"]),
    path("PIXI_HOME", ["bin"]),
    path("JULIAUP_DEPOT_PATH", ["bin"]),
    path("ELAN_HOME", ["bin"]),
    path("NIMBLE_DIR", ["bin"]),
    path("CLOUDSDK_ROOT_DIR", ["bin"]),
    path("VOLTA_HOME", ["bin"]),
    path("KREW_ROOT", ["bin"]),
    path("AQUA_ROOT_DIR", ["bin"]),
    path("POETRY_HOME", ["bin"]),
    path("GEM_HOME", ["bin"]),
    path("COMPOSER_HOME", ["vendor", "bin"]),
    path("PUB_CACHE", ["bin"]),
    path("MIX_HOME", ["escripts"]),
    path("XDG_DATA_HOME", ["coursier", "bin"]),
  ];
  const shimPaths = [
    path("RYE_HOME", ["shims"]),
    path("ASDF_DATA_DIR", ["shims"]),
    path("MISE_DATA_DIR", ["shims"]),
    path("RTX_DATA_DIR", ["shims"]),
    path("XDG_DATA_HOME", ["mise", "shims"]),
    path("XDG_DATA_HOME", ["rtx", "shims"]),
    path("PROTO_HOME", ["shims"]),
    path("VFOX_HOME", ["shims"]),
    path("PYENV_ROOT", ["shims"]),
    path("RBENV_ROOT", ["shims"]),
    path("NODENV_ROOT", ["shims"]),
    path("GOENV_ROOT", ["shims"]),
    path("JENV_ROOT", ["shims"]),
    path("PHPENV_ROOT", ["shims"]),
    path("PLENV_ROOT", ["shims"]),
    path("LUAENV_ROOT", ["shims"]),
    path("SWIFTENV_ROOT", ["shims"]),
  ];
  const protoPaths = [path("PROTO_HOME", ["bin"])];
  const gopathValue = env.GOPATH;
  const gopathBins = gopathValue ? goPathBinPaths(gopathValue, home) : [];

  return [
    ...[
      ...directPaths,
      ...androidSDKPaths,
      ...binPaths,
      ...shimPaths,
      ...protoPaths,
    ].filter((entry): entry is string => !!entry),
    ...gopathBins,
  ];
}

function environmentConfiguredVersionedPathPatterns(
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  const path = (name: string, appending: string[]): string | null => {
    const value = env[name];
    const root = value ? normalizedConfiguredPathValue(value, home) : null;
    return root ? join(root, ...appending) : null;
  };
  return [
    path("HOMEBREW_PREFIX", ["opt", "*", "bin"]),
    path("HOMEBREW_PREFIX", ["opt", "*", "sbin"]),
    path("NVM_DIR", ["versions", "node", "*", "bin"]),
    path("FNM_DIR", ["node-versions", "*", "installation", "bin"]),
    path("SDKMAN_DIR", ["candidates", "*", "current", "bin"]),
    path("UV_TOOL_DIR", ["*", "bin"]),
    path("OPAMROOT", ["*", "bin"]),
    path("RVM_PATH", ["gems", "*", "bin"]),
    path("XDG_DATA_HOME", ["mise", "installs", "*", "*", "bin"]),
    path("XDG_DATA_HOME", ["rtx", "installs", "*", "*", "bin"]),
  ].filter((entry): entry is string => !!entry);
}

async function environmentConfiguredSearchPaths(
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<string[]> {
  const base = environmentConfiguredBaseSearchPaths(env, home);
  const versioned = (
    await Promise.all(
      environmentConfiguredVersionedPathPatterns(env, home).map((pattern) =>
        expandSingleWildcardPath(pattern, home),
      ),
    )
  ).flat();
  return dedupe([...base, ...versioned]);
}

async function shellConfiguredSearchPaths(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const paths: string[] = [];
  for (const path of shellConfigurationPaths(home, env)) {
    const contents = await readTextFile(expandTilde(path, home));
    if (contents === null) {
      continue;
    }
    for (const line of contents.split("\n")) {
      paths.push(...shellPathEntries(line, home));
    }
  }
  return dedupe(paths);
}

function packageManagerConfiguredPath(
  line: string,
  home: string,
): string | null {
  const trimmedLine = line.trim();
  if (
    !trimmedLine ||
    trimmedLine.startsWith("#") ||
    trimmedLine.startsWith(";")
  ) {
    return null;
  }
  const separator = trimmedLine.indexOf("=");
  if (separator < 0) {
    return null;
  }
  const key = trimmedLine.slice(0, separator).trim();
  const expandedValue = normalizedConfiguredPathValue(
    trimmedLine.slice(separator + 1),
    home,
  );
  if (!expandedValue) {
    return null;
  }
  if (key === "prefix") {
    return `${expandedValue}/bin`;
  }
  if (key === "global-bin-dir") {
    return expandedValue;
  }
  return null;
}

async function packageManagerConfiguredSearchPaths(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const paths: string[] = [];
  for (const path of packageManagerConfigurationPaths(home, env)) {
    const contents = await readTextFile(expandTilde(path, home));
    if (contents === null) {
      continue;
    }
    for (const line of contents.split("\n")) {
      const configured = packageManagerConfiguredPath(line, home);
      if (configured) {
        paths.push(configured);
      }
    }
  }
  return dedupe(paths);
}

async function goConfiguredSearchPaths(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const paths: string[] = [];
  for (const path of goEnvironmentConfigurationPaths(home, env)) {
    const contents = await readTextFile(expandTilde(path, home));
    if (contents === null) {
      continue;
    }
    const gobinPaths: string[] = [];
    const gopathBinPaths: string[] = [];
    for (const line of contents.split("\n")) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith("#")) {
        continue;
      }
      const separator = trimmedLine.indexOf("=");
      if (separator < 0) {
        continue;
      }
      const key = trimmedLine.slice(0, separator).trim();
      const rawValue = trimmedLine.slice(separator + 1);
      if (key === "GOBIN") {
        const configured = normalizedConfiguredPathValue(rawValue, home);
        if (configured) {
          gobinPaths.push(configured);
        }
      } else if (key === "GOPATH") {
        gopathBinPaths.push(...goPathBinPaths(rawValue, home));
      }
    }
    paths.push(...gobinPaths, ...gopathBinPaths);
  }
  return dedupe(paths);
}

// Recursive single-wildcard expansion, ported from expandSingleWildcardPath:
// splits the pattern on the first "*", lists the parent dir, keeps child
// dirs matching the prefix, and recurses if the suffix still has a wildcard.
async function expandSingleWildcardPath(
  pattern: string,
  home: string,
): Promise<string[]> {
  const expandedPattern = expandTilde(pattern, home);
  const starIndex = expandedPattern.indexOf("*");
  if (starIndex < 0) {
    return [expandedPattern];
  }
  const prefix = expandedPattern.slice(0, starIndex);
  const suffix = expandedPattern.slice(starIndex + 1);

  let parentDir: string;
  let childPrefix: string;
  if (prefix.endsWith("/")) {
    parentDir = prefix.slice(0, -1);
    childPrefix = "";
  } else {
    const slashIndex = prefix.lastIndexOf("/");
    parentDir = slashIndex >= 0 ? prefix.slice(0, slashIndex) : ".";
    childPrefix = slashIndex >= 0 ? prefix.slice(slashIndex + 1) : prefix;
  }

  let childNames: string[] = [];
  try {
    childNames = await readdir(parentDir);
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const childName of childNames) {
    if (!childName.startsWith(childPrefix)) {
      continue;
    }
    const childPath = `${parentDir}/${childName}`;
    try {
      if (!(await stat(childPath)).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    const candidatePath = childPath + suffix;
    if (suffix.includes("*")) {
      results.push(...(await expandSingleWildcardPath(candidatePath, home)));
      continue;
    }
    try {
      if ((await stat(candidatePath)).isDirectory()) {
        results.push(candidatePath);
      }
    } catch {
      // Candidate doesn't exist; skip.
    }
  }
  return results;
}

// The full search-path list, in the same order as
// ManagedExecutablePaths.defaultSearchPaths.
export async function computeSearchPaths(
  deps: InventoryDeps,
): Promise<string[]> {
  const { home } = deps;
  if (deps.searchPaths) {
    return dedupe(
      deps.searchPaths.map((path) => expandTilde(path, home)),
    ).filter((path) => !ignoredDirectoryPaths.has(path));
  }
  const rcVariables = await shellConfiguredEnvironmentVariables(home, deps.env);
  const env: NodeJS.ProcessEnv = { ...rcVariables, ...deps.env };

  const environmentPaths = (env.PATH ?? "").split(":").filter(Boolean);
  const expandedManagedPaths = managedPaths.map((path) =>
    expandTilde(path, home),
  );
  const environmentConfigured = await environmentConfiguredSearchPaths(
    env,
    home,
  );
  const expandedVersionedManagedPaths = (
    await Promise.all(
      versionedManagedPathPatterns.map((pattern) =>
        expandSingleWildcardPath(pattern, home),
      ),
    )
  ).flat();
  const shellConfigured = await shellConfiguredSearchPaths(home, env);
  const packageManagerConfigured = await packageManagerConfiguredSearchPaths(
    home,
    env,
  );
  const goConfigured = await goConfiguredSearchPaths(home, env);

  return dedupe(
    [
      ...environmentPaths,
      ...expandedManagedPaths,
      ...environmentConfigured,
      ...expandedVersionedManagedPaths,
      ...shellConfigured,
      ...packageManagerConfigured,
      ...goConfigured,
    ].map((path) => expandTilde(path, home)),
  ).filter((path) => !ignoredDirectoryPaths.has(path));
}

// ---------------------------------------------------------------------------
// Executable catalog (port of PathExecutableCatalog)
// ---------------------------------------------------------------------------

interface InstalledExecutable {
  name: string;
  path: string;
}

async function listExecutables(
  searchPaths: string[],
): Promise<InstalledExecutable[]> {
  const executablesByPath = new Map<string, InstalledExecutable>();
  for (const directory of searchPaths) {
    let names: string[] = [];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".") || name.includes("/")) {
        continue;
      }
      const path = `${directory}/${name}`;
      if (await isExecutableFile(path)) {
        executablesByPath.set(path, { name, path });
      }
    }
  }
  return [...executablesByPath.values()].sort(
    (a, b) => compareStrings(a.name, b.name) || compareStrings(a.path, b.path),
  );
}

// ---------------------------------------------------------------------------
// Credential evidence (FileCredentialLocator + HeuristicCredentialPathSuggester)
// ---------------------------------------------------------------------------

// Every variable name assigned anywhere in the shell rc files. An env:NAME
// credential candidate counts as evidence when NAME is exported in the
// process env OR assigned in an rc file (port of ShellCredentialCache).
function environmentVariableNameAssignedBy(line: string): string | null {
  const trimmedLine = line.trim();
  if (!trimmedLine || trimmedLine.startsWith("#")) {
    return null;
  }
  const shellAssignmentName = (value: string): string | null => {
    const separator = value.indexOf("=");
    if (separator < 0) {
      return null;
    }
    const name = value.slice(0, separator).trim();
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      return null;
    }
    return name;
  };
  if (trimmedLine.startsWith("export ")) {
    return shellAssignmentName(trimmedLine.slice("export ".length));
  }
  const direct = shellAssignmentName(trimmedLine);
  if (direct) {
    return direct;
  }
  for (const prefix of [
    "set -x ",
    "set -gx ",
    "set --export ",
    "set --global --export ",
  ]) {
    if (trimmedLine.startsWith(prefix)) {
      const remainder = trimmedLine.slice(prefix.length).trim();
      return remainder.split(/\s+/u)[0] ?? null;
    }
  }
  return null;
}

async function loadShellCredentialNames(
  deps: InventoryDeps,
): Promise<Set<string>> {
  const names = new Set<string>();
  for (const path of shellConfigurationPaths(deps.home, deps.env)) {
    const contents = await readTextFile(expandTilde(path, deps.home));
    if (contents === null) {
      continue;
    }
    for (const line of contents.split("\n")) {
      const name = environmentVariableNameAssignedBy(line);
      if (name) {
        names.add(name);
      }
    }
  }
  return names;
}

// First hit wins. env: candidates check process env + rc files; file
// candidates check existence after tilde expansion. Returns the candidate
// as written (with "~" or "env:" prefix), same as the Swift locator.
export async function firstExistingCredentialPath(
  paths: string[],
  deps: InventoryDeps,
  shellCredentialNames?: Set<string>,
): Promise<string | undefined> {
  const rcNames =
    shellCredentialNames ?? (await loadShellCredentialNames(deps));
  for (const candidate of paths) {
    if (candidate.startsWith("env:")) {
      const name = candidate.slice("env:".length);
      const value = deps.env[name];
      if ((value !== undefined && value !== "") || rcNames.has(name)) {
        return candidate;
      }
      continue;
    }
    if (await pathExists(expandTilde(candidate, deps.home))) {
      return candidate;
    }
  }
  return undefined;
}

// Port of HeuristicCredentialPathSuggester.ecosystemCredentialPathsByName.
const ecosystemCredentialPathsByName: Record<string, string[]> = {
  aws: ["~/.aws/credentials", "~/.aws/config", "~/.aws/sso/cache"],
  awscli: ["~/.aws/credentials", "~/.aws/config", "~/.aws/sso/cache"],
  "aws-cli": ["~/.aws/credentials", "~/.aws/config", "~/.aws/sso/cache"],
  gcloud: [
    "~/.config/gcloud/credentials.db",
    "~/.config/gcloud/application_default_credentials.json",
  ],
  google: [
    "~/.config/gcloud/credentials.db",
    "~/.config/gcloud/application_default_credentials.json",
  ],
  cloudsdk: [
    "~/.config/gcloud/credentials.db",
    "~/.config/gcloud/application_default_credentials.json",
  ],
  "cloud-sdk": [
    "~/.config/gcloud/credentials.db",
    "~/.config/gcloud/application_default_credentials.json",
  ],
  "google-cloud-sdk": [
    "~/.config/gcloud/credentials.db",
    "~/.config/gcloud/application_default_credentials.json",
  ],
  az: ["~/.azure/msal_token_cache.json", "~/.azure/accessTokens.json"],
  azure: ["~/.azure/msal_token_cache.json", "~/.azure/accessTokens.json"],
  azurecli: ["~/.azure/msal_token_cache.json", "~/.azure/accessTokens.json"],
  "azure-cli": ["~/.azure/msal_token_cache.json", "~/.azure/accessTokens.json"],
  docker: ["~/.docker/config.json"],
  "docker-compose": ["~/.docker/config.json"],
  npm: ["~/.npmrc"],
  npx: ["~/.npmrc"],
  pnpm: ["~/.npmrc"],
  yarn: ["~/.yarnrc.yml", "~/.npmrc"],
  bun: ["~/.bunfig.toml", "~/.npmrc"],
  bunx: ["~/.bunfig.toml", "~/.npmrc"],
  kubectl: ["~/.kube/config"],
  kubectx: ["~/.kube/config"],
  kubens: ["~/.kube/config"],
  helm: ["~/.config/helm/registry/config.json", "~/.kube/config"],
  git: ["~/.git-credentials", "~/.config/git/credentials", "~/.netrc"],
  gem: ["~/.gem/credentials"],
  bundle: ["~/.gem/credentials"],
  bundler: ["~/.gem/credentials"],
  pip: ["~/.pypirc"],
  pip3: ["~/.pypirc"],
  twine: ["~/.pypirc"],
  github: ["~/.config/gh/hosts.yml"],
  "github-cli": ["~/.config/gh/hosts.yml"],
  gh: ["~/.config/gh/hosts.yml"],
  glab: ["~/.config/glab-cli/config.yml"],
  huggingface: ["~/.cache/huggingface/token", "~/.huggingface/token"],
  hf: ["~/.cache/huggingface/token", "~/.huggingface/token"],
  terraform: ["~/.terraform.d/credentials.tfrc.json"],
  tofu: ["~/.terraform.d/credentials.tfrc.json"],
  pulumi: ["~/.pulumi/credentials.json"],
  vercel: ["~/.config/com.vercel.cli/auth.json"],
  railway: ["~/.config/railway/config.json", "~/.railway/config.json"],
  render: ["~/.render/cli.yaml"],
  netlify: ["~/.config/netlify/config.json"],
  supabase: ["~/.supabase/access-token", "~/.config/supabase/access-token"],
  fly: ["~/.fly/config.yml"],
  flyctl: ["~/.fly/config.yml"],
  heroku: ["~/.netrc", "~/.config/heroku"],
  doctl: ["~/.config/doctl/config.yaml"],
  stripe: ["~/.config/stripe/config.toml"],
  wrangler: [
    "~/.wrangler/config/default.toml",
    "~/.config/.wrangler/config/default.toml",
  ],
  cloudflared: [
    "~/.cloudflared/cert.pem",
    "~/.cloudflared/config.yml",
    "~/.cloudflared/config.yaml",
    "/etc/cloudflared/cert.pem",
    "/usr/local/etc/cloudflared/cert.pem",
  ],
  op: ["~/.config/op/config"],
  doppler: ["~/.doppler/.doppler.yaml"],
  vault: ["~/.vault-token"],
  sentry: ["~/.sentry/cli.db", "~/.sentryclirc"],
  "sentry-cli": ["~/.sentry/cli.db", "~/.sentryclirc"],
  firebase: ["~/.config/configstore/firebase-tools.json"],
  eas: ["~/.expo/state.json", "~/.expo/settings.json"],
  expo: ["~/.expo/state.json", "~/.expo/settings.json"],
  ngrok: [
    "~/Library/Application Support/ngrok/ngrok.yml",
    "~/.config/ngrok/ngrok.yml",
    "~/.ngrok2/ngrok.yml",
  ],
  circleci: ["~/.circleci/cli.yml"],
  codex: ["~/.codex/auth.json"],
  openai: ["~/.config/openai/auth.json", "~/.openai/auth.json"],
  claude: ["~/.claude/.credentials.json", "~/.claude.json"],
  gemini: ["~/.gemini/oauth_creds.json", "~/.gemini/settings.json"],
  q: ["~/.aws/amazonq/cache", "~/.aws/sso/cache"],
  cursor: ["~/.cursor/credentials.json", "~/.config/cursor/credentials.json"],
  aider: ["~/.aider.conf.yml", "~/.aider.conf.yaml", "~/.aider.conf"],
  replicate: ["~/.replicate", "~/.config/replicate/auth.json"],
  perplexity: ["~/.config/perplexity/auth.json", "~/.perplexity/auth.json"],
  opencode: [
    "~/.local/share/opencode/auth.json",
    "~/.config/opencode/auth.json",
  ],
  qwen: ["~/.qwen/.env", "~/.qwen/settings.json"],
  databricks: ["~/.databrickscfg"],
  snow: [
    "~/.snowflake/config.toml",
    "~/.snowflake/connections.toml",
    "~/Library/Application Support/snowflake/config.toml",
    "~/Library/Application Support/snowflake/connections.toml",
    "~/.config/snowflake/config.toml",
    "~/.config/snowflake/connections.toml",
  ],
};

function ecosystemEnvironmentCredentials(name: string): string[] {
  switch (name) {
    case "aws":
    case "awscli":
    case "aws-cli":
      return ["env:AWS_ACCESS_KEY_ID", "env:AWS_PROFILE"];
    case "gcloud":
    case "google":
    case "cloudsdk":
    case "cloud-sdk":
    case "google-cloud-sdk":
      return ["env:GOOGLE_APPLICATION_CREDENTIALS", "env:GOOGLE_API_KEY"];
    case "az":
    case "azure":
    case "azurecli":
    case "azure-cli":
      return [
        "env:AZURE_CLIENT_ID",
        "env:AZURE_TENANT_ID",
        "env:AZURE_SUBSCRIPTION_ID",
      ];
    case "openai":
      return ["env:OPENAI_API_KEY"];
    case "claude":
    case "anthropic":
      return ["env:ANTHROPIC_API_KEY", "env:CLAUDE_API_KEY"];
    case "gemini":
      return ["env:GEMINI_API_KEY", "env:GOOGLE_API_KEY"];
    case "huggingface":
    case "huggingface-cli":
    case "hf":
      return ["env:HF_TOKEN", "env:HUGGINGFACE_HUB_TOKEN"];
    case "replicate":
      return ["env:REPLICATE_API_TOKEN"];
    case "perplexity":
      return ["env:PERPLEXITY_API_KEY"];
    case "groq":
      return ["env:GROQ_API_KEY"];
    case "mistral":
      return ["env:MISTRAL_API_KEY"];
    case "cohere":
      return ["env:COHERE_API_KEY", "env:CO_API_KEY"];
    case "together":
      return ["env:TOGETHER_API_KEY"];
    case "fireworks":
      return ["env:FIREWORKS_API_KEY"];
    case "openrouter":
      return ["env:OPENROUTER_API_KEY"];
    case "deepseek":
      return ["env:DEEPSEEK_API_KEY"];
    case "qwen":
      return ["env:DASHSCOPE_API_KEY", "env:QWEN_API_KEY"];
    case "stripe":
      return ["env:STRIPE_API_KEY"];
    case "github":
    case "gh":
      return ["env:GH_TOKEN", "env:GITHUB_TOKEN"];
    case "gitlab":
    case "glab":
      return ["env:GITLAB_TOKEN"];
    case "vercel":
      return ["env:VERCEL_TOKEN"];
    case "netlify":
      return ["env:NETLIFY_AUTH_TOKEN"];
    case "supabase":
      return ["env:SUPABASE_ACCESS_TOKEN", "env:SUPABASE_TOKEN"];
    case "render":
      return ["env:RENDER_API_KEY"];
    case "railway":
      return ["env:RAILWAY_TOKEN"];
    case "databricks":
      return ["env:DATABRICKS_TOKEN"];
    case "snow":
      return ["env:SNOWFLAKE_TOKEN"];
    default:
      return [];
  }
}

function genericEnvironmentCredentials(name: string): string[] {
  const normalized = name
    .toUpperCase()
    .split("")
    .map((character) => (/[A-Z0-9]/u.test(character) ? character : "_"))
    .join("");
  const prefix = normalized.split("_").filter(Boolean).join("_");
  if (!prefix) {
    return [];
  }
  return [
    `env:${prefix}_API_KEY`,
    `env:${prefix}_TOKEN`,
    `env:${prefix}_ACCESS_TOKEN`,
  ];
}

function kebabCase(value: string): string {
  const characters = [...value];
  let output = "";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    if (/[A-Z]/u.test(character)) {
      const previous = index > 0 ? (characters[index - 1] ?? "") : "";
      const next =
        index < characters.length - 1 ? (characters[index + 1] ?? "") : "";
      const previousIsLowerOrDigit = /[a-z0-9]/u.test(previous);
      const nextIsLower = /[a-z]/u.test(next);
      if (output && (previousIsLowerOrDigit || nextIsLower)) {
        output += "-";
      }
      output += character.toLowerCase();
    } else if (
      character === "_" ||
      character === " " ||
      character === "." ||
      character === ":" ||
      character === "/"
    ) {
      output += "-";
    } else {
      output += character.toLowerCase();
    }
  }
  return output.split("-").filter(Boolean).join("-");
}

function normalizedNames(executable: string): string[] {
  const trimmed = executable.trim();
  const lowercased = trimmed.toLowerCase();
  const packageComponents = lowercased.split(/[.:/ ]/u).filter(Boolean);
  const kebabCasedComponents = trimmed
    .split(/[.:/ ]/u)
    .filter(Boolean)
    .map(kebabCase);
  const baseNames = dedupe(
    [
      lowercased,
      kebabCase(trimmed),
      ...packageComponents,
      ...kebabCasedComponents,
    ].filter(Boolean),
  );
  const strippedSuffixes = baseNames
    .map((name) => {
      for (const suffix of ["-cli", "_cli", "cli"]) {
        if (name.endsWith(suffix) && name.length > suffix.length) {
          return name
            .slice(0, name.length - suffix.length)
            .replace(/^[-_]+|[-_]+$/gu, "");
        }
      }
      return null;
    })
    .filter((name): name is string => !!name);
  return dedupe([...baseNames, ...strippedSuffixes].filter(Boolean));
}

// Credential candidates for a name, in resolution order: ecosystem file
// paths, ecosystem env vars, generic env vars, conventional config paths.
export function candidateCredentialPaths(executable: string): string[] {
  const names = normalizedNames(executable);
  return dedupe([
    ...names.flatMap((name) => ecosystemCredentialPathsByName[name] ?? []),
    ...names.flatMap(ecosystemEnvironmentCredentials),
    ...names.flatMap(genericEnvironmentCredentials),
    ...names.flatMap((name) => [
      `~/.config/${name}/credentials`,
      `~/.config/${name}/credentials.json`,
      `~/.config/${name}/auth.json`,
      `~/.config/${name}/auth.yml`,
      `~/.config/${name}/token`,
      `~/.config/${name}/tokens.json`,
      `~/.config/${name}/access-token`,
      `~/.config/${name}/session.json`,
      `~/.${name}/credentials`,
      `~/.${name}/credentials.json`,
      `~/.${name}/auth.json`,
      `~/.${name}/auth.yml`,
      `~/.${name}/token`,
      `~/.${name}/tokens.json`,
      `~/.${name}/access-token`,
      `~/.${name}/session.json`,
    ]),
  ]);
}

// Registry credentialPaths first, then the heuristic chain for the title and
// every executable. When the CLI is not installed on disk only env: evidence
// is considered (a login without the binary still counts).
function credentialCandidatePathsFor(
  def: CLIRegistryDefinition,
  includeFileHeuristics: boolean,
): string[] {
  const heuristic = [def.title, ...def.executables].flatMap(
    candidateCredentialPaths,
  );
  const filtered = includeFileHeuristics
    ? heuristic
    : heuristic.filter((path) => path.startsWith("env:"));
  return dedupe([...def.credentialPaths, ...filtered]);
}

// ---------------------------------------------------------------------------
// Inventory scan (port of CLIInventoryScanner.scanResult)
// ---------------------------------------------------------------------------

// Sesshy keeps every unmatched executable as a discovered item; cap the
// noise so a PATH full of junk can't flood the payload.
const MAX_DISCOVERED_ITEMS = 500;

function sortTools(tools: ToolItem[]): ToolItem[] {
  return [...tools].sort((a, b) => {
    if (a.state !== b.state) {
      return a.state === "loggedIn" ? -1 : 1;
    }
    return compareStrings(a.title, b.title);
  });
}

async function locateExecutable(
  searchPaths: string[],
  executable: string,
): Promise<string | null> {
  for (const directory of searchPaths) {
    const path = `${directory}/${executable}`;
    if (await isExecutableFile(path)) {
      return path;
    }
  }
  return null;
}

export async function scanInventory(
  deps: InventoryDeps,
  registry: MergedRegistry,
): Promise<ToolItem[]> {
  const searchPaths = await computeSearchPaths(deps);
  const discoveredExecutables: InstalledExecutable[] = [];
  const seenNames = new Set<string>();
  for (const executable of await listExecutables(searchPaths)) {
    const key = executable.name.toLowerCase();
    if (seenNames.has(key)) {
      continue;
    }
    seenNames.add(key);
    discoveredExecutables.push(executable);
  }
  const discoveredByName = new Map(
    discoveredExecutables.map((executable) => [
      executable.name.toLowerCase(),
      executable,
    ]),
  );
  const useLocatorFallback = discoveredExecutables.length === 0;
  const rcCredentialNames = await loadShellCredentialNames(deps);

  const registeredItems: ToolItem[] = [];
  for (const def of registry.definitions) {
    const firstExecutable = def.executables[0];
    if (!firstExecutable) {
      continue;
    }
    let installed: InstalledExecutable | null = null;
    for (const executable of def.executables) {
      const hit = discoveredByName.get(executable.toLowerCase());
      if (hit) {
        installed = hit;
        break;
      }
      if (useLocatorFallback) {
        const path = await locateExecutable(searchPaths, executable);
        if (path) {
          installed = { name: executable, path };
          break;
        }
      }
    }
    const credentialPath = await firstExistingCredentialPath(
      credentialCandidatePathsFor(def, installed !== null),
      deps,
      rcCredentialNames,
    );
    if (!installed && !credentialPath) {
      continue;
    }
    registeredItems.push({
      executable: installed?.name ?? firstExecutable,
      title: def.title,
      kind: def.kind,
      state: credentialPath ? "loggedIn" : "installed",
      source: "registry",
      installedPath: installed?.path,
      credentialPath,
    });
  }

  let discoveredItems: ToolItem[] = [];
  for (const executable of discoveredExecutables) {
    if (registry.byExecutable.has(executable.name.toLowerCase())) {
      continue;
    }
    const credentialPath = await firstExistingCredentialPath(
      candidateCredentialPaths(executable.name),
      deps,
      rcCredentialNames,
    );
    discoveredItems.push({
      executable: executable.name,
      title: executable.name,
      kind: "generic",
      state: credentialPath ? "loggedIn" : "installed",
      source: "discovered",
      installedPath: executable.path,
      credentialPath,
    });
  }
  discoveredItems = sortTools(discoveredItems).slice(0, MAX_DISCOVERED_ITEMS);

  return sortTools([...registeredItems, ...discoveredItems]);
}

// ---------------------------------------------------------------------------
// Credential expiry (port of CredentialExpiry.swift)
// ---------------------------------------------------------------------------

// SSO/ADC/auth files are tiny; skip anything oversized so a rogue file can't
// stall the scan or balloon memory.
const MAX_CREDENTIAL_FILE_BYTES = 1_000_000;

export function urgencyFor(now: Date, expiresAt: Date): CredentialUrgency {
  const minutes = (expiresAt.getTime() - now.getTime()) / 60_000;
  if (minutes <= 0) {
    return "expired";
  }
  if (minutes < 15) {
    return "imminent";
  }
  if (minutes < 60) {
    return "soon";
  }
  return "ok";
}

async function readCredentialJson(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_CREDENTIAL_FILE_BYTES) {
      return null;
    }
    const json: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return null;
    }
    return json as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseExpiryDate(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

async function scanAwsSsoExpiry(
  deps: InventoryDeps,
): Promise<CredentialExpiryItem[]> {
  const dir = join(deps.home, ".aws", "sso", "cache");
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const results: CredentialExpiryItem[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const path = join(dir, name);
    const obj = await readCredentialJson(path);
    if (!obj) {
      continue;
    }
    const expiresAt = parseExpiryDate(obj.expiresAt ?? obj.expiration);
    if (!expiresAt) {
      continue;
    }
    const label =
      typeof obj.startUrl === "string"
        ? obj.startUrl
        : typeof obj.accountId === "string"
          ? obj.accountId
          : name;
    results.push({
      provider: "aws",
      label,
      expiresAt: expiresAt.toISOString(),
      urgency: urgencyFor(deps.now, expiresAt),
      evidencePath: path,
    });
  }
  return results;
}

async function scanGCloudExpiry(
  deps: InventoryDeps,
): Promise<CredentialExpiryItem[]> {
  const path = join(
    deps.home,
    ".config",
    "gcloud",
    "application_default_credentials.json",
  );
  const obj = await readCredentialJson(path);
  if (!obj) {
    return [];
  }
  const expiresAt = parseExpiryDate(obj.token_expiry ?? obj.expiry);
  if (!expiresAt) {
    return [];
  }
  return [
    {
      provider: "gcloud",
      label: typeof obj.account === "string" ? obj.account : "ADC",
      expiresAt: expiresAt.toISOString(),
      urgency: urgencyFor(deps.now, expiresAt),
      evidencePath: path,
    },
  ];
}

async function scanVercelExpiry(
  deps: InventoryDeps,
): Promise<CredentialExpiryItem[]> {
  const candidates = [
    join(
      deps.home,
      "Library",
      "Application Support",
      "com.vercel.cli",
      "auth.json",
    ),
    join(deps.home, ".config", "com.vercel.cli", "auth.json"),
  ];
  for (const path of candidates) {
    const obj = await readCredentialJson(path);
    if (!obj) {
      continue;
    }
    const expiresAtRaw = obj.expiresAt;
    if (typeof expiresAtRaw !== "number" || !Number.isFinite(expiresAtRaw)) {
      continue;
    }
    // Vercel's auth.json stores epoch *seconds* (Sesshy reads it as ms and
    // renders "expired 1970" — a bug we deliberately don't port). Anything
    // below 1e12 can't be a sane ms timestamp, so treat it as seconds.
    const expiresAtMs =
      expiresAtRaw < 1e12 ? expiresAtRaw * 1000 : expiresAtRaw;
    const expiresAt = new Date(expiresAtMs);
    return [
      {
        provider: "vercel",
        label: typeof obj.user === "string" ? obj.user : "Vercel",
        expiresAt: expiresAt.toISOString(),
        urgency: urgencyFor(deps.now, expiresAt),
        evidencePath: path,
      },
    ];
  }
  return [];
}

export async function scanCredentialExpiries(
  deps: InventoryDeps,
): Promise<CredentialExpiryItem[]> {
  const records = [
    ...(await scanAwsSsoExpiry(deps)),
    ...(await scanGCloudExpiry(deps)),
    ...(await scanVercelExpiry(deps)),
  ];
  return records.sort((a, b) => compareStrings(a.expiresAt, b.expiresAt));
}

// ---------------------------------------------------------------------------
// Payload + caches
// ---------------------------------------------------------------------------

async function assemblePayload(
  deps: InventoryDeps,
  registry: MergedRegistry,
): Promise<ToolsPayload> {
  const [tools, expiring] = await Promise.all([
    scanInventory(deps, registry),
    scanCredentialExpiries(deps),
  ]);
  return {
    generatedAt: deps.now.toISOString(),
    counts: {
      total: tools.length,
      loggedIn: tools.filter((tool) => tool.state === "loggedIn").length,
      installed: tools.filter((tool) => tool.state === "installed").length,
      discovered: tools.filter((tool) => tool.source === "discovered").length,
    },
    tools,
    expiring,
  };
}

export async function buildToolsPayload(
  deps: InventoryDeps,
): Promise<ToolsPayload> {
  return assemblePayload(deps, await loadMergedRegistry(deps));
}

const REGISTRY_CACHE_TTL_MS = 10 * 60 * 1000;
const PAYLOAD_CACHE_TTL_MS = 5 * 60 * 1000;

let registryCache: {
  expiresAt: number;
  value: Promise<MergedRegistry>;
} | null = null;
let payloadCache: { expiresAt: number; value: Promise<ToolsPayload> } | null =
  null;

async function loadMergedRegistryCached(
  deps: InventoryDeps,
): Promise<MergedRegistry> {
  const now = Date.now();
  if (registryCache && now < registryCache.expiresAt) {
    return registryCache.value;
  }
  const value = loadMergedRegistry(deps);
  registryCache = { expiresAt: now + REGISTRY_CACHE_TTL_MS, value };
  return value;
}

function emptyPayload(): ToolsPayload {
  return {
    generatedAt: new Date().toISOString(),
    counts: { total: 0, loggedIn: 0, installed: 0, discovered: 0 },
    tools: [],
    expiring: [],
  };
}

export async function getToolsPayload(): Promise<ToolsPayload> {
  const now = Date.now();
  if (payloadCache && now < payloadCache.expiresAt) {
    return payloadCache.value;
  }
  const value = (async (): Promise<ToolsPayload> => {
    try {
      const deps = defaultInventoryDeps();
      const registry = await loadMergedRegistryCached(deps);
      return await assemblePayload(deps, registry);
    } catch {
      return emptyPayload();
    }
  })();
  payloadCache = { expiresAt: now + PAYLOAD_CACHE_TTL_MS, value };
  return value;
}

// Test-only escape hatch: drops both in-module caches.
export function clearInventoryCaches(): void {
  registryCache = null;
  payloadCache = null;
}
