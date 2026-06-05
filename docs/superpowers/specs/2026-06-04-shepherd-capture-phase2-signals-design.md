# Shepherd Capture — Phase 2: capture signals + per-signal toggles (design)

**Issue:** #338 (follow-up to #308 / #336). **Phase 1 spec:** `2026-06-04-shepherd-capture-extension-design.md`.

This is the **first sub-phase** of #338's deferred scope. It covers the
**Signals bundle**: console-error capture, failed-network capture, axe-core a11y
audit, and per-signal toggles (including making the screenshot itself optional).

The remaining #338 items — GitHub-issue delivery, URL→repo rules, element picker,
full-page stitch, keyboard shortcut, standalone remote-host support, toolbar
icons — are **out of scope** here and stay tracked for later sub-phases. (Note:
the optional-permission machinery built here is the same pattern remote-host
support will reuse.)

---

## Goal

Let a capture attach richer, optional, page-derived context — recent console
errors, failed network requests, and accessibility findings — and let the user
choose which signals to attach. Every page-derived string flows through the
existing `sanitize()` before entering the `text`-fenced context block, so the
prompt-injection / fence-breakout boundary is preserved.

## Non-goals

- No new delivery target (still spawn-now via `/api/uploads` → `/api/sessions`).
- No URL→repo routing, element picker, full-page stitch, hotkey, or icons.
- No remote-host (`ts.net`) support as a feature — but the optional-host-permission
  flow it needs is introduced here for the recorder.

---

## The core constraint: retroactivity vs. permissions

The valuable console errors / failed requests for a bug report are the ones that
happened **before** the user clicked the toolbar icon. Chrome exposes **no API to
read console or network history** — you can only observe them going forward. So
retroactive capture requires an **always-on recorder**: a content script that
runs at `document_start` and keeps a bounded ring buffer on the page. That needs
broad host access (`<all_urls>`), which Phase 1 deliberately avoided (it uses
only `activeTab`, granted per-click).

**Resolution (decided):** the recorder is **opt-in behind an optional host
permission**. Console/network signals ship **off**. Enabling either one (in
Options only) requests `<all_urls>` via `chrome.permissions.request` and
registers the recorder; disabling both unregisters it and releases the
permission. The default install footprint is unchanged. a11y and screenshot need
no new permission — they run on-demand against the active tab only.

---

## Permission posture

| Permission | Phase 1 | Phase 2 |
| --- | --- | --- |
| `activeTab`, `scripting`, `tabs`, `storage` | ✓ | ✓ (unchanged) |
| `host_permissions: http://localhost:7330/*` | ✓ | ✓ (unchanged) |
| `optional_host_permissions: ["<all_urls>"]` | — | **new** — requested only when console/network enabled |

The recorder content script is registered dynamically with
`chrome.scripting.registerContentScripts` (not declared in the manifest), so it
exists only while the user has opted in and granted the permission.

---

## Decided defaults

- **Signal defaults:** screenshot **on**; console **off**; network **off**;
  a11y **off**. (a11y is off because it adds latency + sizable output to every
  capture; it needs no permission, so the user can flip it on freely.)
- **Toggle surface:** console/network are enabled **only in Options** (where the
  permission + recorder lifecycle lives). The popup shows all four checkboxes;
  screenshot + a11y toggle freely per-capture; console/network appear **disabled
  with an "enable in settings" hint** until the permission is granted.

---

## Architecture

Keeps Phase 1's split: **pure, fetch/chrome-injected, vitest-tested cores** +
**thin `chrome.*` orchestration glue** verified by a manual load-unpacked
checklist. The only genuinely untestable-by-unit part is the page-side install
glue that wraps `console`/`fetch`/`XHR` (it runs in the page MAIN world); its
logic is factored into a pure core that **is** tested.

### New pure modules (TDD)

**`src/lib/signals.ts`** — shared signal types:

```ts
export interface ConsoleEntry {
  level: "error" | "warn";   // console.error/warn + uncaught errors/rejections
  text: string;
  ts: string;                // ISO-8601
}

export interface NetworkEntry {
  method: string;            // GET for resource-load failures
  url: string;
  status: number | "error" | "load-error"; // ≥400, network throw, or resource onerror
  ts: string;
}

export interface A11yFinding {
  id: string;                // axe rule id, e.g. "color-contrast"
  impact: "minor" | "moderate" | "serious" | "critical" | "unknown";
  help: string;              // short human description from axe
  nodeCount: number;
  sampleSelectors: string[]; // ≤3
}

export interface CapturedSignals {
  console?: ConsoleEntry[];
  network?: NetworkEntry[];
  a11y?: A11yFinding[];
}

export interface SignalToggles {
  screenshot: boolean;
  console: boolean;
  network: boolean;
  a11y: boolean;
}
```

**`src/lib/recorder-core.ts`** — pure recorder logic, no `window` access:

- `pushCapped<T>(buf: T[], entry: T, cap: number): void` — ring-buffer push,
  drops oldest past `cap`.
