import { test, expect } from "bun:test";
import {
  buildDowngradeScript,
  herdrAssetKey,
  herdrReleaseUrl,
  UPDATE_LOG_PREFIX,
  HerdrUpdateService,
  type HerdrUpdateResult,
} from "../src/herdr-update";
import { detectedHerdrVersion } from "../src/herdr-capabilities";

const LOG = "/home/op/.shepherd/herdr-update.log";
const URL074 = "https://github.com/ogulcancelik/herdr/releases/download/v0.7.4/herdr-linux-x86_64";

// ── herdrAssetKey: process.platform/arch → latest.json asset key ─────────────
test("herdrAssetKey: maps supported platforms, null for anything else", () => {
  expect(herdrAssetKey("linux", "x64")).toBe("linux-x86_64");
  expect(herdrAssetKey("linux", "arm64")).toBe("linux-aarch64");
  expect(herdrAssetKey("darwin", "x64")).toBe("macos-x86_64");
  expect(herdrAssetKey("darwin", "arm64")).toBe("macos-aarch64");
  expect(herdrAssetKey("win32", "x64")).toBeNull();
  expect(herdrAssetKey("linux", "ia32")).toBeNull();
});

// ── herdrReleaseUrl: rigid template, sanitized version ────────────────────────
test("herdrReleaseUrl: builds the versioned GitHub asset URL from the template", () => {
  expect(herdrReleaseUrl("0.7.4", "linux-x86_64")).toBe(URL074);
});

test("herdrReleaseUrl: strips shell metacharacters out of the version", () => {
  expect(herdrReleaseUrl('0.7.4"; rm -rf ~ #', "linux-x86_64")).toBe(URL074);
});

// ── buildDowngradeScript: safety-critical ordering ────────────────────────────
test("buildDowngradeScript: download → verify → swap → server stop, in that order", () => {
  const s = buildDowngradeScript(LOG, "0.7.5", "0.7.4", URL074);
  const at = (sub: string) => {
    const i = s.indexOf(sub);
    expect(i, `script must contain: ${sub}`).toBeGreaterThan(-1);
    return i;
  };
  const download = at("curl -fsSL");
  const verify = at('"$TMP" --version');
  const swap = at('mv -f "$TMP" "$BIN"');
  const stop = at('"$BIN" server stop');
  expect(download).toBeLessThan(verify);
  expect(verify).toBeLessThan(swap);
  expect(swap).toBeLessThan(stop); // the live server is only touched AFTER a verified swap
});

test("buildDowngradeScript: verify step is an exact semver match, not a substring", () => {
  // a `grep -qF "0.7.4"` substring check would also pass "10.7.4" or "0.7.40" —
  // the downloaded binary's version must equal the target exactly
  const s = buildDowngradeScript(LOG, "0.7.5", "0.7.4", URL074);
  expect(s).toContain('grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+"');
  expect(s).toContain('if [ "$V" != "0.7.4" ]; then');
  expect(s).not.toContain("grep -qF");
});

test("buildDowngradeScript: verify-fail and download-fail abort BEFORE the swap", () => {
  const s = buildDowngradeScript(LOG, "0.7.5", "0.7.4", URL074);
  // both failure branches clean the temp file and exit without ever reaching mv
  const aborts = s.split("\n").filter((l) => l.includes("herdr binary untouched"));
  expect(aborts.length).toBe(3); // download failed, verify failed, swap failed
  expect(s).toContain('rm -f "$TMP"');
  expect(s).not.toContain("rm -rf");
});

test("buildDowngradeScript: resolves the real binary path (bare PATH name works)", () => {
  // pass the bin explicitly — config.herdrBin honors a HERDR_BIN env override, so
  // asserting the default would be environment-dependent
  const s = buildDowngradeScript(LOG, "0.7.5", "0.7.4", URL074, "herdr");
  expect(s).toContain("command -v 'herdr'");
  expect(s).toContain('TMP="$BIN.downgrade.$$"'); // temp NEXT TO the binary → atomic mv
});

