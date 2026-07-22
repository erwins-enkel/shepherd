# In-app herdr downgrade to the highest supported version — Design

**Issue:** #1898 · **Date:** 2026-07-22 · **Status:** approved

## Problem

Installations that reached herdr 0.7.5+ **before** the #1887 guard shipped (or via an
out-of-band `herdr update`) are stranded: every spawn refuses with
`HerdrSpawnUnsupportedError`, and the only remediation Shepherd offers is advice text —
"Pin herdr to 0.7.4, then re-run Diagnose" — executed manually, outside Shepherd. Until
epic #1889 lands real 0.7.5 support, an affected installation can diagnose its breakage
but cannot heal it.

This feature adds a one-click, in-app downgrade to the highest supported herdr version,
surfaced where Shepherd already tells the operator they are stranded.

## Verified upstream facts (2026-07-22)

herdr offers **no** downgrade of its own; we build the whole flow:

- `herdr update` is latest-only (verified against 0.7.5 in #1898): sole option is
  `--handoff`, no version flag.
- `herdr.dev/install.sh` is latest-only (verified live): it reads `latest.json`, picks
  the top-level (latest) `assets` block; no version argument.
- **But**: `https://herdr.dev/latest.json` carries a `releases` map — all versions
  0.1.0 → 0.7.5, each with per-platform binary URLs of the fixed shape
  `https://github.com/ogulcancelik/herdr/releases/download/v<version>/herdr-<os>-<arch>`.
  The v0.7.4 `linux-x86_64` asset is live (HTTP 200, ~19 MB). This is the same manifest
  `herdr update` and `install.sh` already trust, so no upstream coordination is needed.

## Decisions (user-confirmed)

1. **URL trust model — template + manifest cross-check.** The download URL is built from
   the hardcoded template above with a `sanitizeVersion()`-cleaned target, **and** must
   byte-equal `releases[<target>].assets[<os>-<arch>]` from a fresh `latest.json` fetch.
   Divergence or a missing entry → refuse with a clear error before touching anything.
   Strongest guarantee; accepted trade-off: manifest drift or an unreachable herdr.dev
   blocks the button (the text hint remains as the manual fallback).
2. **Diagnostics UX — open the modal.** The diagnostics row gets a button that opens
   `HerdrUpdateModal` (which owns confirm, live log, ✓/✗ outcome) instead of firing the
   downgrade inline. One flow, one implementation; no destructive action without the
   modal's explicit confirm.

## Design

### 1. Server — `src/herdr-update.ts`

**`buildDowngradeScript(logPath, from, to, url, herdrBin)`** — new, exported for tests,
sibling of `buildUpdateScript`. Appends one delimited block to
`~/.shepherd/herdr-update.log` (same `>>> herdr-update:` step markers, `tee -a`, explicit
exit codes). Ordering is safety-critical — the running server is only touched **after** a
verified binary is in place, so a failed attempt leaves the installation exactly as
broken as it was, never more broken:

1. `curl -fsSL` the asset URL to a temp file **next to the binary**
   (`<herdrBin>.downgrade.$$` — same filesystem so the later swap is an atomic `mv`),
   then `chmod +x`.
2. Verify: run `<tmp> --version`; output must contain the target version. Mismatch or
   corrupt download → abort, old binary untouched.
3. Atomic `mv` over `herdrBin`.
4. `herdr server stop`, then the existing grace+retry `agent list` loop (a systemd
   `Restart=always` unit wins the race on provisioned hosts), then the existing
   `setsid herdr server` fallback for hand-rolled installs. **No `--handoff`**: on a
   stranded install the #1887 guard has refused every spawn, so there are no live agent
   panes to preserve.

**`HerdrUpdateService.downgrade()`** — mirrors `apply()`: same `applying` double-launch
guard, maintenance gate, watchdog, `onLog`/`onStatus`/`onDone` plumbing. Success is
decided by a re-read `herdr --version === target` (never the child's exit code);
`setDetectedHerdrVersion(after)` refreshes the spawn guard's ceiling immediately — no
Shepherd restart. Refuses (`{ started: false }`) when the installed version is already
supported or a run is in flight.

**Target + URL resolution:** target = `HERDR_LAST_SUPPORTED_VERSION` from
`herdr-capabilities.ts` — never a literal, so the button stays correct when the ceiling
moves. Platform key from `process.platform`/`process.arch`
(`linux|darwin → linux|macos`, `x64|arm64 → x86_64|aarch64`); unsupported combos refuse.
The URL is additionally shell-quoted via the existing `shq` when embedded — defense in
depth on top of the template guarantee.

### 2. HTTP — `POST /api/herdr-update/downgrade`

Sub-path beside `handleHerdrUpdate` (follows the `/api/plugin-update/apply` precedent).
`202` on start, `409` when already supported or already applying, `503` when the service
is absent. The server-side gate is the backstop against a direct POST — same pattern as
`apply()`'s `latestUnsupported` refusal. #1887 upgrade-refusal behavior is untouched.

### 3. Status shape — `HerdrUpdateStatus` (src/types.ts + ui mirror)

Two new fields, computed in `check()` and after apply/downgrade:

- `currentUnsupported?: boolean` — installed version fails `isHerdrVersionSupported`.
- `downgradeTarget?: string | null` — the supported ceiling, set when stranded.

The UI never re-derives version policy; it renders what the server computed.

### 4. UI — `HerdrUpdateModal.svelte`

When `update.currentUnsupported`, the existing red "blocked" block becomes actionable:
explanation + a **"Downgrade to {target}"** run button (destructive styling, existing
tokens/recipes only). Busy / streamed log / ✓✗ terminal states reuse the modal's existing
`herdr-update:log|status|done` WebSocket plumbing unchanged. The upgrade path
(`latestUnsupported` warning, hidden run button) stays as-is. New `applyHerdrDowngrade()`
in `ui/src/lib/api.ts`.

### 5. UI — diagnostics (`DiagnoseRows.svelte`)

The herdr row, when `hintKey === "diagnostics_hint_herdr_unsupported"`, shows a button
that opens the HerdrUpdateModal (event bubbles up to the modal's owner, AppOverlays).
Hint text updated to point at the in-app fix; it remains the fallback when the flow
refuses (e.g. manifest unreachable).

### 6. i18n, feature catalog

- All new strings EN + DE (`ui/messages/en.json` + `de.json`; `check:i18n` gate). No new
  glossary-worthy terms anticipated.
- One feature-catalog fragment `ui/src/lib/feature-announcements/entries/v<next>-herdr-downgrade.ts`
  with `<next>` from `bun run next-version` (version gate compliant), framed per the
  issue as the general "install a pinned supported version" rescue lever.

## Failure modes

| Failure | Outcome |
| --- | --- |
| `latest.json` unreachable / cross-check divergent / release entry missing | Refuse before touching anything; clear error in the modal; text hint = manual fallback |
| Download fails / `--version` verify fails | Old binary still installed and server still running (never stopped early); error logged + reported |
| Watchdog timeout | Child killed; actual version re-read and reported — never claims the target |
| `herdr server stop` + no systemd unit | Existing `setsid herdr server` fallback relaunches a detached server |

## Testing

- `test/herdr-update.test.ts` + script tests mirroring `buildUpdateScript`'s:
  - downgrade happy path (injected `versionRunner`/`fetchLatest`/`runUpdate`)
  - refusal when already supported; refusal while a run is in flight
  - `sanitizeVersion` on a poisoned target version
  - URL cross-check divergence → refusal
  - platform mapping incl. unsupported-combo refusal
  - script sequencing: swap only after verify; server stop only after swap
- UI: extend `HerdrUpdateModal.browser.test.ts` for the stranded (`currentUnsupported`)
  state; diagnostics row button presence.

## Acceptance criteria mapping (#1898)

| Criterion | Where |
| --- | --- |
| Stranded install recovers entirely from the UI | Modal + diagnostics button (§4, §5) |
| Step-by-step log + immediate spawn-guard refresh | `buildDowngradeScript` log block; `setDetectedHerdrVersion` (§1) |
| Upgrade-refusal (#1887) unchanged | §2 — `apply()` path untouched |
| Regression tests: happy path, refusal-when-supported, sanitization | Testing section |
