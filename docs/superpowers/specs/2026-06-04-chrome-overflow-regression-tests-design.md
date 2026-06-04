# Chrome overflow regression tests (TopBar + GitRail)

**Date:** 2026-06-04
**Status:** Design approved, pending implementation plan

## Problem

Several recent UI-chrome changes (e.g. `#247`, `#322`) crowded the top bar's
right-side cluster, causing **layout overflow** (content spilling past the bar
edge) and **clipped/disappearing controls**. Each was caught by hand and fixed
with bespoke `$derived` logic; nothing guards against the next one. We want
regression coverage that confirms new chrome changes don't reintroduce either
failure in **TopBar** or **GitRail**.

## Root-cause shape

The failures are driven by combinations of two axes:

- **Viewport mode** — `mobile` / `touch-desktop` (unfolded foldable: touch +
  desktop layout, narrower than a real desktop) / `desktop`.
- **Which badges/controls are present** — TopBar's right cluster: halt (only
  while something works), app-update, herdr-update, learnings/overBudget,
  needsYou, whatsNew; GitRail's rail: merge/redeploy buttons (+ armed states),
  auto-count, PR link (variable length), review-flash, status dot.

The current defenses:

- **TopBar** uses discrete `$derived` decision logic, inline in the component:
  `badgeCount`, `hideClockTime = touch && !mobile && badgeCount > 0`,
  `compactBadges = touch && !mobile && badgeCount >= 2`. Badges then render
  `full` / `compact` / `hidden` forms off those booleans.
- **GitRail** has almost no discrete decision logic; its protection is **CSS**
  (`overflow: hidden` + `text-overflow: ellipsis` on the rail / PR link).

## Existing constraints

- Test runner is **vitest in node**, pure-logic only. No jsdom / Playwright /
  @testing-library anywhere in the repo.
- Established idiom: **extract pure logic into a `*.ts`, unit-test it** (e.g.
  `git-rail-drain.ts` ↔ `git-rail-drain.test.ts`,
  `pr-badge.ts` ↔ `pr-badge.test.ts`). TopBar's responsive logic is **not yet
  extracted** — it lives inline in `TopBar.svelte`.
- jsdom/happy-dom do **not** compute real layout (`getBoundingClientRect`
  returns zeros), so actual-overflow detection requires a real browser.

## Approach: hybrid (two layers)

Pure-logic matrix tests as the exhaustive primary gate, backstopped by a thin
real-browser suite that measures the actual pixels the logic model can't see.

### Layer A — Decision logic (exhaustive, pure, fast)

Extract TopBar's inline responsive rules into a new pure module
`ui/src/lib/components/top-bar-layout.ts`:

```ts
type Mode = "mobile" | "touch-desktop" | "desktop";

interface ChromeState {
  working: number;
  updateAvailable: boolean;
  herdrUpdateAvailable: boolean;
  learnings: number;
  overBudget: number;
  needsYou: number;
  whatsNew: boolean;
}

export function badgeCount(s: ChromeState): number;

export function topBarPlan(
  mode: Mode,
  s: ChromeState,
): {
  clock: "full" | "dot-only";
  badges: Record<BadgeKey, "full" | "compact" | "hidden">;
};
```

- `TopBar.svelte` is **modified to consume `topBarPlan(...)`** instead of
  computing `hideClockTime` / `compactBadges` inline. (`mode` is derived from
  the existing `mobile` / `touch` props.) No behavior change — the existing
  derives are moved verbatim into the pure function.
- `top-bar-layout.test.ts` walks the **full** matrix: `3 modes × 2⁶ badge
  subsets = 192` combinations, asserting the complete `topBarPlan` output. This
  pins the `#247`/`#322` collapse rules as the regression contract — e.g. "a
  lone LEARNINGS badge on touch-desktop drops the clock"; "two or more badges
  collapse to compact form regardless of which."
- GitRail has no comparable discrete logic to extract; its coverage is carried
  by Layer B.

### Layer B — Real-browser overflow (vitest browser mode, curated worst-cases)

Add a **second vitest project** (browser) that mounts components in a real
Chromium and measures layout. Not exhaustive — targets the crunch points the
bugs actually came from.

