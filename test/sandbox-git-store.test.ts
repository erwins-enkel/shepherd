// Real-bwrap regression for the membrane's git-store carve-outs (audit run-2 R2-F01/R2-F06):
// nothing an in-membrane agent writes into the shared store's config/hooks/shepherd/modules (or
// the config.worktree / info/attributes / legacy remotes git reads) may survive for host git to
// execute — whether or not those paths existed at spawn, or optional extensions are enabled.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMembraneFlags, type MembraneInputs } from "../src/sandbox";
import { resolveNodeBin } from "../src/node-bin";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "membrane-git-")));
const repo = join(root, "repo");
const wt = join(root, "wt");
const other = join(root, "other");
const common = join(repo, ".git");
// The RO claude dir needs the mount points the membrane tmpfs/binds over.
for (const d of ["session-env", "projects", "probe"])
  mkdirSync(join(root, "claude", d), { recursive: true });

function run(script: string, over: Partial<MembraneInputs> = {}) {
  const inputs: MembraneInputs = {
    worktreePath: wt,
    gitCommonDir: common,
    isolated: true,
    repoPath: repo,
    claudeDir: join(root, "claude"),
    home: join(root, "home"),
    nodeBinReal: realpathSync(resolveNodeBin()),
    ...over,
  };
  const argv = [...buildMembraneFlags(inputs), "--chdir", inputs.worktreePath];
  return spawnSync("bwrap", [...argv, "--", "/bin/sh", "-c", script], { encoding: "utf8" });
}

// Gate on the production membrane actually launching a shell here (like detectBackend's
// self-test), not on bare bwrap: some host layouts can't exec inside it at all, and every
// "write must fail" assertion would then pass vacuously.
const probeDir = join(root, "claude", "probe");
const membraneWorks =
  process.platform === "linux" &&
  spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0 &&
  run("true", { isolated: false, repoPath: probeDir, worktreePath: probeDir }).status === 0;

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!membraneWorks)("membrane git store (real bwrap)", () => {
  beforeAll(() => {
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "worktree", "add", "-q", "-b", "wt", wt);
    git(repo, "worktree", "add", "-q", "-b", "other", other);
    rmSync(join(common, "hooks"), { recursive: true, force: true });
    // Host git honors worktrees/<id>/config.worktree only with this extension: pre-set it.
    git(repo, "config", "extensions.worktreeConfig", "true");
  });

  test("store config, commondir, hooks/, shepherd/, modules/, worktrees/ are not writable", () => {
    for (const p of ["hooks", "shepherd", "modules", "config.worktree", "commondir"]) {
      expect(existsSync(join(common, p))).toBe(false);
    }
    const before = readFileSync(join(common, "config"), "utf8");
    const attempts = [
      "git config core.fsmonitor /bin/true",
      `printf x > '${common}/config'`,
      `touch '${common}/hooks/pre-commit'`,
      `mkdir -p '${common}/shepherd/x'`,
      `mkdir -p '${common}/modules/x'`,
      `printf '[core]\\n' > '${common}/config.worktree'`,
      `printf '%s' '${wt}' > '${common}/commondir'`,
      `printf '%s' '${wt}' > '${common}/worktrees/other/commondir'`,
      `printf '%s' '${wt}' > '${common}/worktrees/wt/commondir'`,
      `mkdir '${common}/worktrees/planted'`,
    ];
    // Positive control: the membrane runs and the worktree itself is writable.
    expect(run(`touch '${wt}/ok'`).status).toBe(0);
    for (const a of attempts) expect(run(a).status).not.toBe(0);
    expect(readFileSync(join(common, "config"), "utf8")).toBe(before);
    for (const p of ["hooks", "shepherd", "modules"]) {
      const dir = join(common, p);
      expect(spawnSync("ls", ["-A", dir], { encoding: "utf8" }).stdout).toBe("");
    }
    expect(readFileSync(join(common, "config.worktree"), "utf8")).toBe("");
    // Pinned on the host to the store itself — a no-op for host git.
    expect(readFileSync(join(common, "commondir"), "utf8")).toBe(".\n");
    expect(readFileSync(join(common, "worktrees", "other", "commondir"), "utf8")).toBe("../..\n");
    expect(spawnSync("git", ["status"], { cwd: repo }).status).toBe(0);
  });

  test("with extensions.worktreeConfig: own config.worktree, info/, remotes/, branches/ are not writable", () => {
    const own = join(common, "worktrees", "wt", "config.worktree");
    const exclude = readFileSync(join(common, "info", "exclude"), "utf8");
    expect(existsSync(join(common, "info", "attributes"))).toBe(false);
    const attempts = [
      "git config --worktree core.fsmonitor /bin/true",
      `printf '[core]\\n' > '${own}'`,
      `printf '* filter=x\\n' > '${common}/info/attributes'`,
      `printf x >> '${common}/info/exclude'`,
      `mkdir '${common}/remotes/x'`,
      `touch '${common}/branches/x'`,
    ];
    expect(run(`touch '${wt}/ok2'`).status).toBe(0);
    for (const a of attempts) expect(run(a).status).not.toBe(0);
    expect(readFileSync(own, "utf8")).toBe("");
    expect(existsSync(join(common, "info", "attributes"))).toBe(false);
    expect(readFileSync(join(common, "info", "exclude"), "utf8")).toBe(exclude);
    for (const p of ["remotes", "branches"]) {
      expect(spawnSync("ls", ["-A", join(common, p)], { encoding: "utf8" }).stdout).toBe("");
    }
    const st = spawnSync("git", ["config", "--worktree", "--get", "core.fsmonitor"], { cwd: wt });
    expect(st.status).not.toBe(0);
    expect(spawnSync("git", ["status"], { cwd: wt }).status).toBe(0);
  });

  test("with extensions.worktreeConfig: git works in a fresh worktree (no config.worktree yet)", () => {
    const fresh = join(root, "fresh");
    git(repo, "worktree", "add", "-q", "-b", "fresh", fresh);
    const own = join(common, "worktrees", "fresh", "config.worktree");
    // `worktree add` may copy one in under the extension; a pre-existing worktree has none.
    rmSync(own, { force: true });
    const r = run(
      "git status --short && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x",
      { worktreePath: fresh },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    // Created empty on the host before the spawn, then bound RO.
    expect(readFileSync(own, "utf8")).toBe("");
  });

  test("non-isolated: .git can't be renamed away or its config replaced", () => {
    const opts = { isolated: false, worktreePath: repo };
    expect(run(`touch '${repo}/ok'`, opts).status).toBe(0);
    expect(run(`mv '${common}' '${repo}/moved'`, opts).status).not.toBe(0);
    expect(run(`git config core.fsmonitor /bin/true`, opts).status).not.toBe(0);
    expect(existsSync(join(repo, "moved"))).toBe(false);
  });

  test("ordinary git work in the worktree still succeeds", () => {
    const r = run(
      "git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x && git checkout -q -b feat",
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  test("reviewer membrane launches over a store missing the carve-out paths", () => {
    const bare = join(root, "bare.git");
    git(root, "init", "-q", "--bare", bare);
    rmSync(join(bare, "hooks"), { recursive: true, force: true });
    expect(run("true", { gitCommonDir: bare, reviewer: true }).status).toBe(0);
  });
});
