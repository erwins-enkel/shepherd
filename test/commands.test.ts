import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCommands } from "../src/commands";

let userClaude: string;
let repo: string;
let userHome: string;
let codexHome: string;

function skill(claudeDir: string, name: string, body: string) {
  mkdirSync(join(claudeDir, "skills", name), { recursive: true });
  writeFileSync(join(claudeDir, "skills", name, "SKILL.md"), body);
}

function command(claudeDir: string, file: string, body: string) {
  mkdirSync(join(claudeDir, "commands"), { recursive: true });
  writeFileSync(join(claudeDir, "commands", file), body);
}

function codexSkill(skillsDir: string, dir: string, name: string, description: string) {
  mkdirSync(join(skillsDir, dir), { recursive: true });
  writeFileSync(
    join(skillsDir, dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
  );
}

beforeEach(() => {
  userClaude = mkdtempSync(join(tmpdir(), "shepherd-cmds-user-"));
  repo = mkdtempSync(join(tmpdir(), "shepherd-cmds-repo-"));
  userHome = mkdtempSync(join(tmpdir(), "shepherd-cmds-home-"));
  codexHome = mkdtempSync(join(tmpdir(), "shepherd-cmds-codex-"));

  // user-scope skills
  skill(userClaude, "alpha", "---\nname: alpha-skill\ndescription: Alpha does things\n---\nbody");
  skill(userClaude, "noname", "# No Front Matter\n\nfirst real line"); // no frontmatter → fallbacks
  // user-scope commands
  command(userClaude, "foo.md", "---\ndescription: user foo\n---\nprompt");
  command(userClaude, "bar.md", "Do the bar thing\nmore");
  command(userClaude, "ignore.txt", "not a markdown command");

  // project-scope: a skill + a command whose name collides with user "foo"
  skill(
    join(repo, ".claude"),
    "merge-train",
    "---\nname: merge-train\ndescription: run the train\n---",
  );
  command(join(repo, ".claude"), "foo.md", "---\ndescription: project foo\n---\nprompt");
});

afterEach(() => {
  rmSync(userClaude, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(userHome, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
});

function commands(repoDir: string | null, claude: string) {
  return listCommands(repoDir, claude, { userHome, codexHome });
}

/** Names contributed by skills/commands/plugins, with the always-present builtins
 *  filtered out — keeps the file-scan assertions stable as builtins evolve. */
function nonBuiltin(repoDir: string | null, claude: string) {
  return commands(repoDir, claude)
    .filter((c) => c.scope !== "builtin")
    .map((c) => c.name);
}

test("merges user + project commands, sorted by name", () => {
  expect(nonBuiltin(repo, userClaude)).toEqual([
    "alpha-skill",
    "bar",
    "foo",
    "merge-train",
    "noname",
  ]);
});

test("skill name comes from front-matter, scope is user", () => {
  const alpha = commands(repo, userClaude).find((c) => c.name === "alpha-skill");
  expect(alpha).toMatchObject({
    name: "alpha-skill",
    description: "Alpha does things",
    scope: "user",
  });
});

test("skill name falls back to directory, description to first body line", () => {
  const noname = commands(repo, userClaude).find((c) => c.name === "noname");
  expect(noname).toMatchObject({
    name: "noname",
    description: "No Front Matter",
    scope: "user",
  });
});

test("command description falls back to first body line", () => {
  const bar = commands(repo, userClaude).find((c) => c.name === "bar");
  expect(bar).toMatchObject({ name: "bar", description: "Do the bar thing", scope: "user" });
});

test("project shadows user on a name clash", () => {
  const foo = commands(repo, userClaude).find((c) => c.name === "foo");
  expect(foo).toMatchObject({ name: "foo", description: "project foo", scope: "project" });
});

test("merge-train is project-scoped", () => {
  const mt = commands(repo, userClaude).find((c) => c.name === "merge-train");
  expect(mt?.scope).toBe("project");
});

test("non-.md files in commands are ignored", () => {
  expect(commands(repo, userClaude).some((c) => c.name === "ignore")).toBe(false);
});

test("null repoDir → user scope only (no project commands)", () => {
  const names = nonBuiltin(null, userClaude);
  expect(names).toEqual(["alpha-skill", "bar", "foo", "noname"]);
  expect(names).not.toContain("merge-train");
});

test("missing dirs → builtins only, no throw", () => {
  const missing = join(userClaude, "does-not-exist");
  const cmds = commands(null, missing);
  expect(cmds.every((c) => c.scope === "builtin")).toBe(true);
  expect(cmds.length).toBeGreaterThan(0);
});

// ── builtins, argument-hint, plugins (the enrichment over #147) ────────────────

test("curated builtins are always present and scoped builtin", () => {
  const cmds = commands(repo, userClaude);
  const review = cmds.find((c) => c.name === "review");
  expect(review?.scope).toBe("builtin");
  expect(cmds.some((c) => c.name === "security-review" && c.scope === "builtin")).toBe(true);
});

test("front-matter argument-hint is surfaced", () => {
  command(
    userClaude,
    "ticketed.md",
    "---\ndescription: needs a ticket\nargument-hint: <ticket>\n---\n",
  );
  const cmd = commands(null, userClaude).find((c) => c.name === "ticketed");
  expect(cmd?.argumentHint).toBe("<ticket>");
});

test("installed plugins are scanned, namespaced, and re-rooted from a foreign installPath", () => {
  // plugin cache laid out under the user's .claude, but installPath carries a
  // DIFFERENT machine's $HOME (settings sync) — must still resolve locally.
  const rel = "plugins/cache/mkt/myplugin/1.0.0";
  command(join(userClaude, rel), "deploy.md", "---\ndescription: plugin deploy\n---\n");
  skill(join(userClaude, rel), "scan", "---\nname: scan\ndescription: plugin scan\n---\n");
  mkdirSync(join(userClaude, "plugins"), { recursive: true });
  writeFileSync(
    join(userClaude, "plugins", "installed_plugins.json"),
    JSON.stringify({
      plugins: {
        "myplugin@mkt": [{ scope: "user", installPath: `/Users/someone/.claude/${rel}` }],
      },
    }),
  );
  const cmds = commands(null, userClaude);
  expect(cmds.find((c) => c.name === "myplugin:deploy")?.scope).toBe("plugin");
  expect(cmds.find((c) => c.name === "myplugin:scan")?.scope).toBe("plugin");
});

test("provider option scans only Codex skill roots", () => {
  codexSkill(join(userHome, ".agents", "skills"), "shared", "shared", "home shared");
  codexSkill(join(repo, ".agents", "skills"), "repo", "repo-only", "repo skill");

  const cmds = listCommands(repo, userClaude, { userHome, codexHome, provider: "codex" });

  expect(cmds.map((c) => c.name)).toEqual(["repo-only", "shared"]);
  expect(cmds.every((c) => c.providers.includes("codex"))).toBe(true);
  expect(cmds.find((c) => c.name === "repo-only")).toMatchObject({
    scope: "project",
    kind: "skill",
    invocations: { codex: "$repo-only" },
  });
});

test("Codex installed plugin cache exposes browsing inventory and namespaced skills", () => {
  const pluginRoot = join(codexHome, "plugins", "cache", "mkt", "github");
  const versionRoot = join(pluginRoot, "1.0.0");
  mkdirSync(join(versionRoot, ".codex-plugin"), { recursive: true });
  writeFileSync(join(pluginRoot, ".codex-remote-plugin-install.json"), '{"schema_version":1}');
  writeFileSync(
    join(versionRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "github",
      description: "GitHub plugin",
      skills: "./skills/",
      interface: { shortDescription: "GitHub workflows" },
    }),
  );
  codexSkill(join(versionRoot, "skills"), "yeet", "yeet", "Publish changes");

  const cmds = listCommands(null, userClaude, { userHome, codexHome, provider: "codex" });

  expect(cmds.find((c) => c.name === "github")).toMatchObject({
    description: "GitHub workflows",
    scope: "plugin",
    kind: "plugin",
    providers: ["codex"],
    invocations: {},
  });
  expect(cmds.find((c) => c.name === "github:yeet")).toMatchObject({
    description: "Publish changes",
    scope: "plugin",
    kind: "skill",
    invocations: { codex: "$github:yeet" },
  });
});

test("over-long description is truncated with an ellipsis", () => {
  const long = mkdtempSync(join(tmpdir(), "shepherd-cmds-long-"));
  try {
    command(long, "big.md", `---\ndescription: ${"x".repeat(400)}\n---\n`);
    const big = commands(null, long).find((c) => c.name === "big");
    expect(big!.description.length).toBeLessThanOrEqual(280);
    expect(big!.description.endsWith("…")).toBe(true);
  } finally {
    rmSync(long, { recursive: true, force: true });
  }
});
