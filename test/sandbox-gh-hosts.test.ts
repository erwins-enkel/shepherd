// Real-bwrap regression for the membrane's gh credential binds: once an agent gh token mode is
// configured the host `hosts.yml` (which may store the operator's token) must never be readable
// inside, and the per-spawn hosts file must land at `~/.config/gh/hosts.yml` whether or not the
// host has one — or a `~/.config/gh` at all. Without an agent mode the host dir stays bound.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMembraneFlags, type MembraneInputs } from "../src/sandbox";
import { resolveNodeBin } from "../src/node-bin";

const root = realpathSync(mkdtempSync(join(tmpdir(), "membrane-gh-")));
const work = join(root, "work");
mkdirSync(work);
for (const d of ["session-env", "projects"])
  mkdirSync(join(root, "claude", d), { recursive: true });
const perSpawn = join(root, "session.gh-hosts.yml");
writeFileSync(perSpawn, "github.com:\n    oauth_token: ghs_agent\n", { mode: 0o600 });

const AGENT_MODE = { SHEPHERD_AGENT_GH_APP_ID: "12345", SHEPHERD_AGENT_GH_APP_KEY_FILE: "/k.pem" };

/** A fresh host `$HOME` laid out by `files` (path under home → content). */
function homeWith(name: string, files: Record<string, string>): string {
  const home = join(root, name);
  mkdirSync(home);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    writeFileSync(join(home, rel), content);
  }
  return home;
}

function run(
  home: string,
  script: string,
  over: Partial<MembraneInputs> = {},
  env: Record<string, string> = {},
) {
  const inputs: MembraneInputs = {
    worktreePath: work,
    gitCommonDir: work,
    isolated: false,
    repoPath: work,
    claudeDir: join(root, "claude"),
    home,
    nodeBinReal: realpathSync(resolveNodeBin()),
    ...over,
  };
  const argv = buildMembraneFlags(inputs, { env });
  return spawnSync("bwrap", [...argv, "--", "/bin/sh", "-c", script], { encoding: "utf8" });
}

// Gate on the production membrane actually launching a shell here, like sandbox-git-store.
const membraneWorks =
  process.platform === "linux" &&
  spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0 &&
  run(homeWith("probe", {}), "true").status === 0;

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!membraneWorks)("membrane gh hosts binds (real bwrap)", () => {
  const operatorHosts = "github.com:\n    oauth_token: gho_operator\n    user: scoop\n";

  test("agent mode + host ~/.config/gh without hosts.yml -> per-spawn file, config kept", () => {
    const home = homeWith("no-hosts", { ".config/gh/config.yml": 'version: "1"\n' });
    const gh = `${home}/.config/gh`;
    const r = run(
      home,
      `cat ${gh}/hosts.yml ${gh}/config.yml`,
      { ghHostsFile: perSpawn },
      AGENT_MODE,
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe('github.com:\n    oauth_token: ghs_agent\nversion: "1"\n');
  });

  test("agent mode + no host ~/.config/gh at all -> per-spawn file", () => {
    const home = homeWith("no-gh-dir", {});
    const r = run(home, `cat ${home}/.config/gh/hosts.yml`, { ghHostsFile: perSpawn }, AGENT_MODE);
    expect(r.stdout).toBe("github.com:\n    oauth_token: ghs_agent\n");
  });

  test("agent mode: the host hosts.yml never shows, with or without a per-spawn file", () => {
    const home = homeWith("operator", {
      ".config/gh/hosts.yml": operatorHosts,
      ".config/gh/hosts.yml.bak": operatorHosts,
    });
    const gh = `${home}/.config/gh`;
    const withFile = run(home, `cat ${gh}/hosts.yml`, { ghHostsFile: perSpawn }, AGENT_MODE);
    expect(withFile.stdout).toBe("github.com:\n    oauth_token: ghs_agent\n");
    const without = run(home, `cat ${gh}/* 2>/dev/null; true`, {}, AGENT_MODE);
    expect(without.status).toBe(0);
    expect(without.stdout).not.toContain("gho_operator");
  });

  test("no agent mode -> unchanged: the host dir (and its hosts.yml) stays bound", () => {
    const home = homeWith("legacy", { ".config/gh/hosts.yml": operatorHosts });
    const r = run(home, `cat ${home}/.config/gh/hosts.yml`);
    expect(r.stdout).toBe(operatorHosts);
  });
});
