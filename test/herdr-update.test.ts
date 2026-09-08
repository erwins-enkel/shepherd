import type { HerdrRuntimeStatus } from "../src/herdr-runtime";
import { test, expect, afterEach } from "bun:test";
import {
  HerdrUpdateService,
  buildUpdateScript,
  compareSemver,
  UPDATE_LOG_PREFIX,
  type HerdrUpdateResult,
} from "../src/herdr-update";
import { HERDR_LAST_SUPPORTED_VERSION, setDetectedHerdrVersion } from "../src/herdr-capabilities";

// check() refreshes the PROCESS-WIDE spawn-guard version (#1887) as a side effect; the
// stranded-install tests (#1898) leave it at an unsupported 0.7.5, which would break any
// later test file that spawns via the drivers (order-dependent HerdrSpawnUnsupportedError).
// Reset to the un-probed default after every test.
afterEach(() => setDetectedHerdrVersion(null));

const LOG = "/home/op/.shepherd/herdr-update.log";

test("a successful binary install with a failed handoff requires repair, never reports success", async () => {
  const results: HerdrUpdateResult[] = [];
  let recoveries = 0;
  let installed = "0.8.2";
  const svc = new HerdrUpdateService({
    versionRunner: () => `herdr ${installed}`,
    fetchLatest: async () => ({ version: "0.9.0" }),
    runUpdate: async (onLine) => {
      installed = "0.9.0";
      onLine(
        'live handoff failed: {"code":"handoff_failed","message":"live handoff supports at most 64 panes in one update"}',
      );
    },
    probeRuntime: async () => ({
      state: "restart_required",
      installedVersion: installed,
      serverVersion: "0.8.2",
      reason: "protocol_mismatch",
    }),
    runRecovery: async () => {
      recoveries++;
    },
    onDone: (result) => results.push(result),
  });
  await svc.check(1);
  svc.apply();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(recoveries).toBe(0);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    ok: false,
    from: "0.8.2",
    to: "0.9.0",
    errorCode: "restart_required",
    serverVersion: "0.8.2",
  });
  expect(svc.current()?.runtime?.state).toBe("restart_required");
});

// ── buildUpdateScript: handoff attempt and durable audit log ─────────────────
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

test("buildUpdateScript leaves server recovery to the verified service", () => {
  const script = buildUpdateScript(LOG, "0.8.2", "0.9.0");
  expect(script).not.toContain("setsid");
  expect(script).not.toContain("server stop");
});

test("buildUpdateScript: threads a custom HERDR_BIN through every herdr call", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6", "/opt/herdr/bin/herdr");
  // The configured binary drives the update, shell-quoted so a path with spaces/quotes can't
  // break the script.
  expect(s).toContain("'/opt/herdr/bin/herdr' update --handoff");
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
  expect(markers.length).toBe(2);
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
    versionRunner: () => "herdr 0.8.2",
    fetchLatest: async () => ({ version: "0.9.1", notes: "### Breaking" }),
  });
  const s = await svc.check(1000);
  expect(s.updateAvailable).toBe(true); // a newer version does exist
  expect(s.latestUnsupported).toBe(true); // …but Shepherd can't run it
});

test("check(): a supported latest (0.8.2 → 0.9.0) is NOT flagged unsupported", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.8.2",
    fetchLatest: async () => ({ version: "0.9.0" }),
  });
  const s = await svc.check(1000);
  expect(s.updateAvailable).toBe(true);
  expect(s.latestUnsupported).toBe(false); // 0.9.0 is now supported — the updater offers it
});

