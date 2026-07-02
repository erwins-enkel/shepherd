# Ambient tab signal — completion (progress ring + glyph ticker + toggle)

Date: 2026-07-02
Issue: #1327 (approved scope). Feature landed partial in #1333; this closes the gap.

## Problem

Issue #1327's approved "Build" list included seven items. What shipped (`ui/src/lib/tab-signal.svelte.ts`, #1333): title count, severity favicon dot, App Badge, attention ladder, completion flourish, a11y/i18n/catalog. Three approved items never got layered on:

- **Progress-ring favicon** for a focused run.
- **Glyph-ticker title** (opt-in, off by default).
- **Per-device toggle** for the ticker.

This spec builds exactly those three. Out of scope (unchanged): master kill-switch (not wanted), quiet-mode / push suppression (not wanted), the N=ci-red counting decision (keep current), the #803 plan-question tier (still deferred).

## Design decisions (settled)

1. **Progress ring tracks the selected session's build queue.** `ringFraction = doneSteps / totalSteps` of the currently-selected session, shown only when the tab is backgrounded AND that session's `displayStatus === "running"` AND nothing needs the operator (`count === 0`). The severity dot always wins when `count > 0`.
2. **Glyph-ticker format:** `⚠{ci} ✋{blocked} ✓{ready} ▶{running} Shepherd` when ON + backgrounded + any group > 0. Zero-count groups omitted. Order is most-urgent-first (`⚠` ci-red › `✋` blocked › `✓` ready › `▶` running) so a right-truncated title keeps the important glyph, matching the original front-paren rationale. When ON but all groups zero → plain `Shepherd`. Attended tab still forces plain `Shepherd`.
3. **One toggle only:** "Compact glyph title", per-device, `localStorage`, default OFF. No master switch, no quiet-mode.
4. **Ring color:** `--color-muted` (in-progress-but-not-urgent reads muted; anything urgent shows the dot instead).

## Architecture

Four units, each with a single purpose and a clear seam.

### 1. `ui/src/lib/tab-ticker.svelte.ts` (new)

Per-device preference singleton, a direct mirror of `build-queue-collapse.svelte.ts`:

```ts
const KEY = "shepherd:tab-glyph-ticker";
function read(): boolean { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } }
class TabTicker {
  enabled = $state(read());
  toggle() { this.set(!this.enabled); }
  set(v: boolean) { this.enabled = v; try { v ? localStorage.setItem(KEY, "1") : localStorage.removeItem(KEY); } catch {} }
}
export const tabTicker = new TabTicker();
export { read as readTabTicker };
```

- **Does:** hold + persist the ticker on/off bit.
- **Depends on:** `localStorage`, Svelte `$state`.
- **Consumers:** the `$effect` in `+page.svelte` (reads `tabTicker.enabled`) and `SettingsDevicePanel.svelte` (binds the switch).

### 2. `deriveTabState` (extend, `tab-signal.svelte.ts`)

Extend the pure function's return so one call drives every mode. New `TabState` shape:

```ts
export interface TabState {
  count: number;        // unchanged — sessions needing operator (blocked · ci-red · ready)
  severity: Severity;   // unchanged — highest across those
  ci: number;           // sessions with git.checks === "failure"
  blocked: number;      // displayStatus === "blocked"
  ready: number;        // readyToMerge && handoff !== "merger"
  running: number;      // displayStatus === "running"
}
```

