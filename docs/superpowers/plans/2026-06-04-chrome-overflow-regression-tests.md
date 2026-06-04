# Chrome overflow regression tests (TopBar + GitRail) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock in regression coverage so future UI-chrome changes can't reintroduce top-bar/git-bar overflow or clipped controls — via an exhaustive pure-logic matrix for TopBar's responsive rules plus a real-browser overflow suite for both bars.

**Architecture:** Two layers. **Layer A:** extract TopBar's inline responsive decision logic (`badgeCount`, `hideClockTime`, `compactBadges`) into a pure `top-bar-layout.ts`, exhaustively unit-tested in the existing node vitest project; `TopBar.svelte` consumes it (behavior-preserving). **Layer B:** a new vitest *browser* project (Playwright/Chromium) mounts `TopBar` and `GitRail` standalone at curated widths × states and asserts no overflow + every actionable control stays hittable.

**Tech Stack:** Svelte 5, vitest 4, `@vitest/browser` + `@vitest/browser-playwright` + `playwright` (chromium), `vitest-browser-svelte`, Paraglide, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-06-04-chrome-overflow-regression-tests-design.md`

---

## File structure

```
ui/src/lib/components/
  top-bar-layout.ts            ← NEW (Task 1): pure render-plan logic
  top-bar-layout.test.ts       ← NEW (Task 1): 192-combo exhaustive matrix (node project)
  TopBar.svelte                ← MODIFIED (Task 2): consume top-bar-layout; drop inline derives
  TopBar.browser.test.ts       ← NEW (Task 4): overflow assertions (browser project)
  GitRail.browser.test.ts      ← NEW (Task 5): overflow assertions (browser project)
ui/vite.config.ts              ← MODIFIED (Task 3): test.projects { node, browser }
ui/package.json                ← MODIFIED (Task 3): browser deps + test:node/test:browser scripts
.github/workflows/ci.yml       ← MODIFIED (Task 6): playwright install before ui tests
.husky/pre-push                ← MODIFIED (Task 6): playwright install before ui tests
```

**Mode definition used throughout:** `Mode = "mobile" | "touch-desktop" | "desktop"`, derived from the existing `mobile`/`touch` props — `mobile` → `"mobile"`; `touch && !mobile` → `"touch-desktop"`; else `"desktop"`. The touch-desktop crunch is the unfolded Pixel at **1000px** (the device the #322 overflow occurred on).

---

## Task 1: Extract TopBar layout logic + exhaustive matrix test

The current inline derives in `TopBar.svelte` (verbatim, lines ~54–72):

```ts
const badgeCount = (working > 0 ? 1 : 0) + (updateAvailable ? 1 : 0) + (herdrUpdateAvailable ? 1 : 0)
  + (learnings > 0 || overBudget > 0 ? 1 : 0) + (needsYou > 0 ? 1 : 0) + (whatsNew ? 1 : 0);
const hideClockTime = touch && !mobile && badgeCount > 0;
const compactBadges = touch && !mobile && badgeCount >= 2;
```

These become pure functions. Badge *presence* is what drives `badgeCount`, so the function takes a `ChromeState` of the six already-computed presence inputs (keeping the same booleans the component already has), not raw session arrays.

**Files:**
- Create: `ui/src/lib/components/top-bar-layout.ts`
- Test: `ui/src/lib/components/top-bar-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/components/top-bar-layout.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  badgeCount,
  topBarPlan,
  type Mode,
  type ChromeState,
} from "./top-bar-layout";

const MODES: Mode[] = ["mobile", "touch-desktop", "desktop"];

// Build every ChromeState from a 6-bit mask over the six badge-presence inputs.
const KEYS = [
  "working",
  "updateAvailable",
  "herdrUpdateAvailable",
  "learningsOrBudget",
  "needsYou",
  "whatsNew",
] as const;

function stateFromMask(mask: number): ChromeState {
  return {
    working: mask & 1 ? 1 : 0,
    updateAvailable: !!(mask & 2),
    herdrUpdateAvailable: !!(mask & 4),
    learnings: mask & 8 ? 1 : 0,
    overBudget: 0,
    needsYou: mask & 16 ? 1 : 0,
    whatsNew: !!(mask & 32),
  };
}

