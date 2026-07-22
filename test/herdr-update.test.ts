import { test, expect, afterEach } from "bun:test";
import {
  HerdrUpdateService,
  buildUpdateScript,
  compareSemver,
  UPDATE_LOG_PREFIX,
  type HerdrUpdateResult,
} from "../src/herdr-update";
import { setDetectedHerdrVersion } from "../src/herdr-capabilities";

// check() refreshes the PROCESS-WIDE spawn-guard version (#1887) as a side effect; the
// stranded-install tests (#1898) leave it at an unsupported 0.7.5, which would break any
// later test file that spawns via the drivers (order-dependent HerdrSpawnUnsupportedError).
// Reset to the un-probed default after every test.
afterEach(() => setDetectedHerdrVersion(null));

const LOG = "/home/op/.shepherd/herdr-update.log";

// ── buildUpdateScript: handoff update, recover-on-fail, durable audit log ─────
test("buildUpdateScript: runs `herdr update --handoff`, no destructive pre-stop", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  // --handoff lets a protocol-bumping update proceed while Shepherd's own herdr
  // target is live ("one or more herdr targets must restart" otherwise). The
  // binary is shell-quoted (`'herdr' update …`), so assert the flag, not `herdr `.
  expect(s).toContain("update --handoff");
  // the old pre-update `herdr server stop` killed the live server but never
  // cleared the targets, orphaning every pane on a failed update — gone for good.
  expect(s).not.toContain("herdr server stop");
});

test("buildUpdateScript: runs `agent list` UNCONDITIONALLY after update, not gated on rc (#1558)", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  // #1558: `herdr update` exits 0 even when it left no running server, so gating
  // recovery on the exit code skipped the exact bug. Recovery must NOT be wrapped
  // in an rc check any more.
  expect(s).not.toContain('if [ "$rc" -ne 0 ]');
  // `agent list` is the recovery: a herdr CLI call auto-spawns the daemon, so this
  // both verifies AND resurrects the server, driver-independently.
  expect(s).toContain("agent list");
  // grace + retry so an in-flight --handoff / a systemd `Restart=always` unit can
  // bind first before we conclude the server is unreachable.
  expect(s).toContain("for attempt in 1 2 3");
  expect(s).toContain("sleep 2");
  expect(s).toContain("ok=1");
});

test("buildUpdateScript: relaunches a detached server ONLY as a post-retry fallback", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  // the explicit relaunch is RETAINED (hedge against a weaker 0.7.x auto-spawn) but
  // fires only in the `else` branch, i.e. after the grace+retry loop still failed.
  expect(s).toMatch(/setsid\b.*\bserver\b.*&/);
  expect(s).toMatch(/else\s*\n\s*echo '[^']*unreachable after retries/);
  // NEVER unlink the socket: herdr clears/rebinds its own stale socket on spawn, and
  // an external `rm` could destroy a concurrently-recovering server's socket (#1558).
  expect(s).not.toMatch(/\brm\b/);
  expect(s).not.toContain("herdr.sock");
  // the nonexistent verb is gone; no stop/handoff (both need a live server) and no systemd.
  expect(s).not.toContain("herdr server start");
  expect(s).not.toContain("live-handoff");
  expect(s).not.toContain("status server");
});

test("buildUpdateScript: threads a custom HERDR_BIN through every herdr call", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6", "/opt/herdr/bin/herdr");
  // the configured binary drives the update, the auto-spawning `agent list` probe,
  // and the fallback relaunch — each shell-quoted so a path with spaces/quotes can't
  // break the script.
  expect(s).toContain("'/opt/herdr/bin/herdr' update --handoff");
  expect(s).toContain("'/opt/herdr/bin/herdr' agent list");
  expect(s).toContain("'/opt/herdr/bin/herdr' server");
});

test("buildUpdateScript: never restarts shepherd or shells systemd", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  expect(s).not.toContain("systemctl");
  expect(s).not.toContain("systemd-run");
  expect(s).not.toContain("restart shepherd");
});