`ci` / `blocked` / `ready` are per-rule tallies (a session can hit only one severity via the existing `sessionSeverity` precedence red>amber>green, so summing them equals `count` — but they are surfaced separately for the ticker groups). `running` is independent (a running session isn't in `count`). `ringFraction` is NOT computed here — it needs the selected session + its build queue, which live in `+page.svelte`; it is passed into `update()` directly (see unit 4).

Keep `sessionSeverity` and the `count`/`severity` accumulation exactly as-is; add the four tallies in the same loop.

### 3. `TabSignal` controller (extend, `tab-signal.svelte.ts`)

`update()` / `#apply()` payload grows:

```ts
{ count, severity, attended, ticker, ci, blocked, ready, running, ringFraction }
```

- **Title (`#apply`):**
  - `attended` → plain `#baseTitle` (unchanged).
  - background + `ticker` + any group > 0 → `#tickerTitle(...)` = join of non-zero `⚠{ci}` `✋{blocked}` `✓{ready}` `▶{running}` + ` ${baseTitle}`.
  - background + `!ticker` + `count > 0` → `(${count}) ${baseTitle}` (unchanged).
  - otherwise → plain `#baseTitle`.
- **Favicon precedence (background), highest first:** in-progress flourish (existing `#flourishTimer` guard) › severity dot (`count > 0` → `#renderDot`) › **progress ring** (`ringFraction != null` → `#renderRing`) › restore. So the ring only paints when `count === 0` and a run is active — the gating lives in `+page.svelte` producing `ringFraction`, but `#apply` still orders dot-before-ring defensively.
- **`#renderRing(fraction)`:** `#canvas()` base mark, then a stroked arc — `ctx.arc(cx, cy, r, -Math.PI/2, -Math.PI/2 + fraction*2*Math.PI)`, `lineWidth ≈ size*0.12`, `strokeStyle = resolveMuted()`, on a ground-ring for contrast (reuse the `#corner` ground technique or a full-circle track). Add `resolveMuted()` alongside `resolveColor`, same guarded var-chain: `--color-muted` → `--muted` → `#7c8c86`.
- **Coarse ~3/s:** satisfied for free — the existing 400 ms `DEBOUNCE_MS` caps repaint at ≤2.5/s; no rAF.
- **App Badge / aria-live:** unchanged. (Ticker/ring are visual-only; `#announce` still speaks the `count`.)

### 4. Wiring (`ui/src/routes/+page.svelte`)

The existing `$effect` (`:136`) already has `store`, `selectedId`, and `selected`. Extend it:

```ts
$effect(() => {
  const st = deriveTabState(store.sessions, store.git, store.workingBlocked);
  const sel = selected; // $derived session or null
  const q = sel ? store.buildQueues[sel.id] : undefined; // reactive Record<string, BuildQueue> on the store
  let ringFraction: number | null = null;
  if (sel && st.count === 0 && displayStatus(sel, store.workingBlocked) === "running" && q?.steps.length) {
    const done = q.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    ringFraction = done / q.steps.length;
  }
  tabSignal.update({ ...st, attended: store.attended, ticker: tabTicker.enabled, ringFraction });
});
```

The selected session's build queue is `store.buildQueues[id]` — a reactive `$state<Record<string, BuildQueue>>` updated live by the `queue:update` WS event, so the `$effect` re-runs when steps change. `displayStatus` is already imported in `tab-signal.svelte.ts`; import into `+page.svelte` if not present.

### 5. Toggle UI (`ui/src/lib/components/settings/SettingsDevicePanel.svelte`)

Add one `role="switch"` block copied from the contrast toggle (`:97-110`), placed near the theme/contrast prefs (device-scoped, not push):

```svelte
<span class="micro">{m.settings_tab_ticker_title()}</span>
<p class="hint">{m.settings_tab_ticker_hint()}</p>
<button class="toggle" role="switch" aria-checked={tabTicker.enabled} onclick={() => tabTicker.toggle()}>
  <span>{tabTicker.enabled ? m.settings_tab_ticker_on() : m.settings_tab_ticker_off()}</span>
</button>
```

Import `tabTicker` from `$lib/tab-ticker.svelte`.

## i18n

Add to **both** `ui/messages/en.json` and `de.json` (check:i18n parity):

- `settings_tab_ticker_title` — EN "Compact tab title" / DE "Kompakter Tab-Titel"
- `settings_tab_ticker_hint` — EN "When a background tab needs you, show grouped glyph counts (⚠ CI · ✋ blocked · ✓ ready · ▶ running) instead of a single number." / DE equivalent.
- `settings_tab_ticker_on` / `_off` — reuse existing `common_on`/`common_off` if present; else add.

The glyph string itself (`⚠2 ✋1 …`) is data-shaped (counts + fixed symbols), assembled in code, not a translated message — same rationale as the numeric `(N)`. Definitions confirmed by reviewer before merge.

## Testing

- **`tab-signal.svelte.test.ts` (pure):** `deriveTabState` returns correct `ci`/`blocked`/`ready`/`running` tallies for mixed fixtures; `ci+blocked+ready === count` invariant; ticker-string builder omits zero groups and orders `⚠ ✋ ✓ ▶`; `ringFraction` gating logic (only when count 0 + running + steps).
- **`tab-signal.browser.test.ts`:** ring favicon swap fires (href becomes a PNG data URL) when `ringFraction` set + `count 0`; dot wins over ring when `count > 0`; ticker title format when `ticker` on; plain `(N)` when off; attended forces plain.
- **New `tab-ticker.svelte.test.ts`:** persistence round-trip, mirrors `build-queue-collapse.svelte.test.ts`.

## Feature discovery

Existing entry `entries/v1.41.0-tab-signaling.ts` already announces the ambient tab feature. This PR extends the same feature; per the "one entry per shipped user-facing feature" rule, the compact-title toggle is a user-facing addition — add one fragment `entries/v1.41.0-tab-glyph-title.ts` (or bump to the release version at build time) announcing the compact glyph title + where to toggle it. Confirm the release version during implementation.

## Files touched

- **new** `ui/src/lib/tab-ticker.svelte.ts`
- **new** `ui/src/lib/tab-ticker.svelte.test.ts`
- **new** `ui/src/lib/feature-announcements/entries/v<ver>-tab-glyph-title.ts`
- `ui/src/lib/tab-signal.svelte.ts` (deriveTabState + controller + renderRing + resolveMuted)
- `ui/src/lib/tab-signal.svelte.test.ts`, `tab-signal.browser.test.ts`
- `ui/src/routes/+page.svelte` (effect wiring)
- `ui/src/lib/components/settings/SettingsDevicePanel.svelte` (toggle)
- `ui/messages/en.json`, `ui/messages/de.json`

## Relationship to #1332

Issue #1332 ("count unanswered plan-gate/critic questions in N — #803 tier") is a sibling follow-up to #1327. **No functional overlap:** #1332's required work is the #803 plan-question tier, which this spec explicitly defers (Non-goals). The ring + glyph-ticker built here appear only as "bonus / separate follow-ups if pursued" bullets inside #1332's body — there is no dedicated issue for them, so this PR should reference #1332 and note it resolves those two bullets.

**Shared seam:** both this change and #1332 item-3 edit `deriveTabState` / the `TabState` interface. Different fields (here: `ci`/`blocked`/`ready`/`running`; #1332: a plan-question amber count) → no logical conflict, but a textual merge hotspot. #1332 has no branch/PR yet, so this lands first and #1332 rebases onto the extended `TabState`.

## Non-goals

Master kill-switch · quiet-mode / OS-push suppression · changing N=ci-red · #803 plan-question tier · any server change (ambient signal stays purely client-side).
