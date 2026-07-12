import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCommands } from "./commands";

const roots: string[] = [];

function tmpRoot(): string {
  const root = join(tmpdir(), `shepherd-commands-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function skill(root: string, rel: string, frontmatterName: string, description = "desc") {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${frontmatterName}\ndescription: ${description}\n---\nBody\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("listCommands Codex direct skills", () => {
  it("discovers direct repo Codex skills using frontmatter name as the invocation", () => {
    const root = tmpRoot();
    const repo = join(root, "repo");
    const claude = join(root, ".claude");
    const home = join(root, "home");
    const codexHome = join(root, ".codex");
    skill(repo, ".agents/skills/folder-name", "frontmatter-name", "Codex repo skill");

    const rows = listCommands(repo, claude, { userHome: home, codexHome });
    const row = rows.find((c) => c.id === "codex:repo:frontmatter-name");

    expect(row).toMatchObject({
      name: "frontmatter-name",
      displayName: "frontmatter-name",
      kind: "skill",
      invocationName: "frontmatter-name",
      sourceNamespace: "codex:repo",
      providers: ["codex"],
      invocations: { codex: "$frontmatter-name" },
      description: "Codex repo skill",
    });
  });

  it("honors Codex config disabled direct skills and leaves plugin caches undiscovered", () => {
    const root = tmpRoot();
    const repo = join(root, "repo");
    const claude = join(root, ".claude");
    const home = join(root, "home");
    const codexHome = join(root, ".codex");
    const disabledDir = join(home, ".agents/skills/disabled-skill");
    skill(home, ".agents/skills/enabled-skill", "enabled-skill");
    skill(home, ".agents/skills/disabled-skill", "disabled-skill");
    skill(
      codexHome,
      "plugins/cache/openai-curated-remote/github/0.1.0/skills/gh-fix-ci",
      "gh-fix-ci",
    );
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      `[[skills.config]]\npath = "${disabledDir.replaceAll("\\", "\\\\")}"\nenabled = false\n`,
    );

    const names = listCommands(repo, claude, { userHome: home, codexHome }).map((c) => c.name);

    expect(names).toContain("enabled-skill");
    expect(names).not.toContain("disabled-skill");
    expect(names).not.toContain("gh-fix-ci");
  });

  it("does not merge unrelated same-name Claude and Codex skills into Both", () => {
    const root = tmpRoot();
    const repo = join(root, "repo");
    const claude = join(root, ".claude");
    const home = join(root, "home");
    const codexHome = join(root, ".codex");
    skill(claude, "skills/shared", "shared", "Claude skill");
    skill(repo, ".agents/skills/shared", "shared", "Codex skill");

    const rows = listCommands(repo, claude, { userHome: home, codexHome }).filter(
      (c) => c.name === "shared",
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.providers).sort()).toEqual([["claude"], ["codex"]]);
  });
});
