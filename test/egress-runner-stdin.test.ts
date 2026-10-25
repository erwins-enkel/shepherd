/**
 * scripts/egress-runner.sh must hand its stdin (the herdr PTY) to the inner agent.
 *
 * Regression: the runner launches the netns owner as a background job, and a non-interactive
 * bash points a background job's stdin at /dev/null. bwrap `--new-session` then also denies the
 * /dev/tty fallback, so claude exited at launch ("stdin is not a terminal") and every
 * autonomous session died within a second.
 *
 * Runs the REAL runner, but with the namespace/firewall tools shimmed on PATH (setpriv/unshare
 * just exec their payload, slirp4netns sleeps), so it needs no namespaces and never touches a
 * real slirp — safe on CI and on a rootless-docker host (see egress-runner-gate.ts).
 */
import { test, expect, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "..", "scripts", "egress-runner.sh");

const SHIMS: Record<string, string> = {
  // `setpriv --pdeathsig SIGKILL <cmd...>` → exec <cmd...>
  setpriv: 'shift 2; exec "$@"',
  // `unshare --flag ... <cmd...>` → drop the leading flags, exec the rest
  unshare: 'while [ "${1#--}" != "$1" ]; do shift; done; exec "$@"',
  slirp4netns: "exec sleep 30",
  nft: "exit 0",
  dnsmasq: "exec sleep 30",
  ip: "exit 0",
  sysctl: "exit 0",
};

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function setup(): { bin: string; tmp: string } {
  const root = mkdtempSync(join(tmpdir(), "egress-stdin-"));
  dirs.push(root);
  const bin = join(root, "bin");
  const tmp = join(root, "tmp");
  spawnSync("mkdir", ["-p", bin, tmp]);
  for (const [name, body] of Object.entries(SHIMS)) {
    const p = join(bin, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(p, 0o755);
  }
  writeFileSync(join(tmp, "egress.nft"), "");
  writeFileSync(join(tmp, "dnsmasq.argv"), "-d\n");
  return { bin, tmp };
}

test("inner agent reads the runner's stdin (not /dev/null)", () => {
  const { bin, tmp } = setup();
  const r = spawnSync(SCRIPT, ["--tmp", tmp, "--", "cat"], {
    input: "hello-from-pty\n",
    env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    timeout: 20_000,
  });
  expect(r.stdout.toString()).toBe("hello-from-pty\n");
  expect(r.status).toBe(0);
});