test("buildUpdateScript: echoes a greppable marker for each step", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  const markers = s.split("\n").filter((l) => l.includes(UPDATE_LOG_PREFIX));
  // running / exited rc / reachable-after-update / unreachable-after-retries = 4 markers
  // (the reachable + unreachable branches are mutually exclusive at runtime, both in text)
  expect(markers.length).toBe(4);
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

// ── check()/apply(): a latest newer than the supported ceiling is flagged + blocked ─────────────
test("check(): a newer-but-unsupported latest (past the ceiling) sets latestUnsupported", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.5",
    fetchLatest: async () => ({ version: "0.8.0", notes: "### Breaking" }),
  });
  const s = await svc.check(1000);
  expect(s.updateAvailable).toBe(true); // a newer version does exist
  expect(s.latestUnsupported).toBe(true); // …but Shepherd can't run it
});

test("check(): a supported latest (0.7.4 → 0.7.5) is NOT flagged unsupported", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.4",
    fetchLatest: async () => ({ version: "0.7.5" }),
  });
  const s = await svc.check(1000);
  expect(s.updateAvailable).toBe(true);
  expect(s.latestUnsupported).toBe(false); // 0.7.5 is now supported — the updater offers it
});

test("apply(): refuses to upgrade into an unsupported latest (never started)", async () => {
  let ran = false;
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.5",
    fetchLatest: async () => ({ version: "0.8.0" }),
    runUpdate: async () => {
      ran = true;
    },
  });
  await svc.check(1000); // populates latestUnsupported=true
  expect(svc.apply()).toEqual({ started: false });
  expect(ran).toBe(false); // the update child was never spawned
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

test("apply(): when runUpdate throws, reports the ACTUAL version, not the target", async () => {
  // spawn failed → still on the old version; the result must say so (never the target).
  const { svc, begun, dones } = primed({
    installedAfter: "0.6.7",
    latest: "0.6.8",
    runUpdate: async () => {
      throw new Error("spawn failed");
    },
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(begun).toEqual([true, false]); // maintenance still cleared
  expect(dones[0]).toMatchObject({
    ok: false,
    to: "0.6.7",
    error: expect.stringContaining("spawn failed"),
  });
  expect(dones[0]!.to).not.toBe("0.6.8"); // never the target we did NOT reach
});

test("apply(): watchdog timeout reports the ACTUAL version, not the target", async () => {
  const { svc, begun, dones } = primed({
    installedAfter: "0.6.7", // hung update never swapped the binary
    latest: "0.6.8",
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
  expect(dones[0]).toMatchObject({
    ok: false,
    to: "0.6.7",
    error: expect.stringContaining("timed out"),
  });
  expect(dones[0]!.to).not.toBe("0.6.8"); // not the version we know we never reached
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

// ── check(): stranded install (unsupported INSTALLED herdr, #1898) ───────────
test("check(): an unsupported INSTALLED herdr (0.7.6) sets currentUnsupported + downgradeTarget", async () => {
  // 0.7.5 is now the supported ceiling (epic #1889), so the stranded case is 0.7.6+.
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.6",
    fetchLatest: async () => ({ version: "0.7.6" }),
  });
  const s = await svc.check(1000);
  expect(s.currentUnsupported).toBe(true);
  expect(s.downgradeTarget).toBe("0.7.5"); // = HERDR_LAST_SUPPORTED_VERSION today
  expect(s.updateAvailable).toBe(false); // current === latest: nothing to upgrade to
});

test("check(): a supported installed herdr (0.7.4) is not stranded; no downgrade target", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.4",
    fetchLatest: async () => ({ version: "0.7.5" }),
  });
  const s = await svc.check(1000);
  expect(s.currentUnsupported).toBe(false);
  expect(s.downgradeTarget).toBeNull();
});

test("check(): a failed fetch carries the prior current into the stranded flags", async () => {
  let calls = 0;
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.6", // 0.7.6 is unsupported (ceiling is now 0.7.5, epic #1889)
    fetchLatest: async () => {
      calls++;
      if (calls > 1) throw new Error("herdr.dev down");
      return { version: "0.7.6" };
    },
  });
  await svc.check(1000); // seeds current=0.7.6
  const s = await svc.check(2000); // fetch fails; current carried from last
  expect(s.error).toContain("down");
  expect(s.currentUnsupported).toBe(true);
  expect(s.downgradeTarget).toBe("0.7.5");
});