- `isFailedResponse(status: number): boolean` — `status >= 400`.
- `normalizeConsoleArgs(args: unknown[]): string` — join/stringify console args
  to one line.
- helpers to build `NetworkEntry`/`ConsoleEntry` from raw inputs.

These are imported by the page-install glue (below) and unit-tested directly.

**`src/lib/a11y.ts`** — `summarizeAxeResults(raw): A11yFinding[]`:

- Reads axe's `results.violations`, maps each to a compact `A11yFinding`
  (`id`, `impact`, `help`, `nodeCount = nodes.length`, `sampleSelectors` = first
  3 `nodes[].target` joined). Sorts critical→minor, caps to **20** findings.
- Pure: takes the raw axe JSON, returns the array. No `chrome`/DOM.

### Page-side install glue (manual-checklist verified)

**`src/recorder.ts`** — the dynamically-registered content script
(`world: "MAIN"`, `run_at: "document_start"`, matches `<all_urls>`):

- Initializes `window.__shepherdCapture = { console: [], network: [] }` (idempotent).
- Wraps `console.error`/`console.warn` → `pushCapped(... , 30)`.
- `window.addEventListener("error", …)` (uncaught errors **and**, when
  `event.target` is a resource element, a `load-error` `NetworkEntry`).
- `window.addEventListener("unhandledrejection", …)` → console entry.
- Wraps `window.fetch` and `XMLHttpRequest` to record only **failures**
  (`isFailedResponse(status)` or a thrown/network error) as `NetworkEntry`.
- All buffer/classification decisions delegate to `recorder-core.ts`.

The background reads `window.__shepherdCapture` at capture time via
`chrome.scripting.executeScript({ world: "MAIN", func: () => window.__shepherdCapture })`.

### Changed modules

**`src/lib/context-block.ts`** — `formatContextBlock(meta, signals?)`:

- Appends, **inside the same `text` fence**, only the present sections:
  `Console (N):`, `Failed requests (N):`, `Accessibility (N):`. Each line is
  `sanitize()`d; each section capped (see below). Phase-1 callers pass no
  `signals` and get byte-identical output.

**`src/lib/types.ts`**:

- `CaptureConfig` gains `signals: SignalToggles`.
- `CaptureResult` gains `signals?: CapturedSignals`.
- `SpawnPayload` gains `signals?: CapturedSignals` and `attachScreenshot: boolean`.
- `WorkerRequest.capture` becomes `{ type: "capture"; toggles: SignalToggles }`.
- New `TransportErrorKind`s are **not** needed (signals add no new failure modes
  on the wire; gather failures degrade gracefully — see Error handling).

**`src/lib/transport.ts`** — screenshot optional + signals threaded:

- `SpawnInput` gains `signals?` and `attachScreenshot`. When `attachScreenshot`
  is false (or no screenshot), **skip** `/api/uploads` and send `images: []`.
- `prompt = userText + "\n\n" + formatContextBlock(metadata, signals)`.

**`src/lib/config.ts`**:

- `DEFAULT_CONFIG.signals = { screenshot: true, console: false, network: false, a11y: false }`.
- `loadConfig` deep-merges `signals` over defaults (so an old stored config
  without `signals` still resolves all four booleans).
- `ensureRecorder(toggles)` / `disableRecorder()` helpers wrapping
  `chrome.permissions.request|remove` + `chrome.scripting.registerContentScripts|
  unregisterContentScripts`. (Glue — manual-checklist verified; the merge logic
  is unit-tested.)

**`src/background.ts`** — `captureActiveTab(toggles)`:

- Always: screenshot (for preview) + metadata.
- If `toggles.a11y`: inject `axe.min.js` then run `axe.run()` (isolated world),
  `summarizeAxeResults`.
- If `toggles.console || toggles.network`: read `window.__shepherdCapture`
  (MAIN world); keep only the enabled sub-buffers.
- Returns `CaptureResult { screenshotDataUrl, metadata, signals? }`.

**`src/popup/Popup.svelte`**:

- Four checkboxes seeded from `config.signals`. Screenshot + a11y toggle freely;
  console/network disabled with an "enable in settings" hint unless the
  permission is granted (queried via `chrome.permissions.contains`).
