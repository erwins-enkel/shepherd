# In-app herdr Downgrade (#1898) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-click in-app downgrade of herdr to the highest supported version for installations stranded on herdr 0.7.5+ (spawn-broken), surfaced in the herdr-update modal and the diagnostics panel.

**Architecture:** A new `downgrade()` path on the existing `HerdrUpdateService` (src/herdr-update.ts) builds a shell script that downloads a version-pinned binary from GitHub releases (URL = hardcoded template cross-checked against the `releases` map in `herdr.dev/latest.json`), verifies it, atomically swaps it, and restarts the herdr server — logging every step to `~/.shepherd/herdr-update.log`. Two new `HerdrUpdateStatus` fields (`currentUnsupported`, `downgradeTarget`) drive the UI; the modal gains a downgrade action and the diagnostics herdr row gains a button that opens the modal.

**Tech Stack:** Bun/TypeScript server, SvelteKit 5 (runes) UI, `bun:test` (root) + vitest browser (UI), Paraglide i18n.

**Spec:** `docs/superpowers/specs/2026-07-22-herdr-downgrade-design.md` (approved). Issue: #1898.

## Global Constraints

- Work happens in this worktree: `/home/moe/projects/shepherd/.claude/worktrees/feat-1898-herdr-downgrade` (branch `worktree-feat-1898-herdr-downgrade`). All commands run from this directory unless a `cd ui` is stated.
- Root tests: `bun test ./test` (NEVER bare `bun test` — it sweeps `ui/` into the wrong runner). UI tests: `cd ui && bun run test` (vitest — NOT `bun test`).
- KNOWN pre-existing failure: root test `pty-attach invokes herdr with --takeover …` (test/pty-bridge.test.ts) fails in worktrees because node-pty's native module can't build here. Ignore it; everything else must pass.
- Every user-facing string goes through Paraglide: add the key to BOTH `ui/messages/en.json` AND `ui/messages/de.json` (`cd ui && bun run check:i18n` must pass). Keys are snake_case, component-prefixed.
- Never hardcode `0.7.4` in the flow: the target version always derives from `HERDR_LAST_SUPPORTED_VERSION` (src/herdr-capabilities.ts). (Message TEXT may mention 0.7.5 as the historical breakage, matching existing messages.)
- Version strings from external sources pass through `sanitizeVersion()` before touching shell programs; everything embedded in shell is quoted via the existing `shq` pattern.
- UI code: design tokens only (`var(--color-*)`, `var(--fs-*)`), no raw hex/px font sizes; reuse existing recipes/classes.
- Conventional commits `<type>(<scope>): <description>` with issue ref `(#1898)`, atomic (one logical change per commit). End every commit message with the trailer line:
  `Claude-Session: https://claude.ai/code/session_011dMVhqvxyxZY4S2ALHCHqj`
- Formatting: repo hooks run prettier on staged files automatically at commit; if a check is needed manually use `bunx prettier --check <files>`.
- The feature-catalog entry uses `sinceVersion: "1.45.0"` (verified via `bun run next-version` on 2026-07-22; re-run it if executing later and use the fresh value for BOTH filename and field).

---

### Task 1: Status flags — `currentUnsupported` + `downgradeTarget`

The server tells the UI when the INSTALLED herdr is unsupported and which version the downgrade would install. Everything downstream (endpoint gate, modal, diagnostics button) keys off these fields.

**Files:**
- Modify: `src/herdr-update.ts` (import at line 4, new helper above the class, three status-construction sites)
- Modify: `src/types.ts` (interface `HerdrUpdateStatus`, ~line 399)
- Modify: `ui/src/lib/types.ts` (interface `HerdrUpdateStatus`, ~line 1450)
- Test: `test/herdr-update.test.ts` (append)

**Interfaces:**
- Consumes: `HERDR_LAST_SUPPORTED_VERSION`, `isHerdrVersionSupported` from `src/herdr-capabilities.ts` (exist).
- Produces: `HerdrUpdateStatus.currentUnsupported?: boolean` and `HerdrUpdateStatus.downgradeTarget?: string | null`, set by `check()` (success + error branches) and by `runOnce()` — later tasks (endpoint gate, modal, AppOverlays gate) read exactly these names.

- [ ] **Step 1: Write the failing tests**

Append to `test/herdr-update.test.ts`:

```ts
// ── check(): stranded install (unsupported INSTALLED herdr, #1898) ───────────
test("check(): an unsupported INSTALLED herdr (0.7.5) sets currentUnsupported + downgradeTarget", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.7.5",
    fetchLatest: async () => ({ version: "0.7.5" }),
  });
  const s = await svc.check(1000);
  expect(s.currentUnsupported).toBe(true);
  expect(s.downgradeTarget).toBe("0.7.4"); // = HERDR_LAST_SUPPORTED_VERSION today
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
    versionRunner: () => "herdr 0.7.5",
    fetchLatest: async () => {
      calls++;
      if (calls > 1) throw new Error("herdr.dev down");
      return { version: "0.7.5" };
    },
  });
  await svc.check(1000); // seeds current=0.7.5
  const s = await svc.check(2000); // fetch fails; current carried from last
  expect(s.error).toContain("down");
  expect(s.currentUnsupported).toBe(true);
  expect(s.downgradeTarget).toBe("0.7.4");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./test/herdr-update.test.ts`
Expected: 3 new tests FAIL (`currentUnsupported` is `undefined`), all pre-existing tests PASS.

- [ ] **Step 3: Implement the flags**

In `src/herdr-update.ts`, extend the import at line 4:

```ts
import {
  HERDR_LAST_SUPPORTED_VERSION,
  isHerdrVersionSupported,
  setDetectedHerdrVersion,
} from "./herdr-capabilities";
```

Add above `export interface HerdrUpdateResult` (module level):

```ts
/** Status fields derived from the INSTALLED version's support policy (#1898). A
 *  stranded install (unsupported current, e.g. 0.7.5+) advertises the version the
 *  in-app downgrade would install, so the UI never hardcodes a version. */
function supportFlags(
  current: string | null,
): Pick<HerdrUpdateStatus, "currentUnsupported" | "downgradeTarget"> {
  const unsupported = !isHerdrVersionSupported(current);
  return {
    currentUnsupported: unsupported,
    downgradeTarget: unsupported ? HERDR_LAST_SUPPORTED_VERSION : null,
  };
}
```

