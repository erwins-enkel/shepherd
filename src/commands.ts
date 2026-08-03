import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { AgentProvider } from "./types";

/** Where a discovered slash command came from — drives the row badge and dedupe
 *  precedence (project > user > plugin > builtin). Skills are folded into
 *  project/user by location; plugin = installed plugin command/skill. */
export type SlashCommandScope = "project" | "user" | "plugin" | "builtin";

/** An installed slash command surfaced in the New Task "Commands" tab and the
 *  inline `/` autocomplete. A skill (`.claude/skills/<name>/SKILL.md`), a command
 *  file (`.claude/commands/<name>.md`), an installed plugin command/skill, or a
 *  built-in — invokable from the prompt as `/<name>`. */
export interface SlashCommand {
  id: string;
  name: string;
  displayName: string;
  description: string;
  scope: SlashCommandScope;
  kind: "skill" | "command" | "plugin";
  invocationName: string;
  sourceNamespace: string;
  sourcePath?: string;
  providers: AgentProvider[];
  invocations: Partial<Record<AgentProvider, string>>;
  /** Front-matter `argument-hint` (e.g. "<ticket>"), shown dimmed after the name. */
  argumentHint?: string;
}

// Descriptions ride to the client uncapped. They used to be clipped to a fixed length as
// a payload guard, but the row's hover tooltip now *shows* this value, so any cap is text
// a reader is silently denied. It was never buying much either: across a real 211-command
// listing the longest description is ~1.1 KB and capping at 600 saved 4 KB of ~75 KB (6%),
// while mutilating 13% of the entries. The UI bounds the tooltip's height instead, which
// costs nothing and keeps the sentence intact.

interface Frontmatter {
  name?: string;
  description?: string;
  "argument-hint"?: string;
}

/** Index of the closing `---` fence, or -1 when the front-matter is unterminated. */
function fenceEnd(lines: string[]): number {
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") return i;
  }
  return -1;
}

/** Strip a single layer of matching surrounding quotes. */
function unquote(val: string): string {
  const q = val[0];
  if ((q === '"' || q === "'") && val.length >= 2 && val.endsWith(q)) return val.slice(1, -1);
  return val;
}

/** Split leading `---`-fenced YAML front-matter from the body. Only the single-line
 *  `name`/`description` scalars are read (all skill/command front-matter uses those);
 *  anything fancier is ignored, not parsed. */
function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
  if (!text.startsWith("---")) return { fm: {}, body: text };
  const lines = text.split("\n");
  const end = fenceEnd(lines);
  if (end === -1) return { fm: {}, body: text };
  const fm: Frontmatter = {};
  for (let i = 1; i < end; i++) {
    const m = /^(name|description|argument-hint)\s*:\s*(.*)$/.exec(lines[i]!);
    if (m) fm[m[1] as keyof Frontmatter] = unquote(m[2]!.trim());
  }
  return { fm, body: lines.slice(end + 1).join("\n") };
}

/** The identity Claude Code gives a skill/command: its front-matter `name`, falling back to the
 *  entry it was found under (directory for a skill, filename for a command file). One rule, two
 *  readers — {@link readCommand} for the listing, {@link skillNameFrom} for the drain context trim,
 *  which keys `skillOverrides` by exactly this string. Empty = unusable entry. */
function resolvedName(fm: Frontmatter, fallbackName: string): string {
  return (fm.name?.trim() || fallbackName).trim();
}

/**
 * Resolve one skill's identity from its raw `SKILL.md` text (issue #2001).
 *
 * The drain trim disables the operator's user-level skills per-spawn via `skillOverrides`, which is
 * keyed by skill NAME — and a directory listing is not that name: entries under `~/.claude/skills`
 * are commonly symlinks into other trees, and front-matter may rename the skill outright. Keying off
 * the directory would then both miss the skill (no saving) and compare the wrong string against the
 * repo's own skills (silently disabling one). Sharing {@link resolvedName} with the listing is what
 * keeps the trim and the UI on the same identity.
 */
export function skillNameFrom(text: string, fallbackName: string): string {
  return resolvedName(parseFrontmatter(text).fm, fallbackName);
}

