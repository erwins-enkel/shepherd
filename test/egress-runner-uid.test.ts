/**
 * The egress-confined agent must run as the operator's real uid, not as root.
 *
 * Regression: egress-runner.sh execs the inner argv inside `unshare --map-root-user`, so without a
 * nested user namespace the membrane bwrap — and claude in it — ran as uid 0. claude refuses
 * `--dangerously-skip-permissions` as root and exited at launch, so every autonomous session died.
 *
 * Mirrors the live spawn as closely as this host allows: the REAL runner with REAL setpriv/unshare
 * (real user+net+pid namespaces) and REAL bwrap given the production membrane + egress override
 * flags, under a PTY like a herdr pane. Only the slirp/firewall tools are shimmed, so no real slirp
 * is started (safe beside rootless docker, unlike egress-runner.test.ts). Skips when the host
 * cannot create user namespaces or lacks bwrap/script.
 */
import { test, expect, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { egressMembraneOverrideFlags } from "../src/egress";
import { posixShellJoin } from "../src/argv-limit";
import { resolveNodeBin } from "../src/node-bin";
import { buildMembraneFlags, safeRealpath } from "../src/sandbox";

const SCRIPT = join(import.meta.dir, "..", "scripts", "egress-runner.sh");

const SHIMS: Record<string, string> = {
  slirp4netns: "exec sleep 30",
  nft: "exit 0",
  dnsmasq: "exec sleep 30",
  ip: "exit 0",
  sysctl: "exit 0",
};

function hostCapable(): boolean {
  for (const t of ["setpriv", "unshare", "bwrap", "script"]) {
    if (spawnSync("sh", ["-c", `command -v ${t}`]).status !== 0) return false;
  }
  return (
    spawnSync("unshare", ["--user", "--map-root-user", "--net", "--pid", "--fork", "true"])
      .status === 0
  );
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

test.skipIf(!hostCapable())("inner agent runs as the host uid, not root", () => {
  const root = mkdtempSync(join(tmpdir(), "egress-uid-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const tmp = join(root, "tmp");
  const work = join(root, "work");
  const home = join(root, "home");
  // The membrane mounts tmpfs over these inside the RO claude dir, so they must already exist.
  const claudeSubdirs = ["projects", "shell-snapshots", "todos", "statsig", "session-env"];
  for (const d of [bin, tmp, work, ...claudeSubdirs.map((s) => join(home, ".claude", s))]) {
    mkdirSync(d, { recursive: true });
  }
  for (const [name, body] of Object.entries(SHIMS)) {
    const p = join(bin, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p, 0o755);
  }
  writeFileSync(join(tmp, "egress.nft"), "");
  writeFileSync(join(tmp, "dnsmasq.argv"), "-d\n");
  writeFileSync(join(tmp, "resolv.conf"), "nameserver 127.0.0.1\n");
  writeFileSync(join(tmp, "nsswitch.conf"), "hosts: files dns\n");

  const membrane = buildMembraneFlags({
    worktreePath: work,
    gitCommonDir: work,
    isolated: false,
    repoPath: work,
    claudeDir: join(home, ".claude"),
    home,
    nodeBinReal: safeRealpath(resolveNodeBin()),
  });
  const runner = [
    SCRIPT,
    "--tmp",
    tmp,
    "--",
    "bwrap",
    ...membrane,
    ...egressMembraneOverrideFlags(tmp),
    "--",
    "/bin/sh",
    "-c",
    "echo uid=$(id -u)",
  ];
  // `script` gives the runner a PTY, as the herdr pane does.
  const r = spawnSync("script", ["-qfec", posixShellJoin(runner), "/dev/null"], {
    env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(r.stdout).toContain(`uid=${process.getuid?.()}`);
  expect(r.status).toBe(0);
});
