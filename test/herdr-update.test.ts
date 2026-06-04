import { test, expect } from "bun:test";
import {
  HerdrUpdateService,
  buildUpdateScript,
  compareSemver,
  UPDATE_LOG_PREFIX,
  type HerdrUpdateResult,
} from "../src/herdr-update";

const LOG = "/home/op/.shepherd/herdr-update.log";

// ── buildUpdateScript: stop → update, NO restart, durable audit log ──────────
test("buildUpdateScript: stops herdr then updates, in that order", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  const stop = s.indexOf("herdr server stop");
  const update = s.indexOf("herdr update;");
  expect(stop).toBeGreaterThanOrEqual(0);
  expect(update).toBeGreaterThan(stop);
});

test("buildUpdateScript: never restarts shepherd or shells systemd", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  expect(s).not.toContain("systemctl");
  expect(s).not.toContain("systemd-run");
  expect(s).not.toContain("restart shepherd");
});

test("buildUpdateScript: echoes a greppable marker for the two real steps", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  const markers = s.split("\n").filter((l) => l.includes(UPDATE_LOG_PREFIX));
  // stopping / running / exited rc = 3 markers (no restart markers anymore)
  expect(markers.length).toBe(3);
  expect(s).toContain(`${UPDATE_LOG_PREFIX} herdr update exited rc=$rc`);
});

test("buildUpdateScript: appends a delimited, timestamped, versioned block", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  expect(s).toContain(`LOG='${LOG}'`);
  expect(s).toContain('| tee -a "$LOG"');
  expect(s).toContain("=== herdr-update $(date -u +%Y-%m-%dT%H:%M:%SZ) 0.6.5 -> 0.6.6 ===");
  expect(s).toContain('mkdir -p "$(dirname "$LOG")"');
});

test("buildUpdateScript: sanitizes versions so a payload can't inject shell", () => {
  const s = buildUpdateScript(LOG, "0.6.5", '0.6.6"; rm -rf ~ #');
  expect(s).not.toContain("rm -rf");
  expect(s).toContain("0.6.5 -> 0.6.6 ===");
});

test("buildUpdateScript: missing versions degrade to 'unknown'", () => {
  const s = buildUpdateScript(LOG, null, undefined);
  expect(s).toContain("unknown -> unknown ===");
});

// ── compareSemver ────────────────────────────────────────────────────────────
test("compareSemver: orders numerically", () => {
  expect(compareSemver("0.6.5", "0.6.3")).toBe(1);
  expect(compareSemver("0.6.3", "0.6.5")).toBe(-1);
  expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
  expect(compareSemver("0.6", "0.6.0")).toBe(0);
});

// ── check(): unchanged behavior ──────────────────────────────────────────────
test("current < latest → updateAvailable true, notes carried", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.5.10\n",
    fetchLatest: async () => ({ version: "0.6.5", notes: "### Added\n- scrollback" }),
  });
  const s = await svc.check(1000);
  expect(s.current).toBe("0.5.10");
  expect(s.latest).toBe("0.6.5");
  expect(s.updateAvailable).toBe(true);
  expect(s.notes).toBe("### Added\n- scrollback");
});

test("current == latest → updateAvailable false", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.6.5",
    fetchLatest: async () => ({ version: "0.6.5" }),
  });
  const s = await svc.check(2000);
  expect(s.updateAvailable).toBe(false);
});

test("versionRunner throws → fail-safe, no badge, error set", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => {
      throw new Error("herdr: command not found");
    },
    fetchLatest: async () => ({ version: "0.6.5" }),
  });
  const s = await svc.check(4000);
  expect(s.updateAvailable).toBe(false);
  expect(s.error).toContain("command not found");
});

// ── apply(): maintenance lifecycle, success/failure detection ─────────────────

/** Build a service primed with a known current→latest, injecting all seams so
 *  no real process spawns. `runUpdate` resolves immediately by default. */
function primed(opts: {
  installedAfter: string; // what `herdr --version` reports AFTER the update
  latest?: string;
  current?: string;
  runUpdate?: (onLine: (l: string) => void, signal: AbortSignal) => Promise<void>;
  watchdogMs?: number;
}) {
  const begun: boolean[] = [];
  const dones: HerdrUpdateResult[] = [];
  let versionCalls = 0;
  const svc = new HerdrUpdateService({
    // first call (during check) returns `current`; later calls return installedAfter
    versionRunner: () => {
      versionCalls++;
      return `herdr ${versionCalls === 1 ? (opts.current ?? "0.6.7") : opts.installedAfter}`;
    },
    fetchLatest: async () => ({ version: opts.latest ?? "0.6.8" }),
    runUpdate: opts.runUpdate ?? (async () => {}),
    onLog: () => {},
    onStatus: () => {},
    onDone: (r) => dones.push(r),
    maintenance: {
      begin: () => begun.push(true),
      end: () => begun.push(false),
    },
    watchdogMs: opts.watchdogMs ?? 300_000,
  });
  return { svc, begun, dones };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test("apply(): success when re-read version equals target; maintenance begins then ends", async () => {
  const { svc, begun, dones } = primed({ installedAfter: "0.6.8", latest: "0.6.8" });
  await svc.check(1); // sets current=0.6.7, latest=0.6.8, updateAvailable
  expect(svc.apply()).toEqual({ started: true });
  await settle();
  expect(begun).toEqual([true, false]); // begin, then end
  expect(dones).toHaveLength(1);
  expect(dones[0]).toMatchObject({ ok: true, to: "0.6.8" });
});

test("apply(): failure when version unchanged even though the child exits 0 (rc lies)", async () => {
  const { svc, begun, dones } = primed({ installedAfter: "0.6.7", latest: "0.6.8" });
  await svc.check(1); // current=0.6.7
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({ ok: false });
  expect(begun).toEqual([true, false]); // maintenance still cleared
});

test("apply(): maintenance is cleared even when runUpdate throws", async () => {
  const { svc, begun, dones } = primed({
    installedAfter: "0.6.8",
    runUpdate: async () => {
      throw new Error("spawn failed");
    },
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(begun).toEqual([true, false]);
  expect(dones[0]).toMatchObject({ ok: false, error: expect.stringContaining("spawn failed") });
});

test("apply(): watchdog aborts a hung update and clears maintenance", async () => {
  const { svc, begun, dones } = primed({
    installedAfter: "0.6.7",
    watchdogMs: 20,
    runUpdate: (_onLine, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  await svc.check(1);
  svc.apply();
  await new Promise((r) => setTimeout(r, 60));
  expect(begun).toEqual([true, false]);
  expect(dones[0]).toMatchObject({ ok: false });
});

test("apply(): double-launch guarded while one is in flight", async () => {
  let runs = 0;
  const { svc } = primed({
    installedAfter: "0.6.8",
    runUpdate: async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 30));
    },
  });
  await svc.check(1);
  expect(svc.apply()).toEqual({ started: true });
  expect(svc.apply()).toEqual({ started: false }); // still applying
  await new Promise((r) => setTimeout(r, 60));
  expect(runs).toBe(1);
});

test("apply(): streams runUpdate lines to onLog", async () => {
  const received: string[] = [];
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.6.8",
    fetchLatest: async () => ({ version: "0.6.8" }),
    runUpdate: async (onLine) => {
      onLine("downloading 0.6.8...");
      onLine("updated to 0.6.8");
    },
    onLog: (l) => received.push(l),
    maintenance: { begin: () => {}, end: () => {} },
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(received).toEqual(["downloading 0.6.8...", "updated to 0.6.8"]);
});