/** First non-empty body line (heading marker stripped) — the description fallback
 *  for command files that carry no front-matter `description`. */
function firstLine(body: string): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line) return line.replace(/^#+\s*/, "");
  }
  return "";
}

function readCommand(
  path: string,
  fallbackName: string,
  scope: SlashCommand["scope"],
  prefix = "",
  kind: SlashCommand["kind"] = "command",
): SlashCommand | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // unreadable file → skip, don't fail the whole listing
  }
  const { fm, body } = parseFrontmatter(text);
  const bare = resolvedName(fm, fallbackName);
  if (!bare) return null;
  const description = (fm.description?.trim() || firstLine(body)).trim();
  const argumentHint = fm["argument-hint"]?.trim() || undefined;
  const name = prefix + bare;
  return {
    id: `claude:${scope}:${name}`,
    name,
    displayName: name,
    description,
    scope,
    kind,
    invocationName: name,
    sourceNamespace: `claude:${scope}`,
    sourcePath: path,
    providers: ["claude"],
    invocations: { claude: `/${name}` },
    argumentHint,
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return []; // missing dir is the norm (not every repo/home has skills) → empty
  }
}

/** Scan one `.claude`-shaped dir (a real `.claude` or a plugin install root) for
 *  skills + commands, merging into `out` keyed by name. `prefix` namespaces plugin
 *  entries (`fallow:` → `fallow:foo`) so they can't clash with bare user commands. */
function collect(
  claudeDir: string,
  scope: SlashCommand["scope"],
  out: Map<string, SlashCommand>,
  prefix = "",
) {
  const skillsDir = join(claudeDir, "skills");
  for (const entry of safeReaddir(skillsDir)) {
    const md = join(skillsDir, entry, "SKILL.md");
    if (!existsSync(md)) continue;
    const cmd = readCommand(md, entry, scope, prefix, "skill");
    if (cmd) out.set(cmd.name, cmd);
  }
  const cmdsDir = join(claudeDir, "commands");
  for (const entry of safeReaddir(cmdsDir)) {
    if (!entry.endsWith(".md")) continue;
    const file = join(cmdsDir, entry);
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const cmd = readCommand(file, entry.slice(0, -3), scope, prefix);
    if (cmd) out.set(cmd.name, cmd);
  }
}

/**
 * Curated built-in slash commands that work as an initial prompt for a spawned
 * session. Purely-interactive ones (/clear, /config, /model, /compact) are
 * excluded — they do nothing useful as a first message. Maintained by hand.
 */
const BUILTINS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "init", description: "Initialize a new CLAUDE.md with codebase documentation" },
  { name: "review", description: "Review a pull request" },
  {
    name: "security-review",
    description: "Complete a security review of the pending changes on the current branch",
  },
  { name: "pr-comments", description: "Get comments from a GitHub pull request" },
];

type CodexConfig = { skills?: { config?: Array<{ path?: unknown; enabled?: unknown }> } };

function commandContentHash(path: string): string | undefined {
  try {
    return createHash("sha256")
      .update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"))
      .digest("hex");
  } catch {
    return undefined;
  }
}