In `check()`'s success branch (`this.last = { current, latest, updateAvailable, latestUnsupported, notes… }`), add `...supportFlags(current),` after the `latestUnsupported` line. In `check()`'s catch branch, add `...supportFlags(this.last?.current ?? null),` after `updateAvailable: false,`. In `runOnce()`'s `this.last = {…}` block, add `...supportFlags(after),` after the `latestUnsupported` line.

In `src/types.ts`, inside `HerdrUpdateStatus` after the `latestUnsupported` member:

```ts
  /** true when the INSTALLED herdr is one Shepherd cannot drive (stranded on 0.7.5+,
   *  #1898). The modal offers the in-app downgrade and the diagnostics hint becomes
   *  actionable. */
  currentUnsupported?: boolean;
  /** The version the in-app downgrade installs (the supported ceiling) when
   *  `currentUnsupported`; null otherwise. Derived server-side from
   *  HERDR_LAST_SUPPORTED_VERSION so the UI never hardcodes a version. */
  downgradeTarget?: string | null;
```

In `ui/src/lib/types.ts`, add the same two members (same doc comments) to its `HerdrUpdateStatus` after `latestUnsupported`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/herdr-update.test.ts`
Expected: ALL PASS. Also run `bun run lint` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/herdr-update.ts src/types.ts ui/src/lib/types.ts test/herdr-update.test.ts
git commit -m "feat(herdr): flag an unsupported installed herdr in the update status (#1898)

Claude-Session: https://claude.ai/code/session_011dMVhqvxyxZY4S2ALHCHqj"
```

---

### Task 2: Downgrade script + versioned release-URL helpers

**Files:**
- Modify: `src/herdr-update.ts` (new exports after `buildUpdateScript`)
- Test: `test/herdr-downgrade.test.ts` (create)

**Interfaces:**
- Consumes: `sanitizeVersion` (private, same module), `UPDATE_LOG_PREFIX`, `config.herdrBin`.
- Produces (Task 3 relies on these exact signatures):
  - `export function herdrAssetKey(platform?: NodeJS.Platform, arch?: string): string | null` — `"linux-x86_64" | "linux-aarch64" | "macos-x86_64" | "macos-aarch64" | null`, defaults to `process.platform`/`process.arch`.
  - `export function herdrReleaseUrl(version: string, assetKey: string): string` — the hardcoded template URL with a sanitized version.
  - `export function buildDowngradeScript(logPath: string, from: string | null | undefined, to: string | null | undefined, url: string, herdrBin?: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `test/herdr-downgrade.test.ts`:

```ts
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
  expect(s.split("\n").filter((l) => l.includes(UPDATE_LOG_PREFIX)).length).toBeGreaterThanOrEqual(8);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./test/herdr-downgrade.test.ts`
Expected: FAIL — `herdrAssetKey`/`herdrReleaseUrl`/`buildDowngradeScript` are not exported.

- [ ] **Step 3: Implement**

In `src/herdr-update.ts`, insert directly AFTER the `buildUpdateScript` function (after its closing `}`):

```ts
/** Map this host onto latest.json's asset key (`linux-x86_64`, `macos-aarch64`, …);
 *  null when herdr publishes no binary for the platform. */
export function herdrAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "macos" : null;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  return os && cpu ? `${os}-${cpu}` : null;
}

/** The version-addressable release-asset URL, built from a HARDCODED template (the
 *  same GitHub slug the modal's release-notes link uses). The downgrade flow (#1898)
 *  cross-checks this against latest.json's `releases` map before running — the
 *  template guarantees shape (no injection), the manifest guarantees currency. */
export function herdrReleaseUrl(version: string, assetKey: string): string {
  return `https://github.com/ogulcancelik/herdr/releases/download/v${sanitizeVersion(version)}/herdr-${assetKey}`;
}

/**
 * The shell program for the in-app DOWNGRADE to a supported herdr (#1898). Same
 * logging contract as buildUpdateScript (one delimited `tee -a` block, every step
 * announced with UPDATE_LOG_PREFIX, explicit exit codes).
 *
 * Safety-critical ordering: download → verify → atomic swap → THEN restart. Every
 * failure before the swap aborts with the old binary untouched and the old server
 * still running — a failed rescue leaves the install exactly as broken as it was,
 * never more broken. No `--handoff`: on a stranded install the #1887 guard refused
 * every spawn, so there are no live agent panes to preserve.
 */
