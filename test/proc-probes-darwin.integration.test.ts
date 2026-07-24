import { test, expect } from "bun:test";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDarwinProbes } from "../src/proc-probes-darwin";
import { scanListeningPortsByWorktree } from "../src/process-reaper";

// This test constructs the darwin backend EXPLICITLY and drives it against REAL
// `lsof`, so it exercises the parser + cell + cwd↔port JOIN on the existing Linux
// CI runner too — the `-F` output format is shared with macOS. It asserts the JOIN
// (one process contributing both an fcwd record and a listening socket in one
// invocation), which is the actual residual risk across lsof vintages, not mere
// parseability.

const hasLsof = spawnSync("lsof", ["-v"], { stdio: "ignore" }).status !== null;
const maybe = hasLsof ? test : test.skip;

/** Spawn a child that chdirs into `dir` and binds a listening TCP socket on an
 *  ephemeral loopback port, printing `PORT <n>`. Resolves once the port is known. */
function spawnListener(dir: string): Promise<{ child: ChildProcess; port: number }> {
  const script = `
    const net = require('net');
    process.chdir(${JSON.stringify(dir)});
    const srv = net.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => {
      process.stdout.write('PORT ' + srv.address().port + '\\n');
    });
    setInterval(() => {}, 1 << 30);
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
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

maybe("darwin backend over real lsof: joins a child's cwd and its listening port", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-lsof-")));
  const { child, port } = await spawnListener(root);
  try {
    const probes = makeDarwinProbes(); // real lsof runner
    await probes.refresh();

    // The JOIN: the child appears in scanProcs with its cwd, AND portsForPid holds
    // the listening port it bound — both from the single lsof invocation.
    const procs = probes.scanProcs();
    const found = procs.find((p) => p.pid === child.pid);
    expect(found).toBeDefined();
    expect(found!.cwd).toBe(root);
    expect(probes.portsForPid(child.pid!)).toContain(port);

    // And the batched worktree mapping resolves the same port for the root — the
    // path the preview sweep actually takes.
    const byWorktree = scanListeningPortsByWorktree([root], probes);
    expect(byWorktree).not.toBeNull();
    expect(byWorktree!.get(root)).toContain(port);
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
