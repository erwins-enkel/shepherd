/**
 * Lifecycle / teardown tests for scripts/egress-runner.sh — the SIGKILL-robust
 * netns runner orchestrator (issue #551, Task 3).
 *
 * These exercise the REAL rootless-netns machinery (setpriv/unshare/slirp4netns/
 * nft/dnsmasq) and tear it down with SIGKILL, so they are GATED. The suite SKIPS
 * when (a) the host can't do rootless user+net namespaces / lacks the tools, (b)
 * running under CI (no real slirp teardown in any CI job), or (c) a rootless
 * docker daemon's socket is present — because on a host (e.g. `backontop`) whose
 * rootless docker serves the CI runners, churning the real slirp machinery can
 * take out that daemon's shared `slirp4netns` and knock all runners offline
 * (2026-06-12 incident; issue #591). The skip decision lives in
 * egress-runner-gate.ts and is unit-tested in egress-runner-gate.test.ts.
 *
 * When NOT skipped, it verifies:
 *   1. exit-code propagation (inner exits 42 ⇒ runner exits 42),
 *   2. clean-exit teardown (no slirp / netns-owner survive the inner exiting),
 *   3. SIGTERM teardown,
 *   4. SIGKILL teardown — the decisive proof that the pdeathsig leashes (NOT the
 *      EXIT trap, which can't fire on SIGKILL) reap the whole tree.
 *
 * Processes are identified by RECORDED PIDs (children of the spawned runner),
 * never by `pgrep -f <pattern>` — a pattern match would self-match the test/command
 * and falsely report survivors. Each test records the owner+slirp PIDs and always
 * force-kills them in a `finally`, even on assertion failure, to avoid leaking
 * netns trees across tests.
 */

import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildEgressConfig } from "../src/egress";
import { egressRunnerShouldSkip } from "./egress-runner-gate";

const SCRIPT = join(import.meta.dir, "..", "scripts", "egress-runner.sh");

// ── capability gate ────────────────────────────────────────────────────────────

/** True iff every required tool resolves on PATH AND rootless user+net ns works. */
function hostCapable(): boolean {
  const tools = ["setpriv", "unshare", "slirp4netns", "nft", "dnsmasq"];
  for (const t of tools) {
    const which = spawnSync("command", ["-v", t], { shell: true });
    if (which.status !== 0) return false;
  }
  // The decisive probe: can we actually create a rootless user+net namespace?
  const probe = spawnSync("unshare", ["--user", "--map-root-user", "--net", "true"]);
  return probe.status === 0;
}

const SKIP = egressRunnerShouldSkip({
  capable: hostCapable(),
  env: process.env,
  uid: typeof process.getuid === "function" ? process.getuid() : undefined,
  isSocket: (p) => {
    try {
      return statSync(p).isSocket();
    } catch {
      return false;
    }
  },
});

// ── helpers ─────────────────────────────────────────────────────────────────────

/** Write a minimal-but-valid egress.nft + dnsmasq.argv into a fresh tmp dir. */
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "egress-runner-"));
  const cfg = buildEgressConfig(["api.anthropic.com"], { tmpDir: dir });
  writeFileSync(join(dir, "egress.nft"), cfg.nftRuleset);
  writeFileSync(join(dir, "dnsmasq.argv"), cfg.dnsmasqArgv.join("\n"));
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killHard(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Children of `runner` matching `comm`, parsed from `ps`. */
function childByComm(runner: number, comm: string): number | undefined {
  const out = spawnSync("ps", ["-o", "pid=,comm=", "--ppid", String(runner)], {
    encoding: "utf8",
  });
  if (out.status !== 0) return undefined;
  for (const line of out.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m && m[2] === comm) return Number(m[1]);
  }
  return undefined;
}

/**
 * Poll until the runner has spawned BOTH its netns owner (`unshare`) and the
 * `slirp4netns` uplink as direct children, returning their recorded PIDs. slirp
 * only appears once the inner has waited for tap0, so allow generous time.
 */
async function captureChildren(runner: number): Promise<{ owner?: number; slirp?: number }> {
  for (let i = 0; i < 100; i++) {
    const owner = childByComm(runner, "unshare");
    const slirp = childByComm(runner, "slirp4netns");
    if (owner !== undefined && slirp !== undefined) return { owner, slirp };
    await sleep(100);
  }
  // Return whatever we have; the test assertions surface the shortfall.
  return {
    owner: childByComm(runner, "unshare"),
    slirp: childByComm(runner, "slirp4netns"),
  };
}

