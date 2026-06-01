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

test("merges user + project commands, sorted by name", () => {
  const names = listCommands(repo, userClaude).map((c) => c.name);
  expect(names).toEqual(["alpha-skill", "bar", "foo", "merge-train", "noname"]);
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
  const names = listCommands(null, userClaude).map((c) => c.name);
  expect(names).toEqual(["alpha-skill", "bar", "foo", "noname"]);
  expect(names).not.toContain("merge-train");
});

test("missing dirs → empty, no throw", () => {
  const missing = join(userClaude, "does-not-exist");
  expect(listCommands(null, missing)).toEqual([]);
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
