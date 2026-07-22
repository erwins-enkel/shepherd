import { test, expect } from "bun:test";
import {
  buildDowngradeScript,
  herdrAssetKey,
  herdrReleaseUrl,
  UPDATE_LOG_PREFIX,
} from "../src/herdr-update";

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