- Flipping a **gather** signal (a11y/console/network) **on** re-issues `capture`
  with the new toggles; screenshot toggle only affects `attachScreenshot` at
  spawn (no re-capture). Preview shows per-section counts (e.g. "3 console, 1
  failed request, 12 a11y").
- `spawn` payload carries the captured `signals` + `attachScreenshot`.

**`src/options/Options.svelte`**:

- A "Signals" section with the four default toggles. Toggling console or network
  **on** calls `ensureRecorder` (permission prompt + register); toggling both
  **off** calls `disableRecorder`. Reflects the live permission state and
  surfaces a localized note that enabling records errors/requests on **all**
  sites.

**`manifest.config.ts`** — add `optional_host_permissions: ["<all_urls>"]`.

**`package.json`** — add `axe-core` dep; copy `axe.min.js` into `public/` (crxjs
copies `public/` to `dist/` root) so `executeScript({ files: ["axe.min.js"] })`
resolves. (`executeScript({files})` injects extension-packaged files directly —
no `web_accessible_resources` entry needed.) The dynamically-registered recorder
(`src/recorder.ts`) must also build to a stable `dist/` path that
`registerContentScripts({ js: [...] })` can reference; the plan wires this build
entry.

---

## Data flow

```
popup ── {type:"capture", toggles} ──▶ background
                                         screenshot + metadata (always)
                                         + axe.run()            (if a11y)
                                         + read MAIN buffer     (if console/network)
       ◀── CaptureResult{screenshotDataUrl, metadata, signals?} ──
popup preview (counts) ── {type:"spawn", payload{prompt, metadata, signals,
                                               screenshotDataUrl, attachScreenshot}} ──▶ background
                          spawnNow: [upload if attachScreenshot] → formatContextBlock(meta, signals)
                                    → POST /api/sessions → desig
```

## Truncation caps (protect the prompt budget; all post-`sanitize`)

- **Console:** ≤30 entries, each message ≤300 chars.
- **Network:** ≤30 failed requests, url ≤200 chars.
- **a11y:** ≤20 findings (critical→minor), ≤3 sample selectors each.
- Section headers carry the **pre-truncation** count (e.g. `Console (47):` even
  if only 30 lines follow) so the agent knows it's a sample, with a `… +N more`
  marker line.

## "Failed request" definition

HTTP response `status >= 400`, **or** a fetch/XHR network error (thrown /
`onerror`), **or** a resource element (`img`/`script`/`link`) load error
(recorded as `status: "load-error"`, no numeric status available).

## Error handling

- Signal gathering is **best-effort and isolated**: if `axe.run()` throws, the
  MAIN-world read fails, or the recorder buffer is absent (e.g. permission
  revoked mid-session), that signal is simply **omitted** from `CapturedSignals`
  — capture still succeeds with screenshot + metadata. No signal failure blocks a
  spawn. (House rule: failures are explicit — the popup preview shows which
  signals were actually gathered, so an empty section reads as "none found", and
  a gather error surfaces as a localized inline note rather than a silent pass.)
- Permission denied at the `chrome.permissions.request` prompt → the Options
  toggle reverts to off with a localized note; nothing is registered.
- Transport failures are unchanged from Phase 1 (existing `TransportError` kinds).

## i18n

New EN+DE keys (catalog-parity gated) for: the four signal labels, the popup
"enable in settings" hint + per-section count strings, the Options signals
section + all-sites permission note + permission-denied note, and any a11y/impact
labels surfaced in chrome. Signal **payload** strings (console text, urls, axe
`help`) pass through verbatim — they are captured data, not app chrome, and are
**not** translated (matches Phase 1's tool-use-summary rule).

## Feature discovery

The extension ships **no `ui/src` UX**, so `check-feature-catalog.sh` won't arm.
Phase 1 already added a What's-New entry for the extension; Phase 2 enriches the
**same** extension rather than introducing a new user-facing surface in the app,
so **no new catalog entry is required**. The PR description must say so explicitly
so the critic doesn't flag a missing entry (it can't verify the reasoning from
the diff).

## Testing strategy

- **TDD pure cores:** `recorder-core` (ring-buffer cap, failure classification,
  console-arg normalization), `a11y.summarizeAxeResults` (mapping, sort, cap),
  `context-block` (new sections, sanitize on every value, caps + `… +N more`
  marker, byte-identical Phase-1 output when `signals` omitted), `transport`
  (screenshot-skipped path sends `images: []` and no upload call; signals reach
  the prompt), `config` (signals deep-merge over a legacy stored config).
- **Manual load-unpacked checklist** (README): recorder registers on enable /
  unregisters on disable; permission prompt fires once; console errors + a 404
  fetch appear in a capture; axe findings appear; revoking permission degrades
  gracefully; EN+DE chrome.
- **Gates:** `bun run check:i18n`, `lint`, `check`, `test`, `build` all green.

## Acceptance criteria

1. Default install requests **no** new permissions; console/network toggles are
   disabled in the popup until enabled in Options.
2. Enabling console/network in Options prompts for `<all_urls>` once and registers
   the recorder; disabling both unregisters it and releases the permission.
3. With the recorder active, a capture on a page that logged a `console.error`
   and made a failed request includes both in the fenced context block, capped
   and sanitized.
4. With a11y enabled, a capture appends up to 20 axe findings (compact form).
5. Unticking screenshot spawns a session with `images: []` and no upload call.
6. Every page-derived string in the block passes through `sanitize()`; fence
   breakout is impossible.
7. Any single signal's gather failure omits that section and still spawns.
8. EN+DE catalogs in parity; all extension gates green.
```
