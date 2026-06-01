import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where a discovered slash command came from — drives the row badge and dedupe
 *  precedence (project > user > plugin > builtin). Skills are folded into
 *  project/user by location; plugin = installed plugin command/skill. */
export type SlashCommandScope = "project" | "user" | "plugin" | "builtin";

/** An installed slash command surfaced in the New Task "Commands" tab and the
 *  inline `/` autocomplete. A skill (`.claude/skills/<name>/SKILL.md`), a command
 *  file (`.claude/commands/<name>.md`), an installed plugin command/skill, or a
 *  built-in — invokable from the prompt as `/<name>`. */
export interface SlashCommand {
  name: string;
  description: string;
  scope: SlashCommandScope;
  /** Front-matter `argument-hint` (e.g. "<ticket>"), shown dimmed after the name. */
  argumentHint?: string;
}

// Descriptions ride to the client only to label rows; cap them so a verbose
// skill front-matter blurb can't bloat the payload (the UI truncates anyway).
const MAX_DESC = 280;

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
): SlashCommand | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // unreadable file → skip, don't fail the whole listing
  }
  const { fm, body } = parseFrontmatter(text);
  const bare = (fm.name?.trim() || fallbackName).trim();
  if (!bare) return null;
  let description = (fm.description?.trim() || firstLine(body)).trim();
  if (description.length > MAX_DESC)
    description = description.slice(0, MAX_DESC - 1).trimEnd() + "…";
  const argumentHint = fm["argument-hint"]?.trim() || undefined;
  return { name: prefix + bare, description, scope, argumentHint };
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
    const cmd = readCommand(md, entry, scope, prefix);
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
export function listCommands(repoDir: string | null, userClaudeDir: string): SlashCommand[] {
  const out = new Map<string, SlashCommand>();
  for (const b of BUILTINS)
    out.set(b.name, { name: b.name, description: b.description, scope: "builtin" });
  collectPlugins(userClaudeDir, repoDir, out);
  collect(userClaudeDir, "user", out);
  if (repoDir) collect(join(repoDir, ".claude"), "project", out);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