test("apply(): refuses to upgrade into an unsupported latest (never started)", async () => {
  let ran = false;
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.8.2",
    fetchLatest: async () => ({ version: "0.9.1" }),
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
    probeRuntime: async () => ({
      state: "ready",
      installedVersion: opts.installedAfter,
      serverVersion: opts.installedAfter,
    }),
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

test("apply(): 0.8.2 → 0.9.0 succeeds and clears unsupported/downgrade flags", async () => {
  const { svc, begun, dones } = primed({
    current: "0.8.2",
    latest: "0.9.0",
    installedAfter: "0.9.0",
  });
  await svc.check(1);
  expect(svc.apply()).toEqual({ started: true });
  await settle();
  expect(begun).toEqual([true, false]);
  expect(dones).toEqual([{ ok: true, from: "0.8.2", to: "0.9.0", serverVersion: "0.9.0" }]);
  expect(svc.current()).toMatchObject({
    current: "0.9.0",
    updateAvailable: false,
    latestUnsupported: false,
    currentUnsupported: false,
    downgradeTarget: null,
  });
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
    errorCode: "timeout",
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
test("check(): an unsupported INSTALLED herdr (0.9.1) sets currentUnsupported + downgradeTarget", async () => {
  // 0.9.0 is now the supported ceiling, so the stranded case is 0.9.1+.
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.9.1",
    fetchLatest: async () => ({ version: "0.9.1" }),
  });
  const s = await svc.check(1000);
  expect(s.currentUnsupported).toBe(true);
  // Bound to the constant, not a literal: the ceiling moves with every herdr bump (#2039).
  expect(s.downgradeTarget).toBe(HERDR_LAST_SUPPORTED_VERSION);
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
    versionRunner: () => "herdr 0.9.1", // 0.9.1 is unsupported (ceiling is now 0.9.0)
    fetchLatest: async () => {
      calls++;
      if (calls > 1) throw new Error("herdr.dev down");
      return { version: "0.9.1" };
    },
  });
  await svc.check(1000); // seeds current=0.9.1
  const s = await svc.check(2000); // fetch fails; current carried from last
  expect(s.error).toContain("down");
  expect(s.currentUnsupported).toBe(true);
  expect(s.downgradeTarget).toBe(HERDR_LAST_SUPPORTED_VERSION);
});

// ── check(): two-path sandboxed-idle advisory (#1716) ────────────────────────
test("check(): sandboxIdleRegressed on a supported-but-regressed 0.7.5 WHEN sandboxed sessions are in use", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.5", // supported ceiling, but external-registration → regressed
    fetchLatest: async () => ({ version: "0.7.5" }),
    sandboxedInUse: () => true,
  });
  const s = await svc.check(1000);
  expect(s.currentUnsupported).toBe(false); // supported — NON-blocking advisory, not stranded
  expect(s.sandboxIdleRegressed).toBe(true);
  expect(s.sandboxDowngradeTarget).toBe("0.7.4"); // = HERDR_LAST_FULL_SANDBOX_STATUS_VERSION
});

test("check(): NO advisory on 0.7.5 when the operator runs no sandboxed sessions", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.5",
    fetchLatest: async () => ({ version: "0.7.5" }),
    sandboxedInUse: () => false,
  });
  const s = await svc.check(1000);
  expect(s.sandboxIdleRegressed).toBe(false);
  expect(s.sandboxDowngradeTarget).toBeNull();
});

test("check(): NO advisory on 0.7.4 (pre-external-registration) even with sandboxed sessions", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.4", // herdr launches+detects the sandboxed agent itself here
    fetchLatest: async () => ({ version: "0.7.5" }),
    sandboxedInUse: () => true,
  });
  const s = await svc.check(1000);
  expect(s.sandboxIdleRegressed).toBe(false);
  expect(s.sandboxDowngradeTarget).toBeNull();
});

// ── downgrade() gate: the two-path escape vs the stranded rescue ─────────────
test("downgrade(target): the sandbox escape starts from a SUPPORTED-but-regressed 0.7.5 → 0.7.4", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.5",
    fetchLatest: async () => ({ version: "0.7.5" }),
    sandboxedInUse: () => true,
    runDowngrade: async () => {}, // no real spawn; we only assert the gate decision
  });
  await svc.check(1000);
  // The stranded rescue (default target = supported ceiling 0.7.5) refuses — 0.7.5 IS supported.
  expect(svc.downgrade().started).toBe(false);
  // The two-path escape to 0.7.4 is allowed — it steps BELOW the ceiling.
  expect(svc.downgrade("0.7.4").started).toBe(true);
});

test("downgrade(target): refuses when the installed version is already at/below the target", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.4",
    fetchLatest: async () => ({ version: "0.7.5" }),
    runDowngrade: async () => {},
  });
  await svc.check(1000);
  expect(svc.downgrade("0.7.4").started).toBe(false); // already at 0.7.4 — nothing to move
});

test("confirmed repair restarts once, verifies readiness and releases maintenance", async () => {
  let runtime = {
    state: "restart_required" as "restart_required" | "ready",
    installedVersion: "0.9.0",
    serverVersion: "0.8.2",
  };
  const effects: string[] = [];
  const svc = new HerdrUpdateService({
    probeRuntime: async () => runtime,
    runRecovery: async (restart) => {
      effects.push(restart ? "restart" : "start");
      runtime = { state: "ready", installedVersion: "0.9.0", serverVersion: "0.9.0" };
    },
    maintenance: { begin: () => effects.push("begin"), end: () => effects.push("end") },
  });
  expect(await svc.restartServer({ installedVersion: "0.9.0", serverVersion: "0.8.2" })).toEqual({
    started: true,
  });
  await settle();
  expect(effects).toEqual(["begin", "restart", "end"]);
  expect(svc.current()).toMatchObject({
    phase: "idle",
    result: { ok: true, serverVersion: "0.9.0" },
  });
});

