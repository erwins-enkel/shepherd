import { test, expect } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDarwinProbes, commBasename } from "../src/proc-probes-darwin";
import { AGENT_COMMS, scanListeningPortsByWorktree } from "../src/process-reaper";

// Assertions that are UNFALSIFIABLE on Linux and can only run on real macOS: they
// depend on how Apple's (old) `lsof` derives its `c` (command) field and how macOS
// resolves `$TMPDIR` symlinks (`/var/folders/…` → `/private/var/folders/…`). The
// suite self-gates on `process.platform === "darwin"`, so it no-ops on the Linux
// `verify` lane and actually runs on the `macos-latest` job.
const onDarwin = process.platform === "darwin" ? test : test.skip;

/** Spawn a child under `dir` that binds a listening TCP socket, using `execPath`
 *  as argv0 (so its lsof `c` field derives from that binary's name). */
function spawnListener(
  execPath: string,
  dir: string,
): Promise<{ child: ChildProcess; port: number }> {
  const script = `
    const net = require('net');
    process.chdir(${JSON.stringify(dir)});
    const srv = net.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + srv.address().port + '\\n'));
    setInterval(() => {}, 1 << 30);
  `;
  const child = spawn(execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/PORT (\d+)/);
      if (m) {
        child.stdout!.off("data", onData);
        resolve({ child, port: Number(m[1]) });
      }
    };
    child.stdout!.on("data", onData);
    child.once("error", reject);
  });
}

onDarwin(
  "darwin: a process named `claude` resolves into AGENT_COMMS via lsof's c field",
  async () => {
    // Copy the runtime into a temp file literally named `claude`, so lsof reports
    // `cclaude` for it. This proves the equivalence between lsof's command field and
    // the Linux /proc/<pid>/comm semantics AGENT_COMMS/isGitComm are written around —
    // which no captured fixture can establish (Apple ships an old lsof).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-claude-")));
    const fakeClaude = join(dir, "claude");
    copyFileSync(process.execPath, fakeClaude);
    spawnSync("chmod", ["+x", fakeClaude]);
    const { child, port } = await spawnListener(fakeClaude, dir);
    try {
      const probes = makeDarwinProbes();
      await probes.refresh();
      const found = probes.scanProcs().find((p) => p.pid === child.pid);
      expect(found).toBeDefined();
      const comm = commBasename(found!.comm);
      expect(comm).toBe("claude");
      // The load-bearing equivalence: the reaper's AGENT_COMMS gate would spare it.
      expect(AGENT_COMMS.has(comm)).toBe(true);
      // Sanity: the port is still joined (this is a real listening claude-named proc).
      expect(probes.portsForPid(child.pid!)).toContain(port);
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

onDarwin(
  "darwin: $TMPDIR path resolution — scan maps the stored root, not /private/…",
  async () => {
    // On macOS the OS tmp dir is under /var/folders (a symlink to /private/var/folders),
    // so lsof reports the child's cwd as /private/var/folders/… while a naively-stored
    // worktree root would be /var/folders/…. Without root normalisation every isUnder()
    // is false and the scan returns a fresh, successful, EMPTY map — the silent no-op.
    // Use the UN-realpath'd tmp path as the stored root to exercise the mismatch.
    const rawRoot = mkdtempSync(join(tmpdir(), "shepherd-tmpdir-"));
    const { child, port } = await spawnListener(process.execPath, rawRoot);
    try {
      const probes = makeDarwinProbes();
      await probes.refresh();
      // The stored root is the raw (pre-realpath) path; normalizeRoot must resolve it
      // so it matches lsof's kernel-resolved cwd.
      const byWorktree = scanListeningPortsByWorktree([rawRoot], probes);
      expect(byWorktree).not.toBeNull();
      expect(byWorktree!.get(rawRoot)).toContain(port);
    } finally {
      child.kill("SIGKILL");
      rmSync(rawRoot, { recursive: true, force: true });
    }
  },
);
