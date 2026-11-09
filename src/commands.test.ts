import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCommands, readCodexExtensions } from "./commands";

const roots: string[] = [];

function tmpRoot(): string {
  // mkdtempSync both creates the dir 0700 and picks the unpredictable suffix itself — the
  // sanctioned primitive, and one call instead of hand-rolling a name then creating it.
  const root = mkdtempSync(join(tmpdir(), "shepherd-commands-"));
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

/** A cached Codex plugin install: `<cache>/<marketplace>/<plugin>/<version>/.codex-plugin/plugin.json`. */
function codexPlugin(codexHome: string, marketplace: string, plugin: string, remote: boolean) {
  const pluginRoot = join(codexHome, "plugins/cache", marketplace, plugin);
  mkdirSync(join(pluginRoot, "0.1.0", ".codex-plugin"), { recursive: true });
  writeFileSync(join(pluginRoot, "0.1.0", ".codex-plugin", "plugin.json"), `{"name":"${plugin}"}`);
  if (remote) writeFileSync(join(pluginRoot, ".codex-remote-plugin-install.json"), "{}");
}

describe("readCodexExtensions (#3780)", () => {
  it("lists remote and local-marketplace plugins whose effective state is on", () => {
    const root = tmpRoot();
    const codexHome = join(root, ".codex");
    codexPlugin(codexHome, "openai-curated-remote", "canva", true);
    codexPlugin(codexHome, "localmkt", "demo", false);
    codexPlugin(codexHome, "localmkt", "off", false);
    codexPlugin(codexHome, "localmkt", "implicit", false);
    // A cache entry without a version holding .codex-plugin/plugin.json is not an install.
    mkdirSync(join(codexHome, "plugins/cache/localmkt/half/0.1.0"), { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        `[plugins._default]`,
        `enabled = false`,
        `[plugins."demo@localmkt"]`,
        `enabled = true`,
        `[plugins."off@localmkt"]`,
        `enabled = false`,
        `[plugins."canva@openai-curated-remote"]`,
        `enabled = true`,
      ].join("\n"),
    );

    const { plugins } = readCodexExtensions({ codexHome, userHome: join(root, "home") });

    expect(plugins.sort()).toEqual(["canva@openai-curated-remote", "demo@localmkt"]);
  });

  it("an installed plugin without any config entry is on", () => {
    const root = tmpRoot();
    const codexHome = join(root, ".codex");
    codexPlugin(codexHome, "openai-curated-remote", "github", true);

    const { plugins } = readCodexExtensions({ codexHome, userHome: join(root, "home") });

    expect(plugins).toEqual(["github@openai-curated-remote"]);
  });

  it("lists personal skills by front-matter name, minus config-disabled and nameless ones", () => {
    const root = tmpRoot();
    const home = join(root, "home");
    const codexHome = join(root, ".codex");
    skill(home, ".agents/skills/tdd-dir", "tdd");
    skill(home, ".agents/skills/disabled", "disabled");
    const nameless = join(home, ".agents/skills/nameless");
    mkdirSync(nameless, { recursive: true });
    writeFileSync(join(nameless, "SKILL.md"), "---\ndescription: no name\n---\nBody\n");
    // Bundled system skills are not personal.
    skill(codexHome, "skills/.system/imagegen", "imagegen");
    const disabledMd = join(home, ".agents/skills/disabled/SKILL.md");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      `[[skills.config]]\npath = "${disabledMd.replaceAll("\\", "\\\\")}"\nenabled = false\n`,
    );

    const { skills } = readCodexExtensions({ codexHome, userHome: home });

    expect(skills).toEqual([{ name: "tdd", path: join(home, ".agents/skills/tdd-dir/SKILL.md") }]);
  });

  it("missing Codex home and skills root yield nothing", () => {
    const root = tmpRoot();
    expect(readCodexExtensions({ codexHome: join(root, "none"), userHome: root })).toEqual({
      plugins: [],
      skills: [],
    });
  });
});