// ── teardown bookkeeping ─────────────────────────────────────────────────────────

let recorded: number[] = [];
let tmpDirs: string[] = [];

afterEach(() => {
  for (const pid of recorded) killHard(pid);
  recorded = [];
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

/** Spawn the runner with a given inner argv; returns the Bun subprocess. */
function spawnRunner(inner: string[]) {
  const dir = makeTmp();
  tmpDirs.push(dir);
  return Bun.spawn([SCRIPT, "--tmp", dir, "--", ...inner], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
}

// ── tests (gated) ─────────────────────────────────────────────────────────────────

test.skipIf(SKIP)("propagates the inner exit code (42)", async () => {
  const proc = spawnRunner(["bash", "-c", "echo READY; exit 42"]);
  recorded.push(proc.pid);
  const code = await proc.exited;
  expect(code).toBe(42);
});

test.skipIf(SKIP)("clean inner exit tears down slirp + netns owner", async () => {
  const proc = spawnRunner(["bash", "-c", "echo READY; sleep 1"]);
  recorded.push(proc.pid);
  const { owner, slirp } = await captureChildren(proc.pid);
  if (owner) recorded.push(owner);
  if (slirp) recorded.push(slirp);
  expect(owner).toBeDefined();
  expect(slirp).toBeDefined();

  await proc.exited;
  await sleep(500); // let pdeathsig/kernel reaping settle

  expect(alive(owner!)).toBe(false);
  expect(alive(slirp!)).toBe(false);
});

test.skipIf(SKIP)("SIGTERM on the runner tears down slirp + netns owner", async () => {
  const proc = spawnRunner(["bash", "-c", "echo READY; sleep 30"]);
  recorded.push(proc.pid);
  const { owner, slirp } = await captureChildren(proc.pid);
  if (owner) recorded.push(owner);
  if (slirp) recorded.push(slirp);
  expect(owner).toBeDefined();
  expect(slirp).toBeDefined();

  proc.kill("SIGTERM");
  await proc.exited;
  await sleep(800);

  expect(alive(owner!)).toBe(false);
  expect(alive(slirp!)).toBe(false);
});

test.skipIf(SKIP)(
  "SIGKILL on the runner STILL tears down slirp + netns owner (pdeathsig leash)",
  async () => {
    const proc = spawnRunner(["bash", "-c", "echo READY; sleep 30"]);
    recorded.push(proc.pid);
    const { owner, slirp } = await captureChildren(proc.pid);
    if (owner) recorded.push(owner);
    if (slirp) recorded.push(slirp);
    expect(owner).toBeDefined();
    expect(slirp).toBeDefined();

    // SIGKILL: no trap can fire — only the pdeathsig leashes can reap the tree.
    proc.kill("SIGKILL");
    await proc.exited;
    await sleep(1000);

    expect(alive(proc.pid)).toBe(false);
    expect(alive(owner!)).toBe(false);
    expect(alive(slirp!)).toBe(false);
  },
);

test.skipIf(SKIP)(
  "FAIL-CLOSED: malformed nft ruleset refuses to exec the agent (no firewall, no run)",
  async () => {
    // A fresh tmp dir with a DELIBERATELY malformed egress.nft. The runner's
    // inner block must reject this and exit nonzero BEFORE exec'ing the agent.
    const dir = mkdtempSync(join(tmpdir(), "egress-runner-failclosed-"));
    tmpDirs.push(dir);
    const cfg = buildEgressConfig(["api.anthropic.com"], { tmpDir: dir });
    writeFileSync(join(dir, "egress.nft"), "this is not valid nft\n");
    writeFileSync(join(dir, "dnsmasq.argv"), cfg.dnsmasqArgv.join("\n"));

    const sentinel = join(dir, "AGENT_RAN");
    const proc = Bun.spawn([SCRIPT, "--tmp", dir, "--", "bash", "-c", `touch ${sentinel}`], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    recorded.push(proc.pid);

    const code = await proc.exited;
    await sleep(300); // settle any async reaping

    // (a) runner exits NONZERO, (b) the agent NEVER ran (sentinel absent).
    expect(code).not.toBe(0);
    expect(existsSync(sentinel)).toBe(false);
  },
);