function codexHomeDefault(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function disabledSkillPaths(codexHome: string): Set<string> {
  let parsed: CodexConfig;
  try {
    parsed = Bun.TOML.parse(readFileSync(join(codexHome, "config.toml"), "utf8")) as CodexConfig;
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  for (const entry of parsed.skills?.config ?? []) {
    if (typeof entry.path !== "string" || entry.enabled !== false) continue;
    out.add(resolve(entry.path));
    out.add(resolve(entry.path, "SKILL.md"));
  }
  return out;
}

function isDisabledSkill(path: string, disabled: Set<string>): boolean {
  const skillPath = resolve(path);
  return disabled.has(skillPath) || disabled.has(resolve(skillPath, ".."));
}

function readCodexSkill(
  path: string,
  sourceNamespace: string,
  disabled: Set<string>,
  prefix = "",
): SlashCommand | null {
  if (isDisabledSkill(path, disabled)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { fm } = parseFrontmatter(text);
  const bare = fm.name?.trim();
  if (!bare) return null;
  const name = prefix + bare;
  const description = fm.description?.trim() || "";
  return {
    id: `${sourceNamespace}:${name}`,
    name,
    displayName: name,
    description,
    scope: sourceNamespace.startsWith("codex:repo")
      ? "project"
      : sourceNamespace.startsWith("codex:plugin")
        ? "plugin"
        : "user",
    kind: "skill",
    invocationName: name,
    sourceNamespace,
    sourcePath: path,
    providers: ["codex"],
    invocations: { codex: `$${name}` },
  };
}

function collectCodexSkillRoot(
  root: string,
  sourceNamespace: string,
  disabled: Set<string>,
  out: SlashCommand[],
  prefix = "",
) {
  for (const entry of safeReaddir(root)) {
    const md = join(root, entry, "SKILL.md");
    if (!existsSync(md)) continue;
    const cmd = readCodexSkill(md, sourceNamespace, disabled, prefix);
    if (cmd) out.push(cmd);
  }
}

interface CodexPluginManifest {
  name?: string;
  version?: string;
  description?: string;
  skills?: string;
  interface?: {
    displayName?: string;
    shortDescription?: string;
  };
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function pluginVersionRoot(pluginRoot: string): string | null {
  const versions = safeReaddir(pluginRoot)
    .map((entry) => join(pluginRoot, entry))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, ".codex-plugin", "plugin.json"));
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
  return versions.at(-1) ?? null;
}

function codexPluginDescription(manifest: CodexPluginManifest | null, fallback: string): string {
  return manifest?.interface?.shortDescription?.trim() || manifest?.description?.trim() || fallback;
}

function codexPluginSkillsDir(
  versionRoot: string,
  manifest: CodexPluginManifest | null,
): string | null {
  if (typeof manifest?.skills !== "string") return null;
  return join(versionRoot, manifest.skills.replace(/^\.\//, ""));
}

function collectCodexPlugin(
  pluginRoot: string,
  pluginEntry: string,
  marketplace: string,
  disabled: Set<string>,
  out: SlashCommand[],
) {
  if (!existsSync(join(pluginRoot, ".codex-remote-plugin-install.json"))) return;
  const versionRoot = pluginVersionRoot(pluginRoot);
  if (!versionRoot) return;
  const manifest = readJson(
    join(versionRoot, ".codex-plugin", "plugin.json"),
  ) as CodexPluginManifest | null;
  const pluginName = manifest?.name?.trim() || pluginEntry;
  out.push({
    id: `codex:plugin:${marketplace}:${pluginName}`,
    name: pluginName,
    displayName: pluginName,
    description: codexPluginDescription(manifest, pluginName),
    scope: "plugin",
    kind: "plugin",
    invocationName: pluginName,
    sourceNamespace: `codex:plugin:${marketplace}:${pluginName}`,
    sourcePath: versionRoot,
    providers: ["codex"],
    invocations: {},
  });
  const skillsDir = codexPluginSkillsDir(versionRoot, manifest);
  if (!skillsDir) return;
  collectCodexSkillRoot(
    skillsDir,
    `codex:plugin:${marketplace}:${pluginName}`,
    disabled,
    out,
    `${pluginName}:`,
  );
}

function collectCodexPlugins(codexHome: string, disabled: Set<string>, out: SlashCommand[]) {
  const cacheDir = join(codexHome, "plugins", "cache");
  for (const marketplace of safeReaddir(cacheDir)) {
    const marketplaceDir = join(cacheDir, marketplace);
    for (const pluginEntry of safeReaddir(marketplaceDir)) {
      collectCodexPlugin(
        join(marketplaceDir, pluginEntry),
        pluginEntry,
        marketplace,
        disabled,
        out,
      );
    }
  }
}

function mergeEquivalentRows(rows: SlashCommand[]): SlashCommand[] {
  const out: SlashCommand[] = [];
  for (const row of rows) {
    if (row.providers.length !== 1) {
      out.push(row);
      continue;
    }
    const hash = row.sourcePath ? commandContentHash(row.sourcePath) : undefined;
    const match =
      hash &&
      out.find(
        (existing) =>
          existing.kind === row.kind &&
          existing.name === row.name &&
          existing.sourcePath &&
          commandContentHash(existing.sourcePath) === hash,
      );
    if (!match || match.providers.includes(row.providers[0]!)) {
      out.push(row);
      continue;
    }
    match.providers = [...match.providers, row.providers[0]!].sort();
    match.invocations = { ...match.invocations, ...row.invocations };
    match.id = `both:${match.kind}:${match.name}:${hash.slice(0, 12)}`;
    match.sourceNamespace = `${match.sourceNamespace}+${row.sourceNamespace}`;
  }
  return out;
}

/** Re-root an absolute installPath under the local `~/.claude`. installPath is
 *  stored verbatim and may carry another machine's `$HOME` (settings sync across
 *  machines), so anchor on the `.claude/` segment. */
function rerootInstallPath(raw: string, userClaudeDir: string): string {
  const norm = raw.replace(/\\/g, "/");
  const idx = norm.indexOf(".claude/");
  return idx >= 0 ? join(userClaudeDir, norm.slice(idx + ".claude/".length)) : raw;
}

/**
 * Scan installed plugins (the authoritative `installed_plugins.json` — the
 * marketplace tree holds the whole catalog, not what's enabled). Each plugin's
 * commands + skills are namespaced `<plugin>:<name>`. Project-scoped plugins are
 * included only for their own project dir.
 */
function collectPlugins(
  userClaudeDir: string,
  repoDir: string | null,
  out: Map<string, SlashCommand>,
) {
  let text: string;
  try {
    text = readFileSync(join(userClaudeDir, "plugins", "installed_plugins.json"), "utf8");
  } catch {
    return; // no plugins installed → nothing to add
  }
  let parsed: { plugins?: Record<string, Array<Record<string, unknown>>> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
    const plugin = key.split("@")[0] || key;
    for (const e of entries) {
      if (typeof e.installPath !== "string") continue;
      if (e.scope === "project" && typeof e.projectPath === "string" && e.projectPath !== repoDir)
        continue;
      collect(rerootInstallPath(e.installPath, userClaudeDir), "plugin", out, `${plugin}:`);
    }
  }
}

/** Discover installed slash commands for the New Task picker and inline `/`
 *  autocomplete. Built in precedence order (lowest first, each later source
 *  shadowing earlier on a name clash): builtin → plugin → user → project. Sorted
 *  by name. `repoDir` null → no project layer. */
export function listCommands(
  repoDir: string | null,
  userClaudeDir: string,
  opts: { userHome?: string; codexHome?: string; provider?: AgentProvider } = {},
): SlashCommand[] {
  const out = new Map<string, SlashCommand>();
  if (opts.provider !== "codex") {
    for (const b of BUILTINS)
      out.set(b.name, {
        id: `claude:builtin:${b.name}`,
        name: b.name,
        displayName: b.name,
        description: b.description,
        scope: "builtin",
        kind: "command",
        invocationName: b.name,
        sourceNamespace: "claude:builtin",
        providers: ["claude"],
        invocations: { claude: `/${b.name}` },
      });
    collectPlugins(userClaudeDir, repoDir, out);
    collect(userClaudeDir, "user", out);
    if (repoDir) collect(join(repoDir, ".claude"), "project", out);
  }
  const rows = [...out.values()];
  if (opts.provider !== "claude") {
    const codexHome = opts.codexHome ?? codexHomeDefault();
    const userHome = opts.userHome ?? homedir();
    const disabled = disabledSkillPaths(codexHome);
    if (repoDir)
      collectCodexSkillRoot(join(repoDir, ".agents", "skills"), "codex:repo", disabled, rows);
    collectCodexSkillRoot(join(userHome, ".agents", "skills"), "codex:user", disabled, rows);
    collectCodexSkillRoot(join(codexHome, "skills", ".system"), "codex:system", disabled, rows);
    collectCodexSkillRoot("/etc/codex/skills", "codex:admin", disabled, rows);
    collectCodexPlugins(codexHome, disabled, rows);
  }
  return mergeEquivalentRows(rows).sort((a, b) => a.name.localeCompare(b.name));
}