// Reference implementation the matrix is checked against (mirrors the spec rules).
function expectedCount(s: ChromeState): number {
  return (
    (s.working > 0 ? 1 : 0) +
    (s.updateAvailable ? 1 : 0) +
    (s.herdrUpdateAvailable ? 1 : 0) +
    (s.learnings > 0 || s.overBudget > 0 ? 1 : 0) +
    (s.needsYou > 0 ? 1 : 0) +
    (s.whatsNew ? 1 : 0)
  );
}

describe("badgeCount", () => {
  it("counts each present badge once across all 64 presence combos", () => {
    for (let mask = 0; mask < 64; mask++) {
      const s = stateFromMask(mask);
      expect(badgeCount(s)).toBe(expectedCount(s));
    }
  });

  it("overBudget alone (no learnings) still counts the learnings badge", () => {
    expect(badgeCount({ ...stateFromMask(0), overBudget: 3 })).toBe(1);
  });
});

describe("topBarPlan — exhaustive 3 modes × 64 presence combos", () => {
  it("hideClockTime only on touch-desktop with >=1 badge", () => {
    for (const mode of MODES) {
      for (let mask = 0; mask < 64; mask++) {
        const s = stateFromMask(mask);
        const plan = topBarPlan(mode, s);
        const count = badgeCount(s);
        expect(plan.hideClockTime).toBe(mode === "touch-desktop" && count > 0);
      }
    }
  });

  it("compactBadges only on touch-desktop with >=2 badges", () => {
    for (const mode of MODES) {
      for (let mask = 0; mask < 64; mask++) {
        const s = stateFromMask(mask);
        const plan = topBarPlan(mode, s);
        const count = badgeCount(s);
        expect(plan.compactBadges).toBe(mode === "touch-desktop" && count >= 2);
      }
    }
  });

  it("exposes badgeCount on the plan", () => {
    for (const mode of MODES) {
      for (let mask = 0; mask < 64; mask++) {
        const s = stateFromMask(mask);
        expect(topBarPlan(mode, s).badgeCount).toBe(expectedCount(s));
      }
    }
  });
});

