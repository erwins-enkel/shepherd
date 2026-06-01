import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCommands } from "../src/commands";

let userClaude: string;
let repo: string;

function skill(claudeDir: string, name: string, body: string) {
  mkdirSync(join(claudeDir, "skills", name), { recursive: true });
  writeFileSync(join(claudeDir, "skills", name, "SKILL.md"), body);
}

function command(claudeDir: string, file: string, body: string) {
  mkdirSync(join(claudeDir, "commands"), { recursive: true });
  writeFileSync(join(claudeDir, "commands", file), body);
}

beforeEach(() => {
  userClaude = mkdtempSync(join(tmpdir(), "shepherd-cmds-user-"));
  repo = mkdtempSync(join(tmpdir(), "shepherd-cmds-repo-"));

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
});

/** Names contributed by skills/commands/plugins, with the always-present builtins
 *  filtered out — keeps the file-scan assertions stable as builtins evolve. */
function nonBuiltin(repoDir: string | null, claude: string) {
  return listCommands(repoDir, claude)
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
  const alpha = listCommands(repo, userClaude).find((c) => c.name === "alpha-skill");
  expect(alpha).toEqual({ name: "alpha-skill", description: "Alpha does things", scope: "user" });
});

test("skill name falls back to directory, description to first body line", () => {
  const noname = listCommands(repo, userClaude).find((c) => c.name === "noname");
  expect(noname).toEqual({ name: "noname", description: "No Front Matter", scope: "user" });
});

test("command description falls back to first body line", () => {
  const bar = listCommands(repo, userClaude).find((c) => c.name === "bar");
  expect(bar).toEqual({ name: "bar", description: "Do the bar thing", scope: "user" });
});

test("project shadows user on a name clash", () => {
  const foo = listCommands(repo, userClaude).find((c) => c.name === "foo");
  expect(foo).toEqual({ name: "foo", description: "project foo", scope: "project" });
});

test("merge-train is project-scoped", () => {
  const mt = listCommands(repo, userClaude).find((c) => c.name === "merge-train");
  expect(mt?.scope).toBe("project");
});

test("non-.md files in commands are ignored", () => {
  expect(listCommands(repo, userClaude).some((c) => c.name === "ignore")).toBe(false);
});

test("null repoDir → user scope only (no project commands)", () => {
  const names = nonBuiltin(null, userClaude);
  expect(names).toEqual(["alpha-skill", "bar", "foo", "noname"]);
  expect(names).not.toContain("merge-train");
});

test("missing dirs → builtins only, no throw", () => {
  const missing = join(userClaude, "does-not-exist");
  const cmds = listCommands(null, missing);
  expect(cmds.every((c) => c.scope === "builtin")).toBe(true);
  expect(cmds.length).toBeGreaterThan(0);
});

// ── builtins, argument-hint, plugins (the enrichment over #147) ────────────────

test("curated builtins are always present and scoped builtin", () => {
  const cmds = listCommands(repo, userClaude);
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
  const cmd = listCommands(null, userClaude).find((c) => c.name === "ticketed");
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
  const cmds = listCommands(null, userClaude);
  expect(cmds.find((c) => c.name === "myplugin:deploy")?.scope).toBe("plugin");
  expect(cmds.find((c) => c.name === "myplugin:scan")?.scope).toBe("plugin");
});

test("over-long description is truncated with an ellipsis", () => {
  const long = mkdtempSync(join(tmpdir(), "shepherd-cmds-long-"));
  try {
    command(long, "big.md", `---\ndescription: ${"x".repeat(400)}\n---\n`);
    const big = listCommands(null, long).find((c) => c.name === "big");
    expect(big!.description.length).toBeLessThanOrEqual(280);
    expect(big!.description.endsWith("…")).toBe(true);
  } finally {
    rmSync(long, { recursive: true, force: true });
  }
});