test("repair refuses a changed confirmation and a concurrent operation without stopping anything", async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let restarts = 0;
  const svc = new HerdrUpdateService({
    probeRuntime: async () => {
      await pending;
      return { state: "restart_required", installedVersion: "0.9.0", serverVersion: "0.8.2" };
    },
    runRecovery: async () => {
      restarts++;
    },
  });
  const first = svc.restartServer({ installedVersion: "0.8.2", serverVersion: "0.8.0" });
  expect(
    await svc.restartServer({ installedVersion: "0.9.0", serverVersion: "0.8.2" }),
  ).toMatchObject({ started: false, error: "in_progress" });
  release();
  expect(await first).toMatchObject({ started: false, error: "runtime_changed" });
  expect(restarts).toBe(0);
});

test("repair of an already recovered server is a harmless verified success", async () => {
  let restarts = 0;
  const svc = new HerdrUpdateService({
    probeRuntime: async () => ({
      state: "ready",
      installedVersion: "0.9.0",
      serverVersion: "0.9.0",
    }),
    runRecovery: async () => {
      restarts++;
    },
  });
  expect(await svc.restartServer({ installedVersion: "0.9.0", serverVersion: "0.8.2" })).toEqual({
    started: true,
  });
  expect(restarts).toBe(0);
  expect(svc.current()?.result?.ok).toBe(true);
});

test("failed repair publishes fresh offline facts and keeps an actionable failure", async () => {
  let stopped = false;
  const effects: string[] = [];
  const svc = new HerdrUpdateService({
    probeRuntime: async () => ({
      state: stopped ? "offline" : "restart_required",
      installedVersion: "0.9.0",
      serverVersion: stopped ? null : "0.8.2",
    }),
    runRecovery: async () => {
      stopped = true;
      throw new Error("start failed");
    },
    maintenance: { begin: () => effects.push("begin"), end: () => effects.push("end") },
  });
  await svc.restartServer({ installedVersion: "0.9.0", serverVersion: "0.8.2" });
  await settle();
  expect(svc.current()).toMatchObject({
    phase: "idle",
    runtime: { state: "offline" },
    result: { ok: false, errorCode: "restart_failed" },
  });
  expect(effects).toEqual(["begin", "end"]);
});

test("GET runtime refresh remains available without a release manifest and after reopen", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.9.0",
    fetchLatest: async () => {
      throw new Error("network down");
    },
    probeRuntime: async () => ({
      state: "restart_required",
      installedVersion: "0.9.0",
      serverVersion: "0.8.2",
    }),
  });
  await svc.check(1);
  expect(await svc.status()).toMatchObject({
    current: "0.9.0",
    latest: null,
    runtime: { state: "restart_required" },
  });
});

test("a delayed release check cannot overwrite newer installed runtime facts", async () => {
  let release!: (value: { version: string }) => void;
  const manifest = new Promise<{ version: string }>((resolve) => {
    release = resolve;
  });
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.8.2",
    fetchLatest: () => manifest,
    probeRuntime: async () => ({
      state: "ready",
      installedVersion: "0.9.0",
      serverVersion: "0.9.0",
    }),
  });
  const checking = svc.check(1);
  await svc.status();
  release({ version: "0.9.0" });
  expect(await checking).toMatchObject({ current: "0.9.0", updateAvailable: false });
});

test("update automatically starts only a freshly verified offline server", async () => {
  let runtime: HerdrRuntimeStatus = {
    state: "offline",
    installedVersion: "0.9.0",
    serverVersion: null,
  };
  const calls: boolean[] = [];
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.9.0",
    fetchLatest: async () => ({ version: "0.9.0" }),
    runUpdate: async () => {},
    probeRuntime: async () => runtime,
    runRecovery: async (restart, _signal, expected) => {
      expect(expected).toEqual(runtime);
      calls.push(restart);
      runtime = { state: "ready", installedVersion: "0.9.0", serverVersion: "0.9.0" };
    },
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(calls).toEqual([false]);
  expect(svc.current()?.result?.ok).toBe(true);
});