**Harness:** `@vitest/browser` + `playwright` (chromium provider) +
`vitest-browser-svelte`. Components are mounted standalone with mock props at a
fixed viewport width and the app's real font stack. Lives in the existing
`vitest run` toolchain as a separate project (no running app / herdr needed).

**Pass/fail semantics (the crux).** "Disappearing" is *sometimes correct* —
`compactBadges` deliberately collapses labels and the clock-time is
deliberately dropped. So the assertions are:

1. **No overflow:** `el.scrollWidth <= el.clientWidth` on the bar/rail
   container — nothing spills past the edge.
2. **Every actionable control stays hittable:** each `<button>` / link is
   within the container's bounds and has non-zero size. A *label* may collapse
   to an icon/dot; the **clickable element must never be clipped, zero-sized,
   or pushed outside the bar.**

Labels may shrink; controls may not vanish.

**Matrix (curated):**

- *TopBar* widths at the real breakpoints: fold-cover ~280px (mobile), phone
  ~390px (mobile), **unfolded Pixel 1000px (touch-desktop — the actual device
  the `#322` overflow occurred on)**, desktop ~1280px — × high-pressure badge
  sets: **all badges on**; **dual-update +
  learnings + needsYou + whatsNew**; **lone learnings** (the exact `#322`
  regressions); plus the empty baseline.
- *GitRail* at mobile + desktop widths × content stressors: long PR title,
  both merge+redeploy armed, auto-count present, review-flash state. Verifies
  the rail clips gracefully (CSS ellipsis) and buttons stay hittable.

**Flakiness guard:** assertions are **relational** (`scrollWidth <=
clientWidth`, control-within-bounds), never absolute-pixel or screenshot
snapshots. Tolerates minor font variance. No visual-diffing — deliberately out
of scope (too flaky for the value).

## File layout

```
ui/src/lib/components/
  top-bar-layout.ts            ← NEW: extracted pure render-plan logic
  top-bar-layout.test.ts       ← NEW: 192-combo exhaustive matrix (node project)
  TopBar.svelte                ← MODIFIED: consume topBarPlan(); drop inline derives
  TopBar.browser.test.ts       ← NEW: overflow assertions (browser project)
  GitRail.browser.test.ts      ← NEW: overflow assertions (browser project)
```

## Vitest dual-project config

In `ui/vite.config.ts`, add `test.projects`:

- **node project** — unchanged behavior; globs `*.test.ts` (excludes
  `*.browser.test.ts`). The existing fast suite.
- **browser project** — `@vitest/browser` with the `playwright` provider
  (chromium, headless); globs `*.browser.test.ts`.

Scripts:

- `bun run test` → runs both projects.
- `test:node` / `test:browser` → run one each (for fast local iteration and CI
  split if desired).

## CI + pre-push wiring

The browser project **joins the gate everywhere** (CI `verify` + pre-push), per
decision.

- CI installs the Chromium binary (`playwright install --with-deps chromium`)
  before `bun run test`.
- Pre-push will need Chromium present locally (`playwright install chromium`
  once per machine). **Caveat:** if a missing browser on a fresh worktree makes
  pre-push too heavy in practice, the fallback is to scope the browser project
  to **CI-only** (logic tests still gate everywhere). We wire gate-everywhere as
  chosen and can relax later.

## Out of scope (YAGNI)

- Screenshot / visual-regression / pixel-diffing.
- Full Playwright e2e driving the running app (herdr + server + UI).
- Extending coverage beyond TopBar + GitRail chrome.
- Refactoring GitRail's CSS-based overflow into discrete logic.

## i18n note

Mock props feed real Paraglide messages (`m.*`) — compiled JS, works in browser
mode unchanged. No new user-facing strings are introduced (test-only +
internal logic extraction), so no catalog/feature-announcement entries are
required. The behavior-preserving `TopBar.svelte` refactor surfaces no new UX.

## Open questions

- Touch-desktop test width — **resolved: 1000px** (real unfolded Pixel, the
  device the `#322` overflow occurred on). Optionally add a slightly-narrower
  partner (~960px) to bracket, but 1000px is the must-cover case.
- Browser-project headless provider pinning — pin Chromium version in CI for
  determinism, or float? (Lean: pin.)
