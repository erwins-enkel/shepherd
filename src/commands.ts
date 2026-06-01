import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** An installed slash command surfaced in the New Task "Commands" tab. A skill
 *  (`.claude/skills/<name>/SKILL.md`) or a command file (`.claude/commands/<name>.md`),
 *  invokable from the prompt as `/<name>`. */
export interface SlashCommand {
  name: string;
  description: string;
  scope: "project" | "user";
}

// Descriptions ride to the client only to label rows; cap them so a verbose
// skill front-matter blurb can't bloat the payload (the UI truncates anyway).
const MAX_DESC = 280;

interface Frontmatter {
  name?: string;
  description?: string;
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
    const m = /^(name|description)\s*:\s*(.*)$/.exec(lines[i]!);
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
): SlashCommand | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // unreadable file → skip, don't fail the whole listing
  }
  const { fm, body } = parseFrontmatter(text);
  const name = (fm.name?.trim() || fallbackName).trim();
  if (!name) return null;
  let description = (fm.description?.trim() || firstLine(body)).trim();
  if (description.length > MAX_DESC)
    description = description.slice(0, MAX_DESC - 1).trimEnd() + "…";
  return { name, description, scope };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return []; // missing dir is the norm (not every repo/home has skills) → empty
  }
}

/** Scan one `.claude` dir for skills + commands, merging into `out` keyed by name. */
function collect(claudeDir: string, scope: SlashCommand["scope"], out: Map<string, SlashCommand>) {
  const skillsDir = join(claudeDir, "skills");
  for (const entry of safeReaddir(skillsDir)) {
    const md = join(skillsDir, entry, "SKILL.md");
    if (!existsSync(md)) continue;
    const cmd = readCommand(md, entry, scope);
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
    const cmd = readCommand(file, entry.slice(0, -3), scope);
    if (cmd) out.set(cmd.name, cmd);
  }
}

/** Discover installed slash commands for the New Task picker: user-scope skills +
 *  commands under `userClaudeDir`, then the repo's own `.claude` (project shadows
 *  user on a name clash). Sorted by name. `repoDir` null → user scope only. */
export function listCommands(repoDir: string | null, userClaudeDir: string): SlashCommand[] {
  const out = new Map<string, SlashCommand>();
  collect(userClaudeDir, "user", out);
  if (repoDir) collect(join(repoDir, ".claude"), "project", out);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