export function buildDowngradeScript(
  logPath: string,
  from: string | null | undefined,
  to: string | null | undefined,
  url: string,
  herdrBin: string = config.herdrBin,
): string {
  const f = sanitizeVersion(from);
  const t = sanitizeVersion(to);
  const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
  const q = shq(logPath);
  const h = shq(herdrBin);
  const u = shq(url);
  return [
    `LOG=${q}`,
    'mkdir -p "$(dirname "$LOG")"',
    "{",
    `  echo "=== herdr-downgrade $(date -u +%Y-%m-%dT%H:%M:%SZ) ${f} -> ${t} ==="`,
    // Resolve the real path first: config.herdrBin may be a bare "herdr" found via
    // PATH, and the atomic swap below must target the actual file, not ./herdr.
    `  BIN="$(command -v ${h} || true)"`,
    '  if [ -z "$BIN" ]; then',
    `    echo '${UPDATE_LOG_PREFIX} cannot locate the herdr binary — aborting'`,
    "    exit 1",
    "  fi",
    // Temp file NEXT TO the binary (same filesystem) so the swap is an atomic rename.
    '  TMP="$BIN.downgrade.$$"',
    `  echo '${UPDATE_LOG_PREFIX} downloading herdr ${t}'`,
    `  if ! curl -fsSL --retry 3 --connect-timeout 10 --max-time 120 -o "$TMP" ${u}; then`,
    `    echo '${UPDATE_LOG_PREFIX} download failed — herdr binary untouched'`,
    '    rm -f "$TMP"',
    "    exit 1",
    "  fi",
    '  chmod +x "$TMP"',
    `  echo '${UPDATE_LOG_PREFIX} verifying downloaded binary reports ${t}'`,
    `  if ! "$TMP" --version 2>/dev/null | grep -qF "${t}"; then`,
    `    echo '${UPDATE_LOG_PREFIX} downloaded binary does not report ${t} — aborting, herdr binary untouched'`,
    '    rm -f "$TMP"',
    "    exit 1",
    "  fi",
    `  echo '${UPDATE_LOG_PREFIX} swapping the verified binary into place'`,
    '  if ! mv -f "$TMP" "$BIN"; then',
    `    echo '${UPDATE_LOG_PREFIX} swap failed — herdr binary untouched'`,
    '    rm -f "$TMP"',
    "    exit 1",
    "  fi",
    // Only AFTER the verified swap is the running server touched. `server stop`
    // suffices on provisioned hosts (deploy/herdr.service has Restart=always); the
    // grace+retry loop lets systemd win before the last-resort detached relaunch —
    // the same recovery pattern as buildUpdateScript.
    `  echo '${UPDATE_LOG_PREFIX} stopping the herdr server so it relaunches on the downgraded binary'`,
    '  "$BIN" server stop; rc=$?',
    `  echo "${UPDATE_LOG_PREFIX} herdr server stop exited rc=$rc"`,
    "  ok=0",
    "  for attempt in 1 2 3; do",
    '    if timeout 10 "$BIN" agent list >/dev/null 2>&1; then ok=1; break; fi',
    "    sleep 2",
    "  done",
    '  if [ "$ok" -eq 1 ]; then',
    `    echo '${UPDATE_LOG_PREFIX} herdr server reachable after downgrade'`,
    "  else",
    `    echo '${UPDATE_LOG_PREFIX} herdr server unreachable after retries — relaunching a detached server'`,
    '    setsid "$BIN" server </dev/null >/dev/null 2>&1 &',
    "  fi",
    '} 2>&1 | tee -a "$LOG"',
  ].join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/herdr-downgrade.test.ts && bun test ./test/herdr-update.test.ts && bun run lint`
Expected: ALL PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/herdr-update.ts test/herdr-downgrade.test.ts
git commit -m "feat(herdr): add downgrade script + versioned release URL helpers (#1898)

Claude-Session: https://claude.ai/code/session_011dMVhqvxyxZY4S2ALHCHqj"
```

---

### Task 3: `HerdrUpdateService.downgrade()`

**Files:**
- Modify: `src/herdr-update.ts` (manifest type, `runDowngrade` dep, `spawnScript` extraction, `downgrade()` + `runDowngradeOnce()` + `resolveDowngradeUrl()`)
- Test: `test/herdr-downgrade.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `supportFlags`, Task 2's `herdrAssetKey`/`herdrReleaseUrl`/`buildDowngradeScript`, existing `sanitizeVersion`, `HERDR_LAST_SUPPORTED_VERSION`, `isHerdrVersionSupported`, `setDetectedHerdrVersion`, `compareSemver`.
- Produces (Task 4 relies on these):
  - `HerdrUpdateService.downgrade(): { started: boolean }` — sync, 202-style fire-and-forget like `apply()`.
  - New dep for tests: `runDowngrade?: (script: string, onLine: (line: string) => void, signal: AbortSignal) => Promise<void>`.
  - `export interface HerdrManifest { version: string; notes?: string; releases?: Record<string, { assets?: Record<string, string> }> }` — `fetchLatest` now returns this (strictly wider than before; existing callers unaffected).

- [ ] **Step 1: Write the failing tests**

Append to `test/herdr-downgrade.test.ts`:

```ts
import { HerdrUpdateService, type HerdrUpdateResult } from "../src/herdr-update";
import { detectedHerdrVersion } from "../src/herdr-capabilities";

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
```

Note: the second `import` block must merge into the file's existing imports (one import statement per module — extend the Task 2 import list with `HerdrUpdateService` and `type HerdrUpdateResult`, and add the `detectedHerdrVersion` import at the top).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./test/herdr-downgrade.test.ts`
Expected: new tests FAIL (no `downgrade` method / unknown `runDowngrade` dep). Task 2 tests still PASS.

- [ ] **Step 3: Implement**

In `src/herdr-update.ts`:

**(a)** Add the manifest type above `HerdrUpdateDeps` and widen `fetchLatest`:

```ts
/** Subset of herdr.dev/latest.json Shepherd reads: the latest release (version/notes)
 *  plus the per-version `releases` map used to resolve versioned artifacts (#1898). */
export interface HerdrManifest {
  version: string;
  notes?: string;
  releases?: Record<string, { assets?: Record<string, string> }>;
}
```

In `HerdrUpdateDeps`, change the `fetchLatest` line to:

```ts
  /** inject point for tests; defaults to fetching herdr.dev/latest.json */
  fetchLatest?: () => Promise<HerdrManifest>;
```

and add after `runUpdate`:

```ts
  /**
   * Run the downgrade child for the given script, streaming output to onLine,
   * resolving on exit (#1898). Same watchdog semantics as runUpdate. Default:
   * spawn `bash -lc <script>`.
   */
  runDowngrade?: (
    script: string,
    onLine: (line: string) => void,
    signal: AbortSignal,
  ) => Promise<void>;
```

**(b)** In the class: change the private `fetchLatest` field type to `() => Promise<HerdrManifest>` and its constructor default's cast to `r.json() as Promise<HerdrManifest>`. Add the field + constructor wiring for `runDowngrade`:

```ts
  private runDowngrade: (
    script: string,
    onLine: (line: string) => void,
    signal: AbortSignal,
  ) => Promise<void>;
```

```ts
    this.runDowngrade =
      deps.runDowngrade ?? ((script, onLine, signal) => this.spawnScript(script, onLine, signal));
```

**(c)** Extract the child-spawning body of `defaultRunUpdate` into `spawnScript` (the update path keeps building its script; the downgrade path passes one in):

```ts
  /** Spawn `bash -lc <script>` in shepherd's own process tree (NOT detached —
   *  there is no longer a shepherd restart to outlive), stream stdout+stderr to
   *  onLine, resolve on exit. The signal (watchdog) force-kills a hung child. */
  private defaultRunUpdate(onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
    const script = buildUpdateScript(
      config.herdrUpdateLogPath,
      this.last?.current,
      this.last?.latest,
    );
    return this.spawnScript(script, onLine, signal);
  }

  private spawnScript(
    script: string,
    onLine: (line: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn("bash", ["-lc", script], { stdio: ["ignore", "pipe", "pipe"] });
      const kill = () => child.kill("SIGKILL");
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });

      let buf = "";
      const handleChunk = (chunk: Buffer | string) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (trimmed) onLine(trimmed);
        }
      };
      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", handleChunk);
      const finish = () => {
        signal.removeEventListener("abort", kill);
        if (buf.trim()) onLine(buf.trim());
        resolve();
      };
      child.on("exit", finish);
      child.on("error", (err) => {
        onLine(`herdr update spawn failed: ${err.message}`);
        finish();
      });
    });
  }
```

(This is the existing `defaultRunUpdate` body relocated verbatim — only the script construction stays behind in `defaultRunUpdate`.)

**(d)** Add `downgrade()` + helpers after `apply()`:

```ts
  /** Resolve the versioned artifact URL for `target`: the hardcoded template AND the
   *  manifest's releases entry must agree (user-chosen trust model, #1898). Throws a
   *  human-readable error on any mismatch — surfaced via onDone into the modal. */
  private async resolveDowngradeUrl(target: string): Promise<string> {
    const assetKey = herdrAssetKey();
    if (!assetKey) {
      throw new Error(`no herdr binary published for ${process.platform}/${process.arch}`);
    }
    const templateUrl = herdrReleaseUrl(target, assetKey);
    const manifest = await this.fetchLatest();
    const manifestUrl = manifest?.releases?.[target]?.assets?.[assetKey];
    if (!manifestUrl) {
      throw new Error(`herdr.dev manifest has no ${target} asset for ${assetKey}`);
    }
    if (manifestUrl !== templateUrl) {
      throw new Error(
        `refusing downgrade: manifest URL ${manifestUrl} does not match the expected ${templateUrl}`,
      );
    }
    return templateUrl;
  }

  /** Kick off the in-app downgrade to HERDR_LAST_SUPPORTED_VERSION in the background
   *  (#1898). Mirrors apply(): returns immediately for a 202, streams progress via
   *  onLog, terminal outcome via onDone. Refuses when the installed version is
   *  already supported (nothing to rescue) or while a run is in flight. */
  downgrade(): { started: boolean } {
    if (this.applying) return { started: false };
    const current = this.last?.current ?? null;
    if (isHerdrVersionSupported(current)) {
      console.warn(
        `[herdr-update] refusing downgrade: installed herdr ${current ?? "?"} is already supported`,
      );
      return { started: false };
    }
    this.applying = true;
    console.warn(
      `[herdr-update] downgrading ${current} -> ${HERDR_LAST_SUPPORTED_VERSION}; ` +
        `Shepherd stays up (audit log: ${config.herdrUpdateLogPath})`,
    );
    void this.runDowngradeOnce(current);
    return { started: true };
  }

  /** Background body of downgrade(): resolve+cross-check the artifact URL, run the
   *  script under the watchdog, decide success from a re-read version, refresh the
   *  spawn guard, and ALWAYS clear maintenance + the applying guard (same contract
   *  as runOnce — begin() inside the try, matching end() in finally). */
  private async runDowngradeOnce(from: string | null): Promise<void> {
    const to = HERDR_LAST_SUPPORTED_VERSION;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let result: HerdrUpdateResult;
    try {
      this.maintenance.begin();
      const url = await this.resolveDowngradeUrl(to);
      const script = buildDowngradeScript(config.herdrUpdateLogPath, from, to, url);
      const ctrl = new AbortController();
      watchdog = setTimeout(() => ctrl.abort(), this.watchdogMs);
      await this.runDowngrade(script, (line) => this.onLog(line), ctrl.signal);
      const after = this.actualVersion(from);
      // the script swapped the binary — refresh the ceiling the spawn guard reads
      setDetectedHerdrVersion(after);
      if (ctrl.signal.aborted) {
        result = { ok: false, from, to: after, error: "herdr downgrade timed out" };
      } else {
        const ok = !!after && after === to;
        const latest = this.last?.latest ?? null;
        const updateAvailable = !!after && !!latest && compareSemver(latest, after) > 0;
        this.last = {
          current: after,
          latest,
          updateAvailable,
          latestUnsupported: updateAvailable && !isHerdrVersionSupported(latest),
          ...supportFlags(after),
          notes: this.last?.notes ?? null,
          checkedAt: Date.now(),
          error: ok ? undefined : "herdr was not downgraded",
        };
        this.onStatus(this.last);
        result = ok
          ? { ok: true, from, to }
          : { ok: false, from, to: after, error: "herdr was not downgraded" };
      }
    } catch (err) {
      // URL resolution / cross-check / spawn failed — the binary was never touched;
      // report what we're actually on (never the target).
      result = {
        ok: false,
        from,
        to: this.actualVersion(from),
        error: err instanceof Error ? err.message : "herdr downgrade failed",
      };
    } finally {
      clearTimeout(watchdog);
      this.maintenance.end();
      this.applying = false;
    }
    this.onDone(result);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/herdr-downgrade.test.ts && bun test ./test/herdr-update.test.ts && bun run lint`
Expected: ALL PASS (update-script tests confirm the `spawnScript` extraction broke nothing), lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/herdr-update.ts test/herdr-downgrade.test.ts
git commit -m "feat(herdr): drive the in-app downgrade from HerdrUpdateService (#1898)

Claude-Session: https://claude.ai/code/session_011dMVhqvxyxZY4S2ALHCHqj"
```

---

### Task 4: HTTP endpoint + UI API client

**Files:**
- Modify: `src/server.ts` (`handleHerdrUpdate`, ~line 4201)
- Modify: `ui/src/lib/api.ts` (below `applyHerdrUpdate`, ~line 1588)

**Interfaces:**
- Consumes: `HerdrUpdateService.downgrade()` (Task 3), `HerdrUpdateStatus.currentUnsupported` (Task 1).
- Produces: `POST /api/herdr-update/downgrade` → `202 {ok:true}` | `409` | `503`; `export async function applyHerdrDowngrade(): Promise<void>` in `ui/src/lib/api.ts` (Task 5's modal calls this exact name).

No new test file: the gate logic lives in the service (covered in Task 3); the handler mirrors `handleCodexUpdate`/`handleHerdrUpdate`, which have no HTTP-layer tests either (codebase pattern). Coverage of the client function comes from Task 5's browser test mock.

- [ ] **Step 1: Extend the handler**

In `src/server.ts`, replace the first two lines of `handleHerdrUpdate` so the sub-path is handled before the exact-path guard:

```ts
// ── herdr update: status + (destructive) apply + stranded-install downgrade ────
function handleHerdrUpdate({ req, parts, deps }: Ctx): Response | null {
  if (!(parts[0] === "api" && parts[1] === "herdr-update")) return null;
  // POST /api/herdr-update/downgrade — rescue an install stranded on an unsupported
  // herdr (0.7.5+, #1898) by installing the highest supported version. The service
  // re-guards; this is the HTTP backstop against a direct POST (mirrors apply()'s
  // latestUnsupported refusal).
  if (parts[2] === "downgrade" && !parts[3]) {
    if (req.method !== "POST") return null;
    if (!deps.herdrUpdates) return json({ error: "herdr updates not available" }, 503);
    if (!deps.herdrUpdates.current()?.currentUnsupported) {
      return json({ error: "installed herdr is already supported" }, 409);
    }
    const r = deps.herdrUpdates.downgrade();
    return json({ ok: r.started }, r.started ? 202 : 409);
  }
  if (parts[2]) return null;
  // …existing GET/POST body unchanged…
```

- [ ] **Step 2: Add the API client function**

In `ui/src/lib/api.ts`, directly after `applyHerdrUpdate`:

```ts
/** Trigger the in-app herdr downgrade to the highest supported version — the rescue
 *  for installs stranded on an unsupported herdr (0.7.5+, #1898). Restarts the herdr
 *  server; Shepherd stays up. */
export async function applyHerdrDowngrade(): Promise<void> {
  const r = await fetch("/api/herdr-update/downgrade", { method: "POST", headers: JSON_HEADERS });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw apiError(r.status, msg as { error?: string }, `error ${r.status}`);
  }
}
```

- [ ] **Step 3: Verify**

Run: `bun run lint && bun test ./test/herdr-update.test.ts ./test/herdr-downgrade.test.ts && cd ui && bun run check && cd ..`
Expected: lint + svelte-check clean, tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts ui/src/lib/api.ts
git commit -m "feat(herdr): POST /api/herdr-update/downgrade endpoint + API client (#1898)

Claude-Session: https://claude.ai/code/session_011dMVhqvxyxZY4S2ALHCHqj"
```

---

### Task 5: Downgrade action in `HerdrUpdateModal` (+ modal i18n, + overlay gate)

**Files:**
- Modify: `ui/src/lib/components/HerdrUpdateModal.svelte`
- Modify: `ui/src/lib/components/page/AppOverlays.svelte:459` (render gate)
- Modify: `ui/messages/en.json`, `ui/messages/de.json`
- Test: `ui/src/lib/components/HerdrUpdateModal.browser.test.ts` (append)

**Interfaces:**
- Consumes: `applyHerdrDowngrade` from `$lib/api` (Task 4), `update.currentUnsupported`/`update.downgradeTarget` (Task 1).
- Produces: modal renders a `.run.downgrade` button when stranded; reuses the existing `onconfirm`/`log`/`done` plumbing unchanged (no `+page.svelte` changes needed).

- [ ] **Step 1: Write the failing browser tests**

In `ui/src/lib/components/HerdrUpdateModal.browser.test.ts`, extend the `vi.mock` factory with the downgrade mock (add the line inside the returned object):

```ts
vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  applyHerdrUpdate: vi.fn(() => new Promise(() => {})),
  applyHerdrDowngrade: vi.fn(() => new Promise(() => {})),
}));
```

Append inside the `describe` block:

```ts
  it("offers the one-click downgrade when the INSTALLED herdr is unsupported (#1898)", async () => {
    const { applyHerdrDowngrade } = await import("$lib/api");
    render(HerdrUpdateModal, {
      props: {
        update: {
          current: "0.7.5",
          latest: "0.7.5",
          updateAvailable: false,
          currentUnsupported: true,
          downgradeTarget: "0.7.4",
          notes: null,
          checkedAt: 0,
        },
      },
    });

    // The stranded explanation is shown…
    expect(document.querySelector(".blocked")).not.toBeNull();
    // …the downgrade action names the target version…
    const btn = document.querySelector<HTMLButtonElement>(".run.downgrade");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("0.7.4");
    // …and there is NO plain upgrade button (nothing to upgrade to).
    expect(document.querySelector(".run:not(.downgrade)")).toBeNull();

    // Clicking it fires the downgrade endpoint.
    btn!.click();
    await vi.waitFor(() => expect(vi.mocked(applyHerdrDowngrade)).toHaveBeenCalledOnce());
  });

  it("keeps the plain upgrade flow free of the downgrade action", () => {
    render(HerdrUpdateModal, { props: { update } }); // the ordinary 0.6.9→0.6.10 fixture
    expect(document.querySelector(".run.downgrade")).toBeNull();
    expect(document.querySelector(".run")).not.toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test -- HerdrUpdateModal && cd ..`
Expected: the two new tests FAIL (no `.run.downgrade`), existing ones PASS.

- [ ] **Step 3: Add the i18n keys**

Add to `ui/messages/en.json` (alphabetical/nearby the other `herdrupdate_` keys):

```json
"herdrupdate_downgrade_confirm": "Downgrade to {target}",
"herdrupdate_downgrade_done_ok": "Downgraded to {target}. Agent spawning works again — no Shepherd restart needed.",
"herdrupdate_downgrade_instructions": "Downgrading downloads the highest supported herdr release, verifies it, swaps the binary, and restarts the herdr server. Shepherd keeps running, no page reload.",
"herdrupdate_downgrade_title": "herdr downgrade required",
"herdrupdate_stranded_body": "Shepherd cannot spawn agents on herdr {current} (its `agent start` was reshaped; see issue #1889). Downgrading to {target} restores spawning immediately — no Shepherd restart.",
"herdrupdate_stranded_title": "This herdr cannot spawn agents — downgrade to recover",
```

Add to `ui/messages/de.json`:

```json
"herdrupdate_downgrade_confirm": "Auf {target} downgraden",
"herdrupdate_downgrade_done_ok": "Auf {target} downgegradet. Agenten lassen sich wieder starten — kein Shepherd-Neustart nötig.",
"herdrupdate_downgrade_instructions": "Das Downgrade lädt das höchste unterstützte herdr-Release herunter, verifiziert es, tauscht das Binary und startet den herdr-Server neu. Shepherd läuft weiter, kein Neuladen der Seite.",
"herdrupdate_downgrade_title": "herdr-Downgrade erforderlich",
"herdrupdate_stranded_body": "Shepherd kann auf herdr {current} keine Agenten starten (`agent start` wurde umgebaut; siehe Issue #1889). Ein Downgrade auf {target} stellt das Starten sofort wieder her — kein Shepherd-Neustart.",
"herdrupdate_stranded_title": "Dieses herdr kann keine Agenten starten — Downgrade zur Wiederherstellung",
```

- [ ] **Step 4: Implement the modal changes**

In `ui/src/lib/components/HerdrUpdateModal.svelte`:

**(a)** Script — change the api import and add state + handler below the existing `confirm()`:

```ts
import { applyHerdrUpdate, applyHerdrDowngrade } from "$lib/api";
```

```ts
  // Stranded install (#1898): the INSTALLED herdr is unsupported — the modal's job
  // flips from "offer the upgrade" to "offer the rescue downgrade".
  const stranded = $derived(!!update.currentUnsupported);
  // Which flavor ran, so the ✓ message reads "Downgraded…" instead of "Updated…".
  let downgrading = $state(false);

  async function confirmDowngrade() {
    submitting = true;
    downgrading = true;
    error = null;
    try {
      await applyHerdrDowngrade();
      onconfirm?.();
    } catch (e) {
      error = e instanceof Error ? e.message : "downgrade failed";
      submitting = false;
      downgrading = false;
    }
  }
```

**(b)** Title (both the `aria-label` on the dialog div and the `.micro` span in `.chead`):

```svelte
aria-label={stranded ? m.herdrupdate_downgrade_title() : m.herdrupdate_title()}
```

```svelte
<span class="micro">{stranded ? m.herdrupdate_downgrade_title() : m.herdrupdate_title()}</span>
```

**(c)** Versions summary — replace the existing `{#if update.current && update.latest}` block with:

```svelte
{#if stranded && update.current && update.downgradeTarget}
  <div class="summary">
    <span class="versions"
      >{m.herdrupdate_versions({
        current: update.current,
        latest: update.downgradeTarget,
      })}</span
    >
  </div>
{:else if update.current && update.latest}
  <div class="summary">
    <span class="versions"
      >{m.herdrupdate_versions({
        current: update.current,
        latest: update.latest,
      })}</span
    >
  </div>
{/if}
```

**(d)** Blocked box — replace the `{#if update.latestUnsupported}` block with:

```svelte
{#if stranded}
  <!-- The INSTALLED herdr broke agent spawning (#1898); this modal now offers the
       one-click rescue downgrade instead of a dead end. -->
  <div class="blocked" role="alert">
    <span class="blocked-title">{m.herdrupdate_stranded_title()}</span>
    <span class="blocked-body"
      >{m.herdrupdate_stranded_body({
        current: update.current ?? "?",
        target: update.downgradeTarget ?? "",
      })}</span
    >
  </div>
{:else if update.latestUnsupported}
  <!-- herdr 0.7.5+ broke agent spawning (#1889); Shepherd blocks the in-app upgrade and warns
       instead of offering it. The run button below is hidden while this is set. -->
  <div class="blocked" role="alert">
    <span class="blocked-title">{m.herdrupdate_unsupported_title()}</span>
    <span class="blocked-body"
      >{m.herdrupdate_unsupported_body({ latest: update.latest ?? "" })}</span
    >
  </div>
{/if}
```

**(e)** Release notes are the LATEST version's — noise on a stranded install. Change `{#if update.notes}` to `{#if update.notes && !stranded}`.

**(f)** Instructions line:

```svelte
<div class="instructions">
  {stranded ? m.herdrupdate_downgrade_instructions() : m.herdrupdate_instructions()}
</div>
```

**(g)** Done ✓ message — replace the `{#if done.ok}` inner line:

```svelte
{#if done.ok}
  {downgrading
    ? m.herdrupdate_downgrade_done_ok({ target: done.to ?? "" })
    : m.herdrupdate_done_ok({ latest: done.to ?? update.latest ?? "" })}
{:else}
  {m.herdrupdate_done_fail({ current: done.to ?? update.current ?? "" })}
{/if}
```

**(h)** Actions — replace the run-button block (`{#if !done && !update.latestUnsupported}` … `{/if}`) with:

```svelte
{#if !done && stranded}
  <button type="button" class="run downgrade" onclick={confirmDowngrade} disabled={busy}>
    {m.herdrupdate_downgrade_confirm({ target: update.downgradeTarget ?? "" })}
  </button>
{:else if !done && !update.latestUnsupported}
  <button type="button" class="run" onclick={confirm} disabled={busy}>
    {count > 0 ? m.herdrupdate_confirm({ count }) : m.herdrupdate_confirm_plain()}
  </button>
{/if}
```

(No new CSS: `.downgrade` exists purely as a test/selector hook; the `.run` recipe styles it.)

**(i)** In `ui/src/lib/components/page/AppOverlays.svelte` line 459, the modal today can never open on a stranded install (`updateAvailable` is false when current === latest). Change the gate to:

```svelte
{#if showHerdrUpdate && store.herdrUpdate && (store.herdrUpdate.updateAvailable || store.herdrUpdate.currentUnsupported || herdrUpdating)}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ui && bun run test -- HerdrUpdateModal && bun run check && bun run check:i18n && cd ..`
Expected: ALL PASS, svelte-check + i18n parity clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/components/HerdrUpdateModal.svelte ui/src/lib/components/page/AppOverlays.svelte ui/messages/en.json ui/messages/de.json ui/src/lib/components/HerdrUpdateModal.browser.test.ts
git commit -m "feat(ui): offer the herdr downgrade in the update modal (#1898)

Claude-Session: https://claude.ai/code/session_011dMVhqvxyxZY4S2ALHCHqj"
```

---

### Task 6: Actionable diagnostics hint

**Files:**
- Modify: `ui/src/lib/components/DiagnoseRows.svelte` (new prop + template branch)
- Modify: `ui/src/lib/components/settings/SettingsDiagnosePanel.svelte` (prop pass-through)
- Modify: `ui/src/lib/components/Settings.svelte:1867` (wire to existing `onherdrupdate`)
- Modify: `ui/messages/en.json`, `ui/messages/de.json` (button label + updated hint)
- Test: `ui/src/lib/components/DiagnoseRows.browser.test.ts` (append)

**Interfaces:**
- Consumes: Settings' existing `onherdrupdate?: () => void` prop (its `+page.svelte` handler closes Settings and opens the herdr-update modal — no `+page.svelte` change needed).
- Produces: `DiagnoseRows` prop `onherdrdowngrade?: () => void`; `SettingsDiagnosePanel` prop `onherdrdowngrade?: () => void`.

- [ ] **Step 1: Write the failing browser tests**

Append to `ui/src/lib/components/DiagnoseRows.browser.test.ts` (uses the file's existing `check()` fixture helper):

```ts
describe("herdr downgrade button (#1898)", () => {
  it("offers the downgrade on the stranded-herdr row and fires the callback", async () => {
    const onherdrdowngrade = vi.fn();
    render(DiagnoseRows, {
      props: {
        onherdrdowngrade,
        checks: [
          check({ id: "herdr", state: "error", hintKey: "diagnostics_hint_herdr_unsupported" }),
        ],
      },
    });
    const btn = document.querySelector<HTMLButtonElement>("button.fix");
    expect(btn).not.toBeNull();
    expect(btn!.textContent?.trim()).toBe(m.diagnostics_herdr_downgrade());
    btn!.click();
    expect(onherdrdowngrade).toHaveBeenCalledOnce();
  });

  it("renders NO downgrade button without the callback, and none on other herdr states", () => {
    render(DiagnoseRows, {
      props: {
        checks: [
          check({ id: "herdr", state: "error", hintKey: "diagnostics_hint_herdr_unsupported" }),
        ],
      },
    });
    expect(document.querySelector("button.fix")).toBeNull();

    document.body.innerHTML = "";
    render(DiagnoseRows, {
      props: {
        onherdrdowngrade: vi.fn(),
        checks: [check({ id: "herdr", state: "ok", hintKey: "diagnostics_hint_herdr_ok" })],
      },
    });
    expect(document.querySelector("button.fix")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && bun run test -- DiagnoseRows && cd ..`
Expected: new tests FAIL (`m.diagnostics_herdr_downgrade` missing / no button), existing PASS.

- [ ] **Step 3: Add the i18n keys and update the hint**

`ui/messages/en.json` — add, and REPLACE the existing `diagnostics_hint_herdr_unsupported` value:

```json
"diagnostics_herdr_downgrade": "Downgrade herdr…",
"diagnostics_hint_herdr_unsupported": "This herdr version is not supported — Shepherd cannot spawn agents on herdr 0.7.5+ (its `agent start` was reshaped; see issue #1889). Use Downgrade herdr to return to the highest supported version in one click, or pin herdr manually (https://herdr.dev), then re-run Diagnose.",
```

`ui/messages/de.json` — add / replace:

```json
"diagnostics_herdr_downgrade": "herdr downgraden…",
"diagnostics_hint_herdr_unsupported": "Diese herdr-Version wird nicht unterstützt — Shepherd kann auf herdr 0.7.5+ keine Agenten starten (`agent start` wurde umgebaut; siehe Issue #1889). Nutze „herdr downgraden“, um mit einem Klick zur höchsten unterstützten Version zurückzukehren, oder fixiere herdr manuell (https://herdr.dev) und führe die Diagnose erneut aus.",
```

- [ ] **Step 4: Implement**

**(a)** `ui/src/lib/components/DiagnoseRows.svelte` — add the prop to the `$props()` destructuring + type:

```ts
  let {
    checks,
    failed = false,
    onretry,
    onfix,
    onherdrdowngrade,
  }: {
    checks: DiagnosticCheck[] | null;
    failed?: boolean;
    onretry?: () => void;
    /** Parent-owned: run the check's remediation, update state, surface failure toast. */
    onfix?: (checkId: string) => Promise<void>;
    /** Parent-owned: open the herdr-update modal, which offers the one-click
     *  downgrade for an install stranded on an unsupported herdr (#1898). */
    onherdrdowngrade?: () => void;
  } = $props();
```

Template — insert a new first branch before `{#if onfix && fixable(check)}` (making it an `{:else if …}`):

```svelte
        {#if check.hintKey === "diagnostics_hint_herdr_unsupported" && onherdrdowngrade}
          <!-- Stranded herdr (#1898): the fix is the in-app downgrade, owned by the
               herdr-update modal — this button just routes there. -->
          <div class="fix-wrap">
            <button type="button" class="fix micro" onclick={() => onherdrdowngrade?.()}>
              {m.diagnostics_herdr_downgrade()}
            </button>
          </div>
        {:else if onfix && fixable(check)}
```

**(b)** `ui/src/lib/components/settings/SettingsDiagnosePanel.svelte` — add the prop and pass it through:

```ts
  let {
    initialDiagnostics = null,
    onherdrdowngrade,
  }: {
    /** Pre-seeded diagnostics checks from the store; loaded fresh on tab open if absent. */
    initialDiagnostics?: DiagnosticCheck[] | null;
    /** Open the herdr-update modal (one-click downgrade for a stranded herdr, #1898). */
    onherdrdowngrade?: () => void;
  } = $props();
```

```svelte
<DiagnoseRows checks={diagChecks} onfix={fixCheck} {onherdrdowngrade} />
```

**(c)** `ui/src/lib/components/Settings.svelte` line 1867 — reuse the existing modal-opening callback:

```svelte
      <SettingsDiagnosePanel {initialDiagnostics} onherdrdowngrade={() => onherdrupdate?.()} />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ui && bun run test -- DiagnoseRows && bun run check && bun run check:i18n && cd ..`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/components/DiagnoseRows.svelte ui/src/lib/components/settings/SettingsDiagnosePanel.svelte ui/src/lib/components/Settings.svelte ui/messages/en.json ui/messages/de.json ui/src/lib/components/DiagnoseRows.browser.test.ts
git commit -m "feat(ui): actionable downgrade from the herdr diagnostics hint (#1898)

Claude-Session: https://claude.ai/code/session_011dMVhqvxyxZY4S2ALHCHqj"
```

---

### Task 7: Feature-catalog entry

**Files:**
- Create: `ui/src/lib/feature-announcements/entries/v1.45.0-herdr-downgrade.ts`
- Modify: `ui/messages/en.json`, `ui/messages/de.json`

**Interfaces:**
- Consumes: `FeatureAnnouncement` type from `../../feature-announcements`.
- Produces: catalog entry `id: "herdr-downgrade"` — satisfies the `check-feature-catalog.sh` gate for this branch's `feat(ui)` commits.

- [ ] **Step 1: Confirm the next version**

Run: `bun run next-version`
Expected: `1.45.0`. If it prints something else, use THAT value for the filename and `sinceVersion` below.

- [ ] **Step 2: Create the entry**

`ui/src/lib/feature-announcements/entries/v1.45.0-herdr-downgrade.ts`:

```ts
import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  id: "herdr-downgrade",
  sinceVersion: "1.45.0",
  titleKey: "feat_herdr_downgrade_title",
  bodyKey: "feat_herdr_downgrade_body",
} satisfies FeatureAnnouncement;

export default entry;
```

- [ ] **Step 3: Add the i18n keys**

`ui/messages/en.json`:

```json
"feat_herdr_downgrade_title": "Stranded on a broken herdr? One-click downgrade",
"feat_herdr_downgrade_body": "If herdr auto-updated into a version Shepherd cannot drive (0.7.5+ broke agent spawning), Shepherd now heals itself: the herdr-update dialog and the Diagnose tab offer a one-click downgrade to the highest supported version — downloaded, verified, swapped and restarted entirely in-app, with a step-by-step audit log.",
```

`ui/messages/de.json`:

```json
"feat_herdr_downgrade_title": "Auf kaputtem herdr gestrandet? Downgrade mit einem Klick",
"feat_herdr_downgrade_body": "Wenn herdr sich per Auto-Update auf eine Version aktualisiert hat, die Shepherd nicht ansteuern kann (0.7.5+ hat das Starten von Agenten kaputt gemacht), heilt sich Shepherd jetzt selbst: Update-Dialog und Diagnose-Tab bieten ein Ein-Klick-Downgrade auf die höchste unterstützte Version — heruntergeladen, verifiziert, getauscht und neu gestartet komplett in der App, mit Schritt-für-Schritt-Audit-Log.",
```

- [ ] **Step 4: Verify the gates**

Run: `cd ui && bun run check:i18n && bun run check && cd .. && node scripts/check-announcement-versions.mjs`
Expected: all clean (the version script checks entries added in the branch range against `.release-please-manifest.json`).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/feature-announcements/entries/v1.45.0-herdr-downgrade.ts ui/messages/en.json ui/messages/de.json
git commit -m "feat(ui): announce the herdr downgrade rescue in the feature catalog (#1898)

Claude-Session: https://claude.ai/code/session_011dMVhqvxyxZY4S2ALHCHqj"
```

---

### Task 8: Full verification sweep

**Files:** none (verification only; fix-forward anything found, amending or adding atomic commits).

- [ ] **Step 1: Root suite**

Run: `bun test ./test`
Expected: everything passes EXCEPT the known environmental `pty-attach` failure (test/pty-bridge.test.ts — node-pty native build; pre-existing, ignore).

- [ ] **Step 2: UI suite + checks**

Run: `cd ui && bun run test && bun run check && bun run check:i18n && cd ..`
Expected: ALL PASS (baseline was 4190 tests; now more).

- [ ] **Step 3: Lint + hygiene gates**

Run: `bun run lint && bash scripts/check-branch-hygiene.sh && bash scripts/check-feature-catalog.sh && node scripts/check-announcement-versions.mjs && node scripts/check-glossary.mjs`
Expected: all clean (no merge commits; `feat(ui)` commits paired with the catalog entry; glossary untouched).

- [ ] **Step 4: Prettier check on all touched files**

Run: `git diff --name-only origin/main...HEAD | grep -E '\.(ts|svelte|json|md)$' | xargs bunx prettier --check`
Expected: "All matched files use Prettier code style!"

---

## Self-review notes (spec ↔ plan)

- Spec §1 (script, ordering, no-handoff, log) → Task 2. Spec §1 (service, guards, watchdog, spawn-guard refresh) → Task 3. Spec decision 1 (template + manifest cross-check) → Task 3 `resolveDowngradeUrl` + divergence tests. Spec §2 (endpoint) → Task 4. Spec §3 (status fields) → Task 1. Spec §4 (modal) → Task 5. Spec §5 + decision 2 (diagnostics → modal) → Task 6. Spec §6 (i18n/catalog) → Tasks 5–7. Spec acceptance tests (happy path / refusal-when-supported / sanitization) → Tasks 2–3.
- Deliberately NOT in scope (matches spec): no topbar-badge surfacing for the stranded state, no Settings CTA row, no `+page.svelte` changes (existing `onconfirm`/`onclose` handlers and the Settings→modal callback chain are reused).