describe("regression anchors (#322 / #247)", () => {
  it("lone LEARNINGS on touch-desktop drops the clock but does NOT compact", () => {
    const s = stateFromMask(8); // learnings only
    const plan = topBarPlan("touch-desktop", s);
    expect(plan.hideClockTime).toBe(true);
    expect(plan.compactBadges).toBe(false);
  });

  it("two badges on touch-desktop compact the row", () => {
    const s = stateFromMask(8 | 16); // learnings + needsYou
    expect(topBarPlan("touch-desktop", s).compactBadges).toBe(true);
  });

  it("desktop never hides clock or compacts, regardless of badges", () => {
    const all = stateFromMask(63);
    const plan = topBarPlan("desktop", all);
    expect(plan.hideClockTime).toBe(false);
    expect(plan.compactBadges).toBe(false);
  });

  it("mobile never sets touch-desktop crunch flags", () => {
    const all = stateFromMask(63);
    const plan = topBarPlan("mobile", all);
    expect(plan.hideClockTime).toBe(false);
    expect(plan.compactBadges).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && bunx vitest run src/lib/components/top-bar-layout.test.ts`
Expected: FAIL — `Failed to resolve import "./top-bar-layout"` / module not found.

- [ ] **Step 3: Write the minimal implementation**

Create `ui/src/lib/components/top-bar-layout.ts`:

```ts
// Pure responsive-layout decisions for the top bar's right-side cluster.
// Extracted from TopBar.svelte so the #247/#322 collapse rules are unit-testable.
// "touch-desktop" = an unfolded foldable (touch + desktop layout, ~1000px,
// narrower than a real desktop) — the crunch the badges overflowed on.

export type Mode = "mobile" | "touch-desktop" | "desktop";

/** The six already-computed badge-presence inputs the bar counts for crowding. */
export interface ChromeState {
  /** running session count; the halt button shows while > 0 */
  working: number;
  updateAvailable: boolean;
  herdrUpdateAvailable: boolean;
  learnings: number;
  overBudget: number;
  needsYou: number;
  whatsNew: boolean;
}

export interface TopBarPlan {
  /** how many right-side badges vie for space (each renders one button) */
  badgeCount: number;
  /** drop the numeric clock-time (keep the connection dot) */
  hideClockTime: boolean;
  /** collapse labelled badges to their compact icon/dot form */
  compactBadges: boolean;
}

/** Derive the layout mode from the bar's mobile/touch flags. */
export function modeOf(mobile: boolean, touch: boolean): Mode {
  if (mobile) return "mobile";
  if (touch) return "touch-desktop";
  return "desktop";
}

/** How many right-side badges are present (each renders one button). */
export function badgeCount(s: ChromeState): number {
  return (
    (s.working > 0 ? 1 : 0) +
    (s.updateAvailable ? 1 : 0) +
    (s.herdrUpdateAvailable ? 1 : 0) +
    (s.learnings > 0 || s.overBudget > 0 ? 1 : 0) +
    (s.needsYou > 0 ? 1 : 0) +
    (s.whatsNew ? 1 : 0)
  );
}

/** The full right-cluster render plan for a given mode + state. */
export function topBarPlan(mode: Mode, s: ChromeState): TopBarPlan {
  const count = badgeCount(s);
  const touchDesktop = mode === "touch-desktop";
  return {
    badgeCount: count,
    // Any badge crowds touch-desktop, so the numeric clock is sacrificed first.
    hideClockTime: touchDesktop && count > 0,
    // Two+ badges won't fit even after the clock drops — collapse labels.
    compactBadges: touchDesktop && count >= 2,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && bunx vitest run src/lib/components/top-bar-layout.test.ts`
Expected: PASS — all describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/top-bar-layout.ts ui/src/lib/components/top-bar-layout.test.ts
git commit -m "test(ui): extract top-bar responsive logic with exhaustive matrix"
```

---

## Task 2: Refactor TopBar.svelte to consume top-bar-layout (behavior-preserving)

**Files:**
- Modify: `ui/src/lib/components/TopBar.svelte` (script block ~lines 49–72)

- [ ] **Step 1: Add the import**

At the top of the `<script>` (after the existing `usage-gauges` import, ~line 4):

```ts
import { modeOf, topBarPlan } from "./top-bar-layout";
```

- [ ] **Step 2: Replace the inline derives**

Find the existing block (verbatim — `working` stays; the three crowding derives are replaced):

```ts
  const badgeCount = $derived(
    (working > 0 ? 1 : 0) +
      (updateAvailable ? 1 : 0) +
      (herdrUpdateAvailable ? 1 : 0) +
      (learnings > 0 || overBudget > 0 ? 1 : 0) +
      (needsYou > 0 ? 1 : 0) +
      (whatsNew ? 1 : 0),
  );
  // Any badge crowds the bar on touch desktop-layout ... (comment block)
  const hideClockTime = $derived(touch && !mobile && badgeCount > 0);
  // Tighter still ... (comment block)
  const compactBadges = $derived(touch && !mobile && badgeCount >= 2);
```

Replace with (keep the surrounding explanatory comments — move them above the plan):

```ts
  // Responsive right-cluster decisions live in ./top-bar-layout (pure + unit-tested,
  // see top-bar-layout.test.ts). "touch-desktop" is the unfolded-foldable crunch
  // (~1000px) the #247/#322 overflow fixes targeted.
  const mode = $derived(modeOf(mobile, touch));
  const plan = $derived(
    topBarPlan(mode, {
      working,
      updateAvailable,
      herdrUpdateAvailable,
      learnings,
      overBudget,
      needsYou,
      whatsNew,
    }),
  );
  const badgeCount = $derived(plan.badgeCount);
  const hideClockTime = $derived(plan.hideClockTime);
  const compactBadges = $derived(plan.compactBadges);
```

> Note: `badgeCount`/`hideClockTime`/`compactBadges` keep their names, so the markup (`class:no-time={hideClockTime}`, `mobile || compactBadges`, etc.) is unchanged. This is a pure refactor — no template edits.

- [ ] **Step 3: Typecheck + lint**

Run: `cd ui && bun run check`
Expected: PASS — no type errors. (svelte-check resolves the new import + `ChromeState` shape.)

- [ ] **Step 4: Run the UI test suite (proves no behavior change)**

Run: `cd ui && bunx vitest run --project node` *(if projects not yet configured, use `cd ui && bun run test`)*
Expected: PASS — existing tests + the new matrix all green.

> Note: at this point the browser project may not exist yet (Task 3). If `--project node` errors as unknown, just run `bun run test`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/TopBar.svelte
git commit -m "refactor(ui): TopBar consumes extracted top-bar-layout"
```

---

## Task 3: Add the vitest browser project (infra only)

**Files:**
- Modify: `ui/package.json` (devDependencies + scripts)
- Modify: `ui/vite.config.ts` (add `test.projects`)
- Create: `ui/src/lib/components/_browser-smoke.browser.test.ts` (temporary smoke test, deleted in Step 6)

- [ ] **Step 1: Install browser test deps**

Run:
```bash
cd ui && bun add -d @vitest/browser @vitest/browser-playwright vitest-browser-svelte playwright
```
Then download the Chromium binary once:
```bash
cd ui && bunx playwright install chromium
```
Expected: deps added to `ui/package.json` devDependencies; Chromium downloaded.

- [ ] **Step 2: Configure dual projects in `ui/vite.config.ts`**

Add these imports near the top:

```ts
import { playwright } from "@vitest/browser-playwright";
import { configDefaults } from "vitest/config";
```

Add a `test` key to the `defineConfig({ ... })` object (sibling of `define`, `plugins`, `server`):

```ts
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          // browser specs run in the browser project; everything else here
          exclude: [...configDefaults.exclude, "**/*.browser.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
```

> `extends: true` inherits the root Vite plugins (paraglide, tailwind, sveltekit), so `m.*` messages, Tailwind `@theme` vars, and Svelte compilation all work inside the browser project.

- [ ] **Step 3: Add split scripts to `ui/package.json`**

In `"scripts"`, alongside `"test": "vitest run"`, add:

```json
    "test:node": "vitest run --project node",
    "test:browser": "vitest run --project browser",
```

- [ ] **Step 4: Write a temporary smoke test**

Create `ui/src/lib/components/_browser-smoke.browser.test.ts`:

```ts
import { expect, test } from "vitest";
import { page } from "@vitest/browser/context";

test("browser project boots and can measure layout", async () => {
  await page.viewport(1000, 1036);
  const el = document.createElement("div");
  el.style.width = "120px";
  el.textContent = "hello";
  document.body.appendChild(el);
  expect(el.getBoundingClientRect().width).toBe(120);
  el.remove();
});
```

- [ ] **Step 5: Run each project to verify the split works**

Run: `cd ui && bun run test:node`
Expected: PASS — all node tests, browser smoke NOT collected.

Run: `cd ui && bun run test:browser`
Expected: PASS — Chromium launches headless, the smoke test passes; node tests NOT collected.

Run: `cd ui && bun run test`
Expected: PASS — both projects run.

- [ ] **Step 6: Delete the smoke test + commit**

```bash
rm ui/src/lib/components/_browser-smoke.browser.test.ts
git add ui/package.json ui/vite.config.ts ui/bun.lock
git commit -m "test(ui): add vitest browser project (playwright/chromium)"
```

---

## Task 4: TopBar overflow browser test

Asserts, for each width × badge-set, that the bar does not overflow and every actionable control stays within the bar and is non-zero — **labels may collapse, controls may not vanish**.

**Files:**
- Create: `ui/src/lib/components/TopBar.browser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/components/TopBar.browser.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "@vitest/browser/context";
import TopBar from "./TopBar.svelte";
import "../../app.css";
import type { Session, UsageLimits, UpdateStatus, HerdrUpdateStatus } from "$lib/types";

// Deterministic measurement: pin the bar's font so CI (no Berkeley Mono) and
// local agree. Mounted into a full-width container; widths come from page.viewport.
let fontStyle: HTMLStyleElement;
beforeEach(() => {
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root { --font-mono: ui-monospace, monospace; }
    body { margin: 0; }`;
  document.head.appendChild(fontStyle);
});
afterEach(() => {
  fontStyle.remove();
  document.body.innerHTML = "";
});

type Mode = "mobile" | "touch-desktop" | "desktop";
const FLAGS: Record<Mode, { mobile: boolean; touch: boolean }> = {
  mobile: { mobile: true, touch: true },
  "touch-desktop": { mobile: false, touch: true },
  desktop: { mobile: false, touch: false },
};

function sessions(working: number): Session[] {
  return Array.from({ length: working }, (_, i) => ({
    id: `s${i}`,
    status: "running",
  })) as unknown as Session[];
}

interface Scenario {
  name: string;
  mode: Mode;
  width: number;
  props: Record<string, unknown>;
}

const allBadges = {
  needsYou: 3,
  learnings: 5,
  update: { behind: 4 } as UpdateStatus,
  herdrUpdate: { updateAvailable: true } as HerdrUpdateStatus,
  whatsNew: true,
};

const SCENARIOS: Scenario[] = [
  // The #322 device: unfolded Pixel at 1000px (touch-desktop).
  { name: "touch-desktop 1000 — all badges", mode: "touch-desktop", width: 1000, props: { ...allBadges, ...sessionsProp(2) } },
  { name: "touch-desktop 1000 — dual-update + learnings + needsYou + whatsNew", mode: "touch-desktop", width: 1000,
    props: { needsYou: 2, learnings: 3, update: { behind: 1 }, herdrUpdate: { updateAvailable: true }, whatsNew: true, ...sessionsProp(0) } },
  { name: "touch-desktop 1000 — lone learnings (#322 regression)", mode: "touch-desktop", width: 1000, props: { learnings: 4, ...sessionsProp(0) } },
  { name: "touch-desktop 960 — all badges (bracket)", mode: "touch-desktop", width: 960, props: { ...allBadges, ...sessionsProp(2) } },
  // Phones.
  { name: "mobile 390 — all badges", mode: "mobile", width: 390, props: { ...allBadges, ...sessionsProp(2) } },
  { name: "mobile 280 — all badges (fold cover)", mode: "mobile", width: 280, props: { ...allBadges, ...sessionsProp(2) } },
  // Desktop.
  { name: "desktop 1280 — all badges", mode: "desktop", width: 1280, props: { ...allBadges, ...sessionsProp(2) } },
  // Empty baseline.
  { name: "touch-desktop 1000 — no badges", mode: "touch-desktop", width: 1000, props: { ...sessionsProp(0) } },
];

function sessionsProp(working: number) {
  return { sessions: sessions(working) };
}

function baseProps(s: Scenario): Record<string, unknown> {
  return {
    nowMs: 1_700_000_000_000,
    connected: true,
    limits: null as UsageLimits | null,
    ...FLAGS[s.mode],
    ...s.props,
  };
}

function assertNoOverflow(el: HTMLElement) {
  // 1px slack absorbs sub-pixel rounding in the browser's layout engine.
  expect(el.scrollWidth, `${el.className} overflows`).toBeLessThanOrEqual(el.clientWidth + 1);
}

function assertControlsHittable(bar: HTMLElement) {
  const barRect = bar.getBoundingClientRect();
  const controls = bar.querySelectorAll<HTMLElement>("button, a[href]");
  expect(controls.length, "bar has at least one control").toBeGreaterThan(0);
  for (const c of controls) {
    const r = c.getBoundingClientRect();
    const label = c.getAttribute("aria-label") || c.className;
    expect(r.width, `${label} has zero width`).toBeGreaterThan(0);
    expect(r.height, `${label} has zero height`).toBeGreaterThan(0);
    // Within the bar (2px slack for borders/rounding). Label may collapse;
    // the clickable element must never be pushed outside or clipped.
    expect(r.left, `${label} left of bar`).toBeGreaterThanOrEqual(barRect.left - 2);
    expect(r.right, `${label} right of bar`).toBeLessThanOrEqual(barRect.right + 2);
  }
}

describe("TopBar — no overflow, controls stay hittable", () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      await page.viewport(s.width, 900);
      render(TopBar, baseProps(s));
      const hud = document.querySelector<HTMLElement>(".hud");
      expect(hud, "TopBar .hud mounted").not.toBeNull();
      assertNoOverflow(hud!);
      assertControlsHittable(hud!);
    });
  }
});
```

- [ ] **Step 2: Run the test**

Run: `cd ui && bun run test:browser`
Expected: PASS for all scenarios. If a scenario FAILS with overflow, that is a **genuine finding** — the current TopBar overflows at that width/state. Stop and report it (do not weaken the assertion); the fix belongs in `TopBar.svelte`/CSS, tracked separately.

> If the `.hud` width does not fill the viewport (e.g. it sizes to content), wrap the render in a fixed-width host: create `const host = document.createElement("div"); host.style.width = s.width + "px"; document.body.appendChild(host);` and pass `{ target: host }` is not supported by `render` options — instead set `document.body.style.width = s.width + "px"`. Prefer `page.viewport` first; only add the host if `.hud` underflows.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/components/TopBar.browser.test.ts
git commit -m "test(ui): TopBar overflow regression suite (browser)"
```

---

## Task 5: GitRail overflow browser test

GitRail self-fetches its PR state via `gitState` from `$lib/api`. Mock only that module to drive a worst-case open-PR rail (PR link + CI dot + Merge + automation pill + ReadyToggle). The other stores (`reviews`, `repoConfig`) have safe empty defaults, so no further mocking is needed.

**Files:**
- Create: `ui/src/lib/components/GitRail.browser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/components/GitRail.browser.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "@vitest/browser/context";
import "../../app.css";
import type { GitState } from "$lib/types";

// GitRail loads PR state from $lib/api.gitState on mount; mock it to a populated
// open PR so the rail renders its full button set without a backend.
const openPr: GitState = {
  kind: "github",
  state: "open",
  number: 12345,
  url: "https://github.com/acme/shepherd/pull/12345",
  title: "feat: a deliberately long pull request title that stresses the rail width",
  mergeable: true,
  checks: "success",
  deployConfigured: true,
};

vi.mock("$lib/api", () => ({
  gitState: vi.fn(async () => openPr),
  openPr: vi.fn(),
  mergePr: vi.fn(),
  redeploy: vi.fn(),
  replySession: vi.fn(),
}));

// Import the component AFTER the mock is registered.
const { default: GitRail } = await import("./GitRail.svelte");

let fontStyle: HTMLStyleElement;
beforeEach(() => {
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root { --font-mono: ui-monospace, monospace; } body { margin: 0; }`;
  document.head.appendChild(fontStyle);
});
afterEach(() => {
  fontStyle.remove();
  document.body.innerHTML = "";
});

// The rail mounts into a host cell of a realistic fixed width (a session row's
// git column). Overflow within that cell is the failure we guard against.
function host(width: number): HTMLDivElement {
  const h = document.createElement("div");
  h.style.width = `${width}px`;
  h.style.overflow = "visible"; // so escaped controls are measurable, not clipped away
  document.body.appendChild(h);
  return h;
}

function assertControlsWithin(cell: HTMLElement) {
  const wrap = cell.querySelector<HTMLElement>(".git-rail-wrap");
  expect(wrap, ".git-rail-wrap mounted").not.toBeNull();
  const cellRect = cell.getBoundingClientRect();
  const controls = wrap!.querySelectorAll<HTMLElement>("button, a[href]");
  expect(controls.length, "rail has controls").toBeGreaterThan(0);
  for (const c of controls) {
    const r = c.getBoundingClientRect();
    const label = c.getAttribute("aria-label") || c.textContent?.trim() || c.className;
    expect(r.width, `${label} zero width`).toBeGreaterThan(0);
    expect(r.height, `${label} zero height`).toBeGreaterThan(0);
    expect(r.right, `${label} escapes cell right edge`).toBeLessThanOrEqual(cellRect.right + 2);
  }
}

const CASES = [
  { name: "desktop cell 600px — open PR, long title", width: 600, mobile: false },
  { name: "mobile cell 360px — open PR, long title", width: 360, mobile: true },
];

describe("GitRail — controls stay within the cell", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      await page.viewport(Math.max(c.width, 400), 900);
      const h = host(c.width);
      const screen = render(GitRail, {
        sessionId: "sess-1",
        repoPath: "/repo",
        name: "feature-x",
        prompt: "do the thing",
        mobile: c.mobile,
        status: "idle",
        ready: false,
        showReady: true,
        // @ts-expect-error vitest-browser-svelte render target option
        target: h,
      });
      // Wait for the mocked gitState() to populate the rail.
      await expect.element(screen.getByText(/PR #12345/)).toBeVisible();
      assertControlsWithin(h);
    });
  }
});
```

> If `vitest-browser-svelte`'s `render` does not accept a `target` option in the installed version, drop the `target` field and instead append into `document.body` directly, then query `.git-rail-wrap` from `document` and use a wrapping fixed-width `host` by setting `document.body.style.width`. Verify the actual `render` signature with `bunx vitest run` output and adjust; the assertion logic stays identical.

- [ ] **Step 2: Run the test**

Run: `cd ui && bun run test:browser`
Expected: PASS — both cases. A real overflow is a genuine finding (report, don't weaken).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/components/GitRail.browser.test.ts
git commit -m "test(ui): GitRail overflow regression suite (browser)"
```

---

## Task 6: Wire the browser project into CI + pre-push

`bun run test` (already in CI + pre-push) now runs both projects, so the only addition is installing Chromium before that step.

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.husky/pre-push`

- [ ] **Step 1: Add Chromium install to CI before the ui test step**

In `.github/workflows/ci.yml`, immediately BEFORE the `- name: Test (ui)` step (currently around line 63), insert:

```yaml
      - name: Install Playwright Chromium (ui browser tests)
        run: cd ui && bunx playwright install --with-deps chromium
```

- [ ] **Step 2: Add Chromium install to pre-push before the ui test step**

In `.husky/pre-push`, immediately BEFORE the `echo "→ ui tests"` line, insert:

```sh
echo "→ ensure Playwright Chromium (ui browser tests)"
(cd ui && bunx playwright install chromium)
```

> `playwright install` is idempotent and fast when the browser is already cached. Local pre-push uses the user-level cache (no `--with-deps`, which needs root); CI uses `--with-deps` to pull system libs on the ephemeral runner.

- [ ] **Step 3: Verify the full local gate passes**

Run: `cd ui && bun run test`
Expected: PASS — node + browser projects both green.

Run (root, mirrors pre-push ui portion): `cd ui && bun run check && cd ui && bun run check:i18n`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .husky/pre-push
git commit -m "ci: install Playwright Chromium for ui browser tests"
```

---

## Final verification (before PR)

- [ ] `cd ui && bun run test` — both projects green
- [ ] `cd ui && bun run check` — svelte-check clean
- [ ] `cd ui && bun run check:i18n` — catalog parity (no new keys added, so trivially passes)
- [ ] `bunx prettier --check ui/src ui/vite.config.ts` — formatted
- [ ] `cd ui && bun run build` — production build succeeds
- [ ] Confirm no user-facing UX added → `[no-feature-entry]` belongs in the PR body (this is test infra + a behavior-preserving refactor; no feature-announcement entry required)

---

## Notes for the executor

- **This is test infra + a behavior-preserving refactor.** No new user-facing strings → no i18n catalog additions, no feature-announcement entry. Put `[no-feature-entry]` in the PR body so the feature-catalog gate skips loudly.
- **A failing browser assertion is a real bug, not a flaky test.** If TopBar/GitRail genuinely overflows at a tested width, the assertion has done its job — report the finding; the layout fix is separate work, not a reason to relax the threshold.
- **Font determinism:** the browser tests pin `--font-mono` to `ui-monospace, monospace` so absolute glyph widths match between CI (no Berkeley Mono) and dev. Assertions are relational regardless.
- **`render` target option:** the exact `vitest-browser-svelte` mount-target API can vary by version — both browser tasks include the fallback (mount into `document.body`, constrain via a fixed-width host/viewport). Confirm against the installed version when the red test runs.

## Open questions

None blocking. (Touch-desktop width resolved to 1000px; Chromium version floats with the pinned `playwright` dep — acceptable for a relational-assertion gate.)
