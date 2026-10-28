import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { scanMarkersDarwin, type DarwinMarkerScan } from "../src/proc-markers-darwin";
import { sampleMemoryDarwin } from "../src/heavy-slot-darwin";
import { HeavySlotService, type HeavySlotDeps } from "../src/heavy-slot";
import { defaultHeavySlotBudget } from "../src/heavy-slot-core";
import { SessionStore } from "../src/store";
import type { Session } from "../src/types";

const onDarwin = process.platform === "darwin" ? test : test.skip;

onDarwin("Darwin native memory probes return pressure and available memory", async () => {
  const sample = await sampleMemoryDarwin();
  expect(["normal", "warning", "critical"]).toContain(sample.darwinPressure ?? "unknown");
  expect(sample.availableBytes).not.toBeNull();
  expect(sample.availableBytes!).toBeGreaterThanOrEqual(0);
  expect(sample.psiFullAvg10).toBeNull();
});

onDarwin(
  "Darwin native detached child holds a slot through parent exit and service restart",
  async () => {
    const id = `darwin-test-${crypto.randomUUID()}`;
    // The child confirms readiness before its parent exits. Independent session/stdio
    // ensure the original process group is gone while the marked child still runs.
    const script = `
    const { spawn } = require('node:child_process');
    const c = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
      detached: true, stdio: ['ignore', 'pipe', 'ignore']
    });
    console.log(c.pid);
    c.stdout.once('data', () => { c.stdout.destroy(); c.unref(); });
  `;
    const parent = spawn(process.execPath, ["-e", script], {
      detached: true,
      env: { ...process.env, SHEPHERD_HEAVY_JOB: id },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let childPid: number | undefined;
    let svc: HeavySlotService | undefined;
    const store = new SessionStore(":memory:");
    try {
      const output: Buffer[] = [];
      parent.stdout!.on("data", (chunk) => {
        output.push(chunk);
        const text = Buffer.concat(output).toString();
        if (/^\d+\n$/.test(text)) childPid = Number(text.trim());
      });
      await Promise.race([
        once(parent, "close"),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("parent readiness timeout")), 5000);
          timer.unref();
        }),
      ]);
      childPid = Number(Buffer.concat(output).toString().trim());
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      const first = await scanMarkersDarwin(new Set([id]));
      expect(first.procs.get(id)?.count).toBe(1);
      let lastScan: DarwinMarkerScan = first;
      const steers: string[] = [];
      let nextId = 0;
      const deps: HeavySlotDeps = {
        enabled: true,
        platform: "darwin",
        budget: defaultHeavySlotBudget({ cpus: 8, memTotalBytes: 16 * 1024 ** 3 }),
        newId: () => (nextId++ === 0 ? id : `${id}-queued`),
        store: {
          get: (sid) =>
            ({ id: sid, status: "running", repoPath: "/repo", worktreePath: "/wt" }) as Session,
          listHeavySlotJobs: (states) => store.listHeavySlotJobs(states),
          upsertHeavySlotJob: (job) => store.upsertHeavySlotJob(job),
          heavySlotDurations: (count) => store.heavySlotDurations(count),
          pruneHeavySlotJobs: (before) => store.pruneHeavySlotJobs(before),
        },
        scanMarkersDarwin: async (ids) => {
          lastScan = await scanMarkersDarwin(ids);
          return lastScan;
        },
        events: { emit: () => {} },
        steer: async (sid) => {
          steers.push(sid);
          return true;
        },
        sampleMemory: async () => ({
          availableBytes: 8 * 1024 ** 3,
          psiFullAvg10: null,
          darwinPressure: "normal",
        }),
      };
      svc = new HeavySlotService(deps);
      await svc.start();
      await svc.acquire("s1", "browser", null);
      await svc.started("s1", id, parent.pid!);
      await svc.acquire("s2", "next", null);
      await svc.finish("s1", id, 0);
      expect(store.listHeavySlotJobs(["lingering"])).toHaveLength(1);
      svc.stop();
      svc = new HeavySlotService(deps);
      await svc.start();
      expect(steers).toHaveLength(0);
      process.kill(childPid, "SIGKILL");
      const deadline = Date.now() + 8000;
      while (lastScan.procs.has(id) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await svc.sweep(true);
      }
      expect(lastScan.procs.has(id)).toBe(false);
      if (!lastScan.complete) {
        // SIP-protected processes of the runner UID may make global absence
        // unprovable. Keep the slot, exactly as the production safety rule requires.
        expect(steers).toHaveLength(0);
        expect(store.listHeavySlotJobs(["lingering"])).toHaveLength(1);
        await svc.release("s1");
      }
      expect(steers).toEqual(["s2"]);
      childPid = undefined;
    } finally {
      svc?.stop();
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
      if (parent.exitCode === null) parent.kill("SIGKILL");
    }
  },
  20_000,
);
