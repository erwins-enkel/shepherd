import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_SKILLS_DIR,
  AGENT_SKILL_NAMES,
  agentSkillsArgs,
  agentSkillsAvailable,
  agentSkillsMembranePaths,
  resetAgentSkillsCache,
} from "../src/agent-skills";
import { skillNameFrom } from "../src/commands";
import { parseEpicBody } from "../src/epic-parse";

const SKILLS_ROOT = join(AGENT_SKILLS_DIR, ".claude", "skills");
const read = (name: string) => readFileSync(join(SKILLS_ROOT, name, "SKILL.md"), "utf8");

describe("#2002 shipped agent skills", () => {
  it("lives where --add-dir looks for it", () => {
    // Claude Code loads `<added dir>/.claude/skills/` — a skill one level off is silently invisible.
    expect(readdirSync(SKILLS_ROOT).sort()).toEqual([...AGENT_SKILL_NAMES].sort());
  });

  it("declares the names the trim's subtraction set is keyed on", () => {
    // skillOverrides is keyed by the name Claude Code resolves (front-matter, entry fallback), so a
    // drifted front-matter name would let a same-named personal skill switch ours off.
    for (const name of AGENT_SKILL_NAMES) expect(skillNameFrom(read(name), name)).toBe(name);
  });

  it("gives every skill a description — that is what makes it discoverable", () => {
    for (const name of AGENT_SKILL_NAMES) {
      const description = /^description:\s*(.+)$/m.exec(read(name))?.[1] ?? "";
      expect(`${name}: ${description.length > 40}`).toBe(`${name}: true`);
    }
  });

  it("keeps the PR skill's epic example parseable by the real parser", () => {
    // The marker grammar also lives in EPIC_SHAPE_CONTRACT; this pins the copy that ships to other
    // repos against the parser, so drift fails here instead of producing an unrecognized "epic".
    const parsed = parseEpicBody(read("shepherd-pull-requests"));
    expect(parsed.members).toEqual([12, 13]);
    expect(parsed.edges).toEqual([{ dependent: 13, blocker: 12 }]);
  });
});

describe("shepherd-cli skill stays in step with the CLI reference", () => {
  // docs/cli.md is the maintained command reference; a command or flag the skill teaches that the
  // reference no longer documents is a renamed/removed one, and agents would run it blind.
  const reference = readFileSync(join(AGENT_SKILLS_DIR, "..", "docs", "cli.md"), "utf8");
  const skill = read("shepherd-cli");

  it("teaches only documented commands", () => {
    const commands = new Set(
      [...skill.matchAll(/`shepherd ([a-z][a-z-]*(?: (?:list|show))?)/g)].map((m) => m[1]!),
    );
    expect(commands.size).toBeGreaterThan(5);
    for (const command of commands) {
      expect(`${command}: ${reference.includes(`shepherd ${command}`)}`).toBe(`${command}: true`);
    }
  });

  it("teaches only documented flags", () => {
    // The `--repo` recipe's own `git rev-parse` flags are git's, and `--help` is clap's built-in.
    const cliText = skill.replace(/git rev-parse [^)]*/g, "").replaceAll("--help", "");
    const flags = new Set([...cliText.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((m) => m[0]));
    expect(flags.size).toBeGreaterThan(5);
    for (const flag of flags) {
      expect(`${flag}: ${reference.includes(flag)}`).toBe(`${flag}: true`);
    }
  });
});

describe("#2002 spawn wiring", () => {
  it("passes the directory (not the skills subdir) to --add-dir and binds the same path", () => {
    resetAgentSkillsCache();
    expect(agentSkillsAvailable()).toBe(true);
    expect(agentSkillsArgs()).toEqual(["--add-dir", AGENT_SKILLS_DIR]);
    expect(agentSkillsMembranePaths()).toEqual([AGENT_SKILLS_DIR]);
  });

  it("degrades to nothing when the install has no skills directory", () => {
    resetAgentSkillsCache();
    expect(agentSkillsAvailable(() => false)).toBe(false);
    expect(agentSkillsArgs()).toEqual([]);
    expect(agentSkillsMembranePaths()).toEqual([]);
    resetAgentSkillsCache();
  });
});
