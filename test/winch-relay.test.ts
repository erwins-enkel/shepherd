/**
 * scripts/winch-relay.sh must carry a terminal resize into a sandbox that bwrap `--new-session`
 * detached from the pane's controlling terminal.
 *
 * Regression: the sandboxed agent never received SIGWINCH, so it kept painting at its launch width —
 * an iPhone showed each word's first letter stuck at the right edge, and a rotation left the
 * terminal blank.
 *
 * Runs the REAL relay. `setsid` stands in for bwrap `--new-session`, so it needs no bwrap and no
 * namespaces, and the test signals the relay directly instead of resizing a PTY: the kernel only
 * ever delivers that SIGWINCH to the pane's foreground job, which the relay is.
 */
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "..", "scripts", "winch-relay.sh");
const linuxWithSetsid =
  process.platform === "linux" && spawnSync("setsid", ["--version"]).status === 0;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "winch-relay-"));
  dirs.push(dir);
  return dir;
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

/** The relay arms its trap just after forking the child; a SIGWINCH before that is ignored. */
function trapsWinch(pid: number): boolean {
  const caught = readFileSync(`/proc/${pid}/status`, "utf8").match(/^SigCgt:\s*([0-9a-f]+)$/m);
  return !!caught && (BigInt(`0x${caught[1]}`) & (1n << 27n)) !== 0n; // SIGWINCH = 28
}

test.skipIf(process.platform !== "linux")(
  "passes stdin through and exits with the child's status",
  () => {
    const r = spawnSync(SCRIPT, ["--", "sh", "-c", "cat; exit 7"], {
      input: "hello-from-pty\n",
      timeout: 10_000,
    });
    expect(r.stdout.toString()).toBe("hello-from-pty\n");
    expect(r.status).toBe(7);
  },
);

test.skipIf(!linuxWithSetsid)(
  "forwards SIGWINCH into a session a descendant started",
  async () => {
    const dir = scratch();
    const ready = join(dir, "ready");
    const marker = join(dir, "marker");
    // The trailing `exit` keeps sh from exec'ing setsid in place, so the session leader is a
    // grandchild the relay has to walk to — the shape of `bwrap … --new-session`.
    const inner = `trap 'echo winch >> ${marker}' WINCH; echo $$ > '${ready}'; while :; do sleep 0.05; done`;
    const relay = Bun.spawn([SCRIPT, "--", "sh", "-c", 'setsid sh -c "$0"; exit $?', inner], {
      stdout: "ignore",
      stderr: "ignore",
    });
    let leader = 0;
    try {
      await waitFor(() => existsSync(ready) && readFileSync(ready, "utf8").trim() !== "");
      leader = Number(readFileSync(ready, "utf8").trim());
      await waitFor(() => trapsWinch(relay.pid));
      process.kill(relay.pid, "SIGWINCH");
      await waitFor(() => existsSync(marker));
      expect(readFileSync(marker, "utf8")).toBe("winch\n");
    } finally {
      if (leader > 0) process.kill(-leader, "SIGKILL");
      relay.kill("SIGKILL");
      await relay.exited;
    }
  },
  15_000,
);

test.skipIf(process.platform !== "linux")(
  "never signals its own session, and a resize mid-run keeps the child's exit status",
  async () => {
    const dir = scratch();
    const ready = join(dir, "ready");
    const marker = join(dir, "marker");
    const child = `trap 'echo winch >> ${marker}' WINCH; echo up > '${ready}'; sleep 0.5; exit 3`;
    const relay = Bun.spawn([SCRIPT, "--", "sh", "-c", child], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor(() => existsSync(ready) && trapsWinch(relay.pid));
    process.kill(relay.pid, "SIGWINCH");
    expect(await relay.exited).toBe(3);
    expect(existsSync(marker)).toBe(false);
  },
  15_000,
);