test("buildDowngradeScript: recovery loop mirrors the update script (grace+retry, setsid fallback)", () => {
  const s = buildDowngradeScript(LOG, "0.7.5", "0.7.4", URL074);
  expect(s).toContain("for attempt in 1 2 3");
  expect(s).toContain("sleep 2");
  expect(s).toContain('"$BIN" agent list');
  expect(s).toMatch(/setsid "\$BIN" server .*&/);
  // no handoff (no live panes on a stranded install), no systemd shelling
  expect(s).not.toContain("--handoff");
  expect(s).not.toContain("systemctl");
  expect(s).not.toContain("systemd-run");
});

test("buildDowngradeScript: appends a delimited block to the shared audit log", () => {
  const s = buildDowngradeScript(LOG, "0.7.5", "0.7.4", URL074);
  expect(s).toContain(`LOG='${LOG}'`);
  expect(s).toContain('| tee -a "$LOG"');
  expect(s).toContain("=== herdr-downgrade $(date -u +%Y-%m-%dT%H:%M:%SZ) 0.7.5 -> 0.7.4 ===");
  expect(s).toContain('mkdir -p "$(dirname "$LOG")"');
  // every step announces itself with the greppable shared prefix
  expect(s.split("\n").filter((l) => l.includes(UPDATE_LOG_PREFIX)).length).toBeGreaterThanOrEqual(
    8,
  );
});

test("buildDowngradeScript: sanitizes versions and shell-quotes the URL and binary", () => {
  const s = buildDowngradeScript(LOG, "0.7.5", '0.7.4"; rm -rf ~ #', URL074, "/opt/herdr's/bin");
  expect(s).not.toContain("rm -rf");
  expect(s).toContain("0.7.5 -> 0.7.4 ===");
  expect(s).toContain(`'${URL074}'`); // URL single-quoted for the shell
  expect(s).toContain("'/opt/herdr'\\''s/bin'"); // classic close-reopen quote escape
});

test("buildDowngradeScript: missing versions degrade to 'unknown'", () => {
  const s = buildDowngradeScript(LOG, null, undefined, URL074);
  expect(s).toContain("unknown -> unknown ===");
});

// ── HerdrUpdateService.downgrade() ────────────────────────────────────────────

const KEY = herdrAssetKey()!; // the test host is always a supported platform
const TARGET_URL = herdrReleaseUrl("0.7.4", KEY);

/** Service primed for a stranded install (current 0.7.5), with every seam injected
 *  so no real process spawns and no network is touched. */
function primedDowngrade(
  opts: {
    current?: string; // installed BEFORE the downgrade; default 0.7.5 (stranded)
    installedAfter?: string; // what --version reports AFTER; default 0.7.4 (success)
    manifestUrl?: string | null; // releases["0.7.4"].assets[KEY]; null = entry missing
    fetchLatest?: () => Promise<never>; // override to make the manifest fetch throw
    runDowngrade?: (
      script: string,
      onLine: (l: string) => void,
      signal: AbortSignal,
    ) => Promise<void>;
    watchdogMs?: number;
  } = {},
) {
  const scripts: string[] = [];
  const dones: HerdrUpdateResult[] = [];
  const begun: boolean[] = [];
  const current = opts.current ?? "0.7.5";
  let versionCalls = 0;
  const releases: Record<string, { assets?: Record<string, string> }> = {};
  if (opts.manifestUrl !== null) {
    releases["0.7.4"] = { assets: { [KEY]: opts.manifestUrl ?? TARGET_URL } };
  }
  const svc = new HerdrUpdateService({
    versionRunner: () => {
      versionCalls++;
      return `herdr ${versionCalls === 1 ? current : (opts.installedAfter ?? "0.7.4")}`;
    },
    fetchLatest: opts.fetchLatest ?? (async () => ({ version: current, releases })),
    runDowngrade:
      opts.runDowngrade ??
      (async (script) => {
        scripts.push(script);
      }),
    onDone: (r) => dones.push(r),
    maintenance: { begin: () => begun.push(true), end: () => begun.push(false) },
    watchdogMs: opts.watchdogMs ?? 300_000,
  });
  return { svc, scripts, dones, begun };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test("downgrade(): happy path — runs the script, reports ok, refreshes the spawn guard", async () => {
  const { svc, scripts, dones, begun } = primedDowngrade();
  await svc.check(1); // seeds current=0.7.5 → currentUnsupported
  expect(svc.downgrade()).toEqual({ started: true });
  await settle();
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toContain(TARGET_URL); // the cross-checked template URL drives the script
  expect(dones[0]).toMatchObject({ ok: true, from: "0.7.5", to: "0.7.4" });
  expect(begun).toEqual([true, false]); // maintenance begin/end
  expect(detectedHerdrVersion()).toBe("0.7.4"); // spawn-guard ceiling refreshed, no restart
  expect(svc.current()).toMatchObject({
    current: "0.7.4",
    currentUnsupported: false,
    downgradeTarget: null,
  });
});

test("downgrade(): refuses when the installed herdr is already supported", async () => {
  const { svc, scripts } = primedDowngrade({ current: "0.7.4" });
  await svc.check(1);
  expect(svc.downgrade()).toEqual({ started: false });
  expect(scripts).toHaveLength(0);
});

test("downgrade(): double-launch guarded while one is in flight", async () => {
  let runs = 0;
  const { svc } = primedDowngrade({
    runDowngrade: async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 30));
    },
  });
  await svc.check(1);
  expect(svc.downgrade()).toEqual({ started: true });
  expect(svc.downgrade()).toEqual({ started: false });
  await new Promise((r) => setTimeout(r, 60));
  expect(runs).toBe(1);
});

test("downgrade(): missing manifest entry → fails BEFORE running anything", async () => {
  const { svc, scripts, dones, begun } = primedDowngrade({
    manifestUrl: null,
    installedAfter: "0.7.5", // binary untouched
  });
  await svc.check(1);
  svc.downgrade();
  await settle();
  expect(scripts).toHaveLength(0); // never reached the script
  expect(dones[0]).toMatchObject({ ok: false, to: "0.7.5" });
  expect(dones[0]!.error).toContain("no 0.7.4 asset");
  expect(begun).toEqual([true, false]); // maintenance still cleared
});

test("downgrade(): manifest URL divergence from the template → refuses", async () => {
  const { svc, scripts, dones } = primedDowngrade({
    manifestUrl: "https://evil.example.com/herdr",
    installedAfter: "0.7.5",
  });
  await svc.check(1);
  svc.downgrade();
  await settle();
  expect(scripts).toHaveLength(0);
  expect(dones[0]!.ok).toBe(false);
  expect(dones[0]!.error).toContain("does not match");
});

test("downgrade(): manifest fetch throws → fails cleanly, binary untouched", async () => {
  let checked = false;
  const { svc, dones, begun } = primedDowngrade({
    installedAfter: "0.7.5",
    fetchLatest: async () => {
      if (!checked) {
        checked = true;
        // first call (check) succeeds so the service knows it is stranded
        return { version: "0.7.5", releases: {} } as never;
      }
      throw new Error("herdr.dev unreachable");
    },
  });
  await svc.check(1);
  svc.downgrade();
  await settle();
  expect(dones[0]).toMatchObject({ ok: false, to: "0.7.5" });
  expect(dones[0]!.error).toContain("unreachable");
  expect(begun).toEqual([true, false]);
});

test("downgrade(): version unchanged after the script → reports failure, not the target", async () => {
  const { svc, dones } = primedDowngrade({ installedAfter: "0.7.5" });
  await svc.check(1);
  svc.downgrade();
  await settle();
  expect(dones[0]).toMatchObject({ ok: false, to: "0.7.5" });
  expect(dones[0]!.error).toContain("not downgraded");
});

test("downgrade(): watchdog timeout kills a hung script and reports the actual version", async () => {
  const { svc, dones } = primedDowngrade({
    installedAfter: "0.7.5",
    watchdogMs: 20,
    runDowngrade: (_script, _onLine, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  await svc.check(1);
  svc.downgrade();
  await new Promise((r) => setTimeout(r, 60));
  expect(dones[0]).toMatchObject({ ok: false, to: "0.7.5" });
  expect(dones[0]!.error).toContain("timed out");
});
