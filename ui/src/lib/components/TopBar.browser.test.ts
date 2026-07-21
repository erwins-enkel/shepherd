import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { Session, UsageLimits, UpdateStatus, HerdrUpdateStatus, HeldTask } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { REPO_URL, DOCS_URL, version } from "$lib/build-info";
import { formatTokenLabel } from "$lib/format";

// Mock api so the manual /usage refresh path never fires a real network call —
// individual tests stub refreshUsage's resolution/rejection per case.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  // Default: resolve (success). The value is ignored by the component (the gauge
  // self-updates via the ln WS frame); the fail-closed test overrides with a reject.
  return { ...actual, refreshUsage: vi.fn(async () => undefined) };
});

const { default: TopBar } = await import("./TopBar.svelte");
const { default: TopBarHeldBadge } = await import("./top-bar/TopBarHeldBadge.svelte");
const { default: TopBarLimitsHarness } = await import("./TopBarLimitsHarness.svelte");
const { refreshUsage } = await import("$lib/api");

// Deterministic measurement: pin the bar's font so CI (no Berkeley Mono) and
// local agree. Mounted into a full-width container; widths come from page.viewport.
// `body { width: <viewport> }` keeps the bar stretched to the full viewport so the
// .hud actually spans the width under test (it's a flex container that would
// otherwise size to content), making overflow measurable at the target width.
let fontStyle: HTMLStyleElement;
beforeEach(() => {
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root { --font-mono: ui-monospace, monospace; }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; }`;
  document.head.appendChild(fontStyle);
});
afterEach(() => {
  vi.useRealTimers();
  fontStyle.remove();
  document.body.innerHTML = "";
  document.body.style.width = "";
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

function sessionsProp(working: number) {
  return { sessions: sessions(working) };
}

interface Scenario {
  name: string;
  mode: Mode;
  width: number;
  props: Record<string, unknown>;
}

const allBadges = {
  learnings: 3,
  update: { behind: 4 } as UpdateStatus,
  herdrUpdate: { updateAvailable: true } as HerdrUpdateStatus,
  whatsNew: true,
};

// Production-worst desktop chrome: both usage windows render as inline gauges
// (gaugeList yields a gauge per non-null window), widening the bar further.
const fullLimits: UsageLimits = {
  session5h: { pct: 88, resetAt: 1_700_003_600_000 },
  week: { pct: 64, resetAt: 1_700_600_000_000 },
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: 1_700_000_000_000,
  subscriptionOnly: false,
};

const SCENARIOS: Scenario[] = [
  // The #322 device: unfolded Pixel at 1000px (touch-desktop).
  {
    name: "touch-desktop 1000 — all badges",
    mode: "touch-desktop",
    width: 1000,
    props: { ...allBadges, ...sessionsProp(2) },
  },
  {
    name: "touch-desktop 1000 — dual-update + learnings + whatsNew",
    mode: "touch-desktop",
    width: 1000,
    props: {
      learnings: 2,
      update: { behind: 1 },
      herdrUpdate: { updateAvailable: true },
      whatsNew: true,
      ...sessionsProp(0),
    },
  },
  {
    name: "touch-desktop 1000 — lone learnings (#322 regression)",
    mode: "touch-desktop",
    width: 1000,
    props: { learnings: 4, ...sessionsProp(0) },
  },
  {
    name: "touch-desktop 960 — all badges (bracket)",
    mode: "touch-desktop",
    width: 960,
    props: { ...allBadges, ...sessionsProp(2) },
  },
  // Phones.
  {
    name: "mobile 390 — all badges",
    mode: "mobile",
    width: 390,
    props: { ...allBadges, ...sessionsProp(2) },
  },
  {
    name: "mobile 280 — all badges (fold cover)",
    mode: "mobile",
    width: 280,
    props: { ...allBadges, ...sessionsProp(2) },
  },
  // Desktop.
  //
  // The TRUE cap: `TopBar` sits inside `.shell` (max-width:1480, 22px padding each
  // side, border-box), so the widest inner width the bar EVER gets, on any monitor,
  // is 1480 − 22 − 22 = 1436px. Every desktop fit-critical scenario measures at
  // that real usable cap (1436), with the WIDEST badge selection for the count
  // under test — NOT at 1480, which over-states the available width and would mask
  // a real overflow. (A non-touch desktop *window* narrower than ~1480px viewport
  // has usable < 1436 and may still clip; that sub-1480 edge is documented
  // out-of-scope — we do not assert the impossible for tiny desktop windows.)
  //
  // FIXED (#322-desktop, then width-aware): with every badge active the desktop
  // bar's full-label content is ~1700px (with gauges: base 1055 + per-badge deltas;
  // the halt e-stop lives in the gear menu, not the bar) and had NO fallback — desktop never
  // compacted, so it overflowed 1436 on every monitor. Desktop compaction is now
  // MEASUREMENT-DRIVEN in TopBar.svelte (measureFull + decideFromCache): the bar
  // compacts (labels → icons, Mission-Control label hides) iff it
  // would actually overflow its container at the current width. These scenarios
  // assert the crunched form fits — strict, no skip. The measurement happens in a
  // requestAnimationFrame, so the runner waits for it to settle before asserting.
  {
    name: "desktop 1280 — all badges",
    mode: "desktop",
    width: 1280,
    props: { ...allBadges, ...sessionsProp(2) },
  },
  // Production-worst overload: all six badges AND both usage gauges, at the usable
  // cap (1436) and at 1280. Measured compacted intrinsic width ≈ 1135px ≪ 1436 → fits
  // with wide margin (the icon-collapsed cluster is far narrower than the full-label
  // form, which would be ~1751px).
  {
    name: "desktop 1436 — all badges + gauges (usable cap, compacts + fits)",
    mode: "desktop",
    width: 1436,
    props: { ...allBadges, ...sessionsProp(2), limits: fullLimits },
  },
  {
    name: "desktop 1280 — all badges + gauges",
    mode: "desktop",
    width: 1280,
    props: { ...allBadges, ...sessionsProp(2), limits: fullLimits },
  },
  // ── Width-awareness: narrow desktop windows the old count-3 threshold MISSED ──
  // A ~1366px laptop gives the bar ~1322px usable; a ~1280px window ~1236px. With
  // the production-worst chrome (both usage gauges present), the full-label bar
  // measures ~1333px for 2 badges (learnings + update) and ~1450px for 3 — so it
  // overflows BOTH narrow widths even at just 2 badges, which the old count-3
  // threshold never compacted. Runtime measurement does. Each asserts the bar
  // compacts just enough to NOT overflow + keeps controls hittable. (Verified: with
  // the measured-OR removed these overflow — full 1333/1450 vs client 1320/1234 —
  // so they genuinely exercise the fix.)
  {
    name: "desktop 1322 — 2 full-label badges + gauges (1366px laptop, measured compaction)",
    mode: "desktop",
    width: 1322,
    props: { learnings: 2, update: { behind: 3 }, limits: fullLimits, ...sessionsProp(0) },
  },
  {
    name: "desktop 1322 — 3 badges + gauges (1366px laptop, measured compaction)",
    mode: "desktop",
    width: 1322,
    props: {
      learnings: 2,
      update: { behind: 2 },
      herdrUpdate: { updateAvailable: true },
      limits: fullLimits,
      ...sessionsProp(0),
    },
  },
  {
    name: "desktop 1236 — 2 full-label badges + gauges (1280px window, measured compaction)",
    mode: "desktop",
    width: 1236,
    props: { learnings: 2, update: { behind: 3 }, limits: fullLimits, ...sessionsProp(0) },
  },
  {
    name: "desktop 1236 — 3 badges + gauges (1280px window, measured compaction)",
    mode: "desktop",
    width: 1236,
    props: {
      learnings: 2,
      update: { behind: 2 },
      herdrUpdate: { updateAvailable: true },
      limits: fullLimits,
      ...sessionsProp(0),
    },
  },
  // Empty baseline.
  {
    name: "touch-desktop 1000 — no badges",
    mode: "touch-desktop",
    width: 1000,
    props: { ...sessionsProp(0) },
  },
];

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

// Compaction is decided in a requestAnimationFrame after render (desktop AND
// touch-desktop now — both are measurement-driven), so the no-overflow check has to wait
// for that frame to land. vi.waitFor re-runs the assertion until it passes OR the timeout
// fires (then it surfaces the last failure) — so a render that genuinely keeps
// overflowing still FAILS the test; it can't be masked by polling. (Only MOBILE settles
// on the first tick — it wraps synchronously via the `mobile` flag — so the wait is a
// no-op there.)
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// Drain pending rAF-deferred measurement work: spin frames until the measured
// compaction class stops changing across two consecutive frames (quiescent), so no
// stale measuring frame remains queued. Bounded so a genuinely oscillating bar can't
// hang the test.
async function drainFrames(bar: HTMLElement, maxFrames = 20) {
  // .search (TopBarSearch) always renders on desktop/touch-desktop (unlike the old
  // learnings badge, which was conditional on learnings/learningsCurate > 0), so it's
  // a reliable universal signal for "has the measured-compaction pass settled".
  const read = () => bar.querySelector(".search")?.classList.contains("compact");
  let prev = read();
  let stable = 0;
  for (let i = 0; i < maxFrames && stable < 2; i++) {
    await nextFrame();
    const cur = read();
    stable = cur === prev ? stable + 1 : 0;
    prev = cur;
  }
}

async function waitNoOverflow(el: HTMLElement) {
  await vi.waitFor(
    () => {
      expect(el.scrollWidth, `${el.className} overflows`).toBeLessThanOrEqual(el.clientWidth + 1);
    },
    { timeout: 1000 },
  );
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
      // Pin the mount host to the viewport width so the bar (a flex container that
      // would otherwise shrink-wrap its content) actually spans the width under test.
      document.body.style.width = `${s.width}px`;
      render(TopBar, baseProps(s));
      const hud = document.querySelector<HTMLElement>(".hud");
      expect(hud, "TopBar .hud mounted").not.toBeNull();
      await waitNoOverflow(hud!);
      assertControlsHittable(hud!);
    });
  }
});

describe("TopBar — touch-desktop (unfolded fold) overflow is measurement-driven", () => {
  // Unfolded foldables are touch + wider-than-768px → "touch-desktop", but at WILDLY
  // varying widths (a fold ~800px vs an iPad landscape ~1366px). The old count-based
  // rule kept a lone badge labelled regardless of width, so a lone ✦ LEARNINGS 87 label
  // overflowed and pushed the gear out on a narrow fold — while ALSO over-compacting 2+
  // badges on a wide tablet. Compaction is now runtime-measured for touch-desktop too
  // (same path as desktop). On touch the usage gauges collapse to a single .gauge-btn
  // (TopBarUsage), so fullLimits here renders that collapsed button, matching the
  // reported screenshot (5H ▭ 46%).
  async function renderTD(width: number, extra: Record<string, unknown>) {
    await page.viewport(width, 900);
    document.body.style.width = `${width}px`;
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS["touch-desktop"],
      ...sessionsProp(0),
      limits: fullLimits,
      ...extra,
    });
    const hud = document.querySelector<HTMLElement>(".hud");
    expect(hud, "TopBar .hud mounted").not.toBeNull();
    return hud!;
  }

  it("wide tablet (1366): two badges keep full labels (old count-floor over-compaction is gone)", async () => {
    const hud = await renderTD(1366, {
      update: { behind: 3 } as UpdateStatus,
      herdrUpdate: { updateAvailable: true } as HerdrUpdateStatus,
    });
    await nextFrame();
    await nextFrame();
    await drainFrames(hud);
    assertNoOverflow(hud);
    expect(
      hud.querySelector(".search")!.classList.contains("compact"),
      "search full at wide tablet",
    ).toBe(false);
    expect(hud.querySelector(".update-badge .up-label"), "update full label kept").not.toBeNull();
    expect(
      hud.querySelector(".update-badge.herdr .up-label"),
      "herdr full label kept",
    ).not.toBeNull();
    assertControlsHittable(hud);
  });

  it("label-collapse and tally-collapse are COUPLED across all widths (#322 two-step ladder dropped)", async () => {
    // The single measured signal couples the two rendered compaction observables: on a
    // measured overflow the labels AND the tallies collapse to icons together — there is NO
    // labels-collapsed-but-tallies-full intermediate (the deliberate loss of #322's two-step
    // ladder, matching desktop). Asserted as an invariant over a width sweep rather than a
    // fixed band, so it's independent of font metrics (the exact transition width varies
    // by the monospace fallback). At every width: labels-compacted iff tallies-compacted; and
    // the sweep must exercise BOTH states (a wide width stays full, a narrow width
    // compacts) so the invariant can't pass vacuously.
    // Widths start at 800 (proven to fit once compacted, in CI + local) and span up to a
    // wide tablet; the exact compact↔full transition is font-dependent, but coupling must
    // hold at every width regardless. `.search` (TopBarSearch, always rendered) is the
    // labels-compacted signal; `.tallies.compact` is the tallies signal — both keyed off the
    // same `compactBadges` (this replaces the old numeric-clock observable, now removed).
    const states: { width: number; labelsCompact: boolean; talliesCompact: boolean }[] = [];
    for (const width of [800, 880, 960, 1100, 1250, 1366]) {
      const hud = await renderTD(width, { update: { behind: 87 } as UpdateStatus });
      await waitNoOverflow(hud);
      await drainFrames(hud);
      const labelsCompact = hud
        .querySelector<HTMLElement>(".search")!
        .classList.contains("compact");
      const talliesCompact = !!hud.querySelector(".tallies.compact");
      expect(labelsCompact, `coupled at ${width}px (labels vs tallies)`).toBe(talliesCompact);
      assertControlsHittable(hud);
      states.push({ width, labelsCompact, talliesCompact });
    }
    expect(
      states.some((s) => s.labelsCompact),
      "sweep exercises the compacted state (some narrow width compacts labels + tallies)",
    ).toBe(true);
    expect(
      states.some((s) => !s.labelsCompact),
      "sweep exercises the full state (some wide width keeps labels + tallies full)",
    ).toBe(true);
  });

  it("tallies COLLAPSE under measured overflow and stay FULL when there's room (held + update + gauges)", async () => {
    // The reported bug: on an unfolded fold the right-side cluster compacts but the tallies
    // (HERD/BUSY/IDLE/BLOCKED) stay full-label off-`mobile`, so the bar still overflows and
    // clips the gear. The fix extends compaction to the tallies on touch. Asserted as the
    // same coupling invariant the test above uses — but for the TALLIES — over a width sweep,
    // so it's robust to the CI monospace fallback's font metrics (the exact transition width
    // varies). Content mirrors the screenshot: held badge + an update badge + several sessions
    // (non-zero tallies) + both usage gauges. The update badge is present so `drainFrames`
    // (which keys off `.search`, always rendered) still has settled compaction to observe.
    const states: { width: number; labelsCompact: boolean; talliesCompact: boolean }[] = [];
    for (const width of [800, 920, 1040, 1200, 1400, 1600]) {
      const hud = await renderTD(width, {
        ...sessionsProp(4),
        heldCount: 3,
        update: { behind: 2 } as UpdateStatus,
      });
      await waitNoOverflow(hud);
      await drainFrames(hud);
      const labelsCompact = hud
        .querySelector<HTMLElement>(".search")!
        .classList.contains("compact");
      const talliesCompact = !!hud.querySelector(".tallies.compact");
      // Coupling: tallies compact iff the measured-overflow signal fired (labels compacted).
      expect(talliesCompact, `tallies coupled to overflow signal at ${width}px`).toBe(
        labelsCompact,
      );
      // Whichever form rendered, it must be the right one — never both, never neither.
      if (talliesCompact) {
        expect(hud.querySelector(".tally"), `no full tally at ${width}px`).toBeNull();
      } else {
        expect(hud.querySelector(".tally"), `full tally present at ${width}px`).not.toBeNull();
        expect(hud.querySelector(".micro"), `full tally label at ${width}px`).not.toBeNull();
      }
      assertControlsHittable(hud);
      states.push({ width, labelsCompact, talliesCompact });
    }
    expect(
      states.some((s) => s.talliesCompact),
      "sweep exercises the compacted state (a narrow fold collapses the tallies)",
    ).toBe(true);
    expect(
      states.some((s) => !s.talliesCompact),
      "sweep exercises the full state (a wide tablet keeps full tally labels — no over-compaction)",
    ).toBe(true);
  });
});

describe("TopBar — wide desktop keeps full labels (measurement does NOT over-compact)", () => {
  // Width-awareness must not over-fire: at the TRUE usable cap (1436px = .shell
  // 1480 - 2x22 padding) a wide 2-badge selection (learnings + update ~1354px
  // incl. both usage gauges) STILL FITS, so the measured path must leave it FULL —
  // proving compaction triggers on real overflow, not merely on badge presence.
  // Settle the rAF first (the measurement might briefly flip), then assert it stays
  // non-compact. Plus a no-gauge variant. Both keep full labels AND fit 1436.
  //
  // Asserts: (a) the update + herdr-update badges and the search pill are present and
  // showing their FULL labels (search not in .compact form; the update badge still
  // rendering its .up-label word), (b) no overflow, (c) all controls hittable -
  // catching a future left-cluster or gap change that silently overflows the
  // non-compact desktop path. (Sub-1436px desktop windows have less usable width and
  // DO compact — covered by the narrow-desktop scenarios above.)
  const cases: Array<{ limits: UsageLimits | null; desc: string }> = [
    { limits: fullLimits, desc: "usable cap with gauges (worst-case chrome)" },
    { limits: null, desc: "usable cap no gauges" },
  ];

  for (const { limits, desc } of cases) {
    it(`desktop 1436 — full labels, no overflow (${desc})`, async () => {
      await page.viewport(1436, 900);
      document.body.style.width = "1436px";
      render(TopBar, {
        nowMs: 1_700_000_000_000,
        connected: true,
        mobile: false,
        touch: false,
        // One full-label badge (update) — the always-on search pill now occupies a
        // fixed 180px baseline the old scenario (learnings + update) didn't carry, so
        // the widest-still-fits case at the true usable cap is one badge, not two.
        update: { behind: 3 } as UpdateStatus,
        limits,
        ...sessionsProp(0),
      });
      const hud = document.querySelector<HTMLElement>(".hud");
      expect(hud, "TopBar .hud mounted").not.toBeNull();

      // Let the rAF-driven measurement settle (two frames), then assert it left the
      // bar FULL — at this width it fits, so it must not have compacted.
      await nextFrame();
      await nextFrame();

      // Full-label: both badges present and the search pill NOT in compact (icon-only) form.
      const update = hud!.querySelector<HTMLElement>(".update-badge");
      const search = hud!.querySelector<HTMLElement>(".search");
      expect(update, "update badge present").not.toBeNull();
      expect(search, "search pill present").not.toBeNull();
      expect(search!.classList.contains("compact"), "search pill NOT compact").toBe(false);
      // The full word label renders inside the update badge (compact form omits it).
      const upLabel = update!.querySelector<HTMLElement>(".up-label");
      expect(upLabel, "update full label present").not.toBeNull();
      expect(upLabel!.textContent ?? "", "update full label text").toContain(
        m.topbar_update_badge(),
      );
      expect(update!.getBoundingClientRect().width, "update has width").toBeGreaterThan(0);
      expect(search!.getBoundingClientRect().width, "search has width").toBeGreaterThan(0);

      // Must still not overflow despite showing full labels.
      assertNoOverflow(hud!);
      assertControlsHittable(hud!);
    });
  }
});

describe("TopBar — pure resize decides from cached full width (no flicker)", () => {
  // The resize-flicker fix: a pure window-resize (content unchanged) must decide
  // compaction from the CACHED full-label width vs the new clientWidth — WITHOUT
  // resetting to full first. So a bar settled compact at a narrow width, then resized
  // to another still-narrow width, must STAY compact and never overflow. (Pre-fix the
  // ResizeObserver reset to full on every frame, flashing full→compact each tick.)
  //
  // We can't observe the intermediate full-flash frame deterministically, but we CAN
  // assert the end state across a resize that keeps the bar narrow: still compact, no
  // overflow. drainFrames ensures no stale full-measuring frame is left pending that
  // could mask a regression.
  it("desktop wide→narrow pure resize compacts via cached width (no content change)", async () => {
    // Settle FULL at a wide width that fits, then RESIZE NARROW with content
    // unchanged. The ONLY thing that can react is the ResizeObserver's cached-width
    // path (decideFromCache) — no content-change effect fires — so this isolates the
    // resize path: it must compact the bar to fit the narrower width WITHOUT a
    // reset-to-full (which is what caused the per-frame flicker pre-fix).
    await page.viewport(1436, 900);
    document.body.style.width = "1436px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      mobile: false,
      touch: false,
      // One full-label badge + both gauges + the always-on search pill: fits 1436,
      // overflows 1236.
      update: { behind: 3 } as UpdateStatus,
      limits: fullLimits,
      ...sessionsProp(0),
    });
    const hud = document.querySelector<HTMLElement>(".hud");
    expect(hud, "TopBar .hud mounted").not.toBeNull();

    // Settle the initial content-change measurement → fits 1436, stays FULL.
    await waitNoOverflow(hud!);
    await drainFrames(hud!);
    expect(
      hud!.querySelector(".search")?.classList.contains("compact"),
      "full (not compact) at 1436",
    ).toBe(false);

    // Pure RESIZE narrow (content unchanged): only decideFromCache can fire. It must
    // compact from the cached full width vs the new clientWidth, and the bar must fit.
    await page.viewport(1236, 900);
    document.body.style.width = "1236px";
    await drainFrames(hud!);
    expect(
      hud!.querySelector(".search")?.classList.contains("compact"),
      "compacts after wide→narrow resize (cached-width path)",
    ).toBe(true);
    assertNoOverflow(hud!);
    assertControlsHittable(hud!);
  });
});

describe("TopBar — async gauge arrival re-measures (reactivity gap)", () => {
  // Reproduces the real production ordering the width-aware compaction must survive:
  // `limits` (store.usageLimits) starts null and is populated AFTER first paint
  // (snapshot/SSE). The two full-label badges alone are ~1113px intrinsic; once the
  // two inline usage gauges arrive the bar jumps to ~1353px. At a ~1250px-usable
  // desktop window the FIRST render (no gauges, 1113 < 1250) fits, so
  // desktopCompact=false — then the gauges land and the bar would overflow (1353 >
  // 1250). In production that arrival changes NEITHER mode/badgeCount NOR the
  // .shell-capped box width (only inner content grows, going to scrollWidth), so unless
  // the MEASURE EFFECT itself tracks the gauges, nothing re-fires and the bar silently
  // overflows. This asserts the bar re-measures on null→populated and ends NON-overflowing.
  //
  // Two test-rig details make this faithful AND able to catch the bug:
  //
  // 1. Harness, not rerender(): vitest-browser-svelte's rerender() replaces the WHOLE
  //    prop bag via $state.raw, re-reading every prop the component touches and
  //    spuriously re-firing the measure effect even without the gauge dependency —
  //    masking the bug. TopBarLimitsHarness flips ONLY its internal `limits` $state
  //    (via setLimits), so null→populated is the sole change, matching the live store.
  //
  // 2. ResizeObserver stubbed to a no-op for this case: in production the bar's box is
  //    width-capped by .shell and the gauges fit within the existing row height, so the
  //    RO does NOT fire on gauge arrival. In this unconstrained test mount the gauges
  //    would jitter the .hud box and the RO would fire and self-heal, hiding the
  //    effect-level gap. Disabling it isolates the effect as the sole recompaction path
  //    — exactly the path the fix lives on.
  //
  // Mutation check (verified): with `void gauges.length` removed from the measure
  // effect in TopBar.svelte, this test FAILS — with the RO disabled nothing re-measures
  // on gauge arrival, the bar stays full-label and overflows (scroll ~1353 > client
  // ~1250). Restoring the gauge read makes it pass.
  it("desktop 1252 — gauges arrive after mount, bar re-compacts to fit", async () => {
    await page.viewport(1252, 900);
    document.body.style.width = "1252px";

    const RealResizeObserver = globalThis.ResizeObserver;
    class NoopResizeObserver {
      // Mirror the real ResizeObserver(callback) signature so static analysis
      // doesn't read our production `new ResizeObserver(cb)` as a superfluous arg.
      constructor(readonly cb?: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
    try {
      // Widest available desktop chrome via the harness, but limits START null: the
      // full-label content fits the ~1250px window → no gauges, desktopCompact=false.
      const { component } = await render(TopBarLimitsHarness, {
        nowMs: 1_700_000_000_000,
        connected: true,
        mobile: false,
        touch: false,
        update: { behind: 3 } as UpdateStatus,
        ...sessionsProp(0),
      });
      const hud = document.querySelector<HTMLElement>(".hud");
      expect(hud, "TopBar .hud mounted").not.toBeNull();

      // Settle the initial measurement: no gauges yet, fits, stays full (not compacted).
      await waitNoOverflow(hud!);
      // Fully drain initial-mount measurement churn: the bar settles through several
      // measure passes, each scheduling a requestAnimationFrame. Wait until no further
      // rAF-deferred work lands, so NO stale measuring frame is left pending — otherwise
      // one could fire after the gauges render and self-heal the bar, masking the bug.
      await drainFrames(hud!);
      expect(hud!.querySelector(".gauges"), "no gauges before limits arrive").toBeNull();
      expect(
        hud!.querySelector(".search")?.classList.contains("compact"),
        "not compacted before gauges arrive",
      ).toBe(false);

      // ASYNC arrival: limits populate after first paint → both inline gauges render,
      // pushing intrinsic width to ~1353 > ~1250. With the RO stubbed, ONLY the
      // gauge-tracking measure effect can react and re-compact the bar.
      component.setLimits(fullLimits);
      await nextFrame();
      expect(hud!.querySelector(".gauges"), "gauges render after limits arrive").not.toBeNull();

      // The re-measure (driven by the tracked gauge read) must compact the bar back to
      // a fitting form. waitNoOverflow re-runs until the rAF lands OR times out into a
      // real failure — a bar that genuinely keeps overflowing still fails here.
      await waitNoOverflow(hud!);
      assertControlsHittable(hud!);
    } finally {
      globalThis.ResizeObserver = RealResizeObserver;
    }
  });
});

describe("TopBar — fine-pointer desktop tallies ALSO collapse under measured overflow", () => {
  // Tally compaction is gated on the measured-overflow signal (`compactBadges`), matching the
  // sibling NEEDS-YOU / held badges — NOT on `touch`, so a NARROW fine-pointer desktop window
  // (a small/split-screen window, still wider than the 768px mobile breakpoint) doesn't keep
  // full-label tallies after the right side has compacted and overflow the bar. Desktop renders
  // BOTH usage gauges inline (wider than touch's single collapsed gauge-btn), so it overflows
  // EARLIER than touch-desktop — exactly the case the `touch &&` guard would have left unfixed.
  // Same font-robust coupling-sweep shape as the touch-desktop test above.
  async function renderDesktopBar(width: number, extra: Record<string, unknown>) {
    await page.viewport(width, 900);
    document.body.style.width = `${width}px`;
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      ...sessionsProp(2),
      limits: fullLimits,
      ...extra,
    });
    const hud = document.querySelector<HTMLElement>(".hud");
    expect(hud, "TopBar .hud mounted").not.toBeNull();
    return hud!;
  }

  it("narrow desktop window collapses the tallies to fit; wide keeps full labels (no over-compaction)", async () => {
    const states: { width: number; labelsCompact: boolean; talliesCompact: boolean }[] = [];
    for (const width of [1000, 1150, 1350, 1500, 1650]) {
      const hud = await renderDesktopBar(width, {
        heldCount: 3,
        update: { behind: 2 } as UpdateStatus,
      });
      await waitNoOverflow(hud);
      await drainFrames(hud);
      const labelsCompact = hud
        .querySelector<HTMLElement>(".search")!
        .classList.contains("compact");
      const talliesCompact = !!hud.querySelector(".tallies.compact");
      expect(talliesCompact, `tallies coupled to overflow signal at ${width}px`).toBe(
        labelsCompact,
      );
      if (talliesCompact) {
        expect(hud.querySelector(".tally"), `no full tally at ${width}px`).toBeNull();
      } else {
        expect(hud.querySelector(".tally"), `full tally present at ${width}px`).not.toBeNull();
      }
      assertControlsHittable(hud);
      states.push({ width, labelsCompact, talliesCompact });
    }
    expect(
      states.some((s) => s.talliesCompact),
      "sweep exercises the compacted state (a narrow desktop window collapses the tallies)",
    ).toBe(true);
    expect(
      states.some((s) => !s.talliesCompact),
      "sweep exercises the full state (a wide desktop keeps full tally labels — no over-compaction)",
    ).toBe(true);
  });
});

describe("TopBar — async held-task arrival re-measures (touch-desktop reactivity gap)", () => {
  // The held badge (added in #1089) appears via the held:changed WS event AFTER first paint.
  // Like the gauge-arrival case above, its arrival changes NEITHER mode NOR the .shell-capped
  // box width — only inner content grows, going to scrollWidth — so unless the measure effect
  // tracks held state, nothing re-fires and the bar silently overflows. Held is folded into
  // ChromeState/badgeCount so the effect's `void badgeCount(chrome)` read covers it. On
  // touch-desktop the recompaction also collapses the tallies (the fix), which is what lets
  // the bar fit at this narrow fold width once held arrives.
  //
  // Same two rig details as the gauge test make it faithful AND able to catch the bug:
  //   1. Harness flips ONLY heldCount (setHeld), not the whole prop bag (rerender would
  //      re-read every prop and spuriously re-fire the effect, masking the gap).
  //   2. ResizeObserver stubbed to a no-op so the effect is the SOLE recompaction path —
  //      in production the RO doesn't fire on held arrival (the box stays put), but an
  //      unconstrained test mount would jitter the box and self-heal, hiding the gap.
  //
  // Mutation check (verified): removing `held` from badgeCount (top-bar-layout.ts) OR from
  // the `chrome` object (TopBar.svelte) makes this FAIL — with the RO stubbed nothing
  // re-measures on held arrival, the bar stays full-tally and overflows. Restoring it passes.
  it("touch-desktop 1050 — a task is held after mount, bar re-compacts the tallies to fit", async () => {
    // 1050 is the window where the held badge is the deciding factor: held=0 fits with FULL
    // tallies; held=3 overflows and only fits once the tallies collapse (probed). Wider and
    // held fits without compaction; narrower and the bar is already compact before held.
    // (Widened from the pre-search-pill 880 baseline: the always-on TopBarSearch pill adds
    // fixed width to every touch-desktop render, shifting the deciding width upward.)
    await page.viewport(1050, 900);
    document.body.style.width = "1050px";

    const RealResizeObserver = globalThis.ResizeObserver;
    class NoopResizeObserver {
      // Mirror the real ResizeObserver(callback) signature so static analysis
      // doesn't read our production `new ResizeObserver(cb)` as a superfluous arg.
      constructor(readonly cb?: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
    try {
      // Mount fitting: gauges present + constant, but heldCount starts 0 → the bar fits 800
      // with full tallies (the existing lone-content touch-desktop 800 cases fit).
      const { component } = await render(TopBarLimitsHarness, {
        nowMs: 1_700_000_000_000,
        connected: true,
        ...FLAGS["touch-desktop"],
        ...sessionsProp(2),
        initialLimits: fullLimits,
        initialHeldCount: 0,
      });
      const hud = document.querySelector<HTMLElement>(".hud");
      expect(hud, "TopBar .hud mounted").not.toBeNull();

      // Settle the initial measurement and fully drain churn so no stale measuring frame is
      // left pending that could self-heal after held arrives and mask the bug.
      await waitNoOverflow(hud!);
      await drainFrames(hud!);
      expect(hud!.querySelector(".held-badge"), "no held badge before held arrives").toBeNull();
      expect(
        hud!.querySelector(".tallies.compact"),
        "tallies full before held arrives (bar fits)",
      ).toBeNull();

      // ASYNC arrival: a task is held → the held badge renders, pushing the bar over 800.
      // With the RO stubbed, ONLY the held-tracking measure effect can react and re-compact.
      component.setHeld(3);
      await nextFrame();
      expect(hud!.querySelector(".held-badge"), "held badge renders after arrival").not.toBeNull();

      // The re-measure (driven by the tracked badgeCount read now containing held) must
      // re-compact the bar back to a fitting form — collapsing the tallies on touch-desktop.
      await waitNoOverflow(hud!);
      expect(
        hud!.querySelector(".tallies.compact"),
        "tallies collapse on held arrival so the bar fits",
      ).not.toBeNull();
      assertControlsHittable(hud!);
    } finally {
      globalThis.ResizeObserver = RealResizeObserver;
    }
  });
});

describe("TopBar — tallies toggle the status filter", () => {
  const behaviorBase = {
    nowMs: 1_700_000_000_000,
    connected: true,
    ...sessionsProp(2),
  };

  it("desktop: clicking a status tally sets the filter; clicking it again clears", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onstatusfilter = vi.fn();
    render(TopBar, { ...behaviorBase, ...FLAGS.desktop, onstatusfilter });
    const busy = page.getByTitle(m.topbar_tally_filter_title({ status: m.topbar_working_label() }));
    await expect.element(busy).toHaveAttribute("aria-pressed", "false");
    // no filter active → the total (clear) tally is a no-op and renders disabled
    await expect.element(page.getByTitle(m.topbar_tally_clear_title())).toBeDisabled();
    await busy.click();
    expect(onstatusfilter).toHaveBeenCalledWith("running");
  });

  it("desktop: an active tally renders pressed and toggles back to null", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onstatusfilter = vi.fn();
    render(TopBar, {
      ...behaviorBase,
      ...FLAGS.desktop,
      statusFilter: "running" as const,
      onstatusfilter,
    });
    const busy = page.getByTitle(m.topbar_tally_filter_title({ status: m.topbar_working_label() }));
    await expect.element(busy).toHaveAttribute("aria-pressed", "true");
    await busy.click();
    expect(onstatusfilter).toHaveBeenCalledWith(null);
  });

  it("desktop: the Herd tally clears the filter", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onstatusfilter = vi.fn();
    render(TopBar, {
      ...behaviorBase,
      ...FLAGS.desktop,
      statusFilter: "blocked" as const,
      onstatusfilter,
    });
    await page.getByTitle(m.topbar_tally_clear_title()).click();
    expect(onstatusfilter).toHaveBeenCalledWith(null);
  });

  it("mobile compact: the status segments toggle the same filter", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    const onstatusfilter = vi.fn();
    render(TopBar, { ...behaviorBase, ...FLAGS.mobile, onstatusfilter });
    // the accessible name must carry the COUNT, not just the action (the visible
    // text is a bare digit) — and the no-op total renders disabled
    await expect
      .element(page.getByRole("button", { name: m.topbar_tally_total_aria({ count: 2 }) }))
      .toBeDisabled();
    await page
      .getByRole("button", {
        name: m.topbar_tally_status_aria({ status: m.topbar_blocked_label(), count: 0 }),
      })
      .click();
    expect(onstatusfilter).toHaveBeenCalledWith("blocked");
  });

  it("mobile compact: clicking the active segment clears; total clears too", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    const onstatusfilter = vi.fn();
    render(TopBar, {
      ...behaviorBase,
      ...FLAGS.mobile,
      statusFilter: "idle" as const,
      onstatusfilter,
    });
    const idleSeg = page.getByRole("button", {
      name: m.topbar_tally_status_aria({ status: m.topbar_idle_label(), count: 0 }),
    });
    await expect.element(idleSeg).toHaveAttribute("aria-pressed", "true");
    await idleSeg.click();
    expect(onstatusfilter).toHaveBeenLastCalledWith(null);
    await page.getByRole("button", { name: m.topbar_tally_total_aria({ count: 2 }) }).click();
    expect(onstatusfilter).toHaveBeenLastCalledWith(null);
  });
});

describe("TopBarHeldBadge — mobile held-task dialog", () => {
  it("opens as a full-width dialog with comfortable touch actions on iPhone width", async () => {
    await page.viewport(390, 844);
    document.body.style.width = "390px";
    const closeHeldPop = vi.fn();
    const heldItems: HeldTask[] = [
      {
        id: "held-1",
        repoPath: "/work/shepherd",
        createdAt: 1_700_000_000_000,
        input: {
          repoPath: "/work/shepherd",
          baseBranch: "main",
          prompt: "Die Buttons sind hier der Engpass auf meinem Smartphone",
          agentProvider: "claude",
          model: null,
        },
      },
    ];

    render(TopBarHeldBadge, {
      heldCount: 1,
      mobile: true,
      compactBadges: false,
      hotter: null,
      nowMs: 1_700_000_000_000,
      heldPopFlipUp: false,
      heldItems,
      heldLoading: false,
      heldAutoRelease: true,
      heldAutoReleaseBusy: false,
      toggleHeldAutoRelease: vi.fn(),
      heldPopOpen: true,
      heldBadgeBtn: null,
      heldPopEl: null,
      toggleHeldPop: vi.fn(),
      closeHeldPop,
      doSpawnHeld: vi.fn(),
      doDiscardHeld: vi.fn(),
      onEditHeld: vi.fn(),
    });
    await nextFrame();

    const dialog = document.querySelector<HTMLElement>(".held-fullscreen");
    expect(dialog, "mobile held dialog rendered").not.toBeNull();
    const dialogRect = dialog!.getBoundingClientRect();
    expect(Math.round(dialogRect.left)).toBe(0);
    expect(Math.round(dialogRect.right)).toBe(390);
    expect(dialogRect.height).toBeGreaterThan(800);
    await expect.element(page.getByRole("dialog", { name: m.topbar_held_title() })).toBeVisible();

    const close = page.getByRole("button", { name: m.common_close() });
    const closeBox = (close.element() as HTMLElement).getBoundingClientRect();
    expect(closeBox?.width).toBeGreaterThanOrEqual(44);
    expect(closeBox?.height).toBeGreaterThanOrEqual(44);

    const spawn = page.getByRole("button", { name: m.topbar_held_spawn_now() });
    const discard = page.getByRole("button", { name: m.topbar_held_discard() });
    const spawnBox = (spawn.element() as HTMLElement).getBoundingClientRect();
    const discardBox = (discard.element() as HTMLElement).getBoundingClientRect();
    expect(spawnBox?.height).toBeGreaterThanOrEqual(44);
    expect(discardBox?.height).toBeGreaterThanOrEqual(44);
    expect(spawnBox?.width).toBeGreaterThan(150);
    expect(discardBox?.width).toBeGreaterThan(150);

    await close.click();
    expect(closeHeldPop).toHaveBeenCalledWith(true);
  });

  it("shows an inline error when a held-task spawn was refused server-side", async () => {
    await page.viewport(390, 844);
    document.body.style.width = "390px";
    const heldItems: HeldTask[] = [
      {
        id: "held-1",
        repoPath: "/work/shepherd",
        createdAt: 1_700_000_000_000,
        input: {
          repoPath: "/work/shepherd",
          baseBranch: "main",
          prompt: "Die Buttons sind hier der Engpass auf meinem Smartphone",
          agentProvider: "claude",
          model: null,
        },
      },
    ];

    render(TopBarHeldBadge, {
      heldCount: 1,
      mobile: true,
      compactBadges: false,
      hotter: null,
      nowMs: 1_700_000_000_000,
      heldPopFlipUp: false,
      heldItems,
      heldLoading: false,
      heldErrors: { "held-1": { kind: "spawn", detail: "task name already in use, retry" } },
      heldAutoRelease: true,
      heldAutoReleaseBusy: false,
      toggleHeldAutoRelease: vi.fn(),
      heldPopOpen: true,
      heldBadgeBtn: null,
      heldPopEl: null,
      toggleHeldPop: vi.fn(),
      closeHeldPop: vi.fn(),
      doSpawnHeld: vi.fn(),
      doDiscardHeld: vi.fn(),
      onEditHeld: vi.fn(),
    });
    await nextFrame();

    // The failure surfaces inline (a toast would render behind the fullscreen dialog),
    // announced assertively so it reaches a screen reader.
    await expect.element(page.getByRole("alert")).toHaveTextContent(m.topbar_held_spawn_failed());
    // …and carries the server's real cause so the operator can see *why* it failed.
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("task name already in use, retry");
  });

  it("shows in-flight state on the spawn button while a held-task spawn is pending", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const heldItems: HeldTask[] = [
      {
        id: "held-1",
        repoPath: "/work/shepherd",
        createdAt: 1_700_000_000_000,
        input: {
          repoPath: "/work/shepherd",
          baseBranch: "main",
          prompt: "In der Dashboard-Übersicht",
          agentProvider: "claude",
          model: null,
        },
      },
    ];

    render(TopBarHeldBadge, {
      heldCount: 1,
      mobile: false,
      compactBadges: false,
      hotter: null,
      nowMs: 1_700_000_000_000,
      heldPopFlipUp: false,
      heldItems,
      heldLoading: false,
      heldPending: { "held-1": "spawn" },
      heldAutoRelease: true,
      heldAutoReleaseBusy: false,
      toggleHeldAutoRelease: vi.fn(),
      heldPopOpen: true,
      heldBadgeBtn: null,
      heldPopEl: null,
      toggleHeldPop: vi.fn(),
      closeHeldPop: vi.fn(),
      doSpawnHeld: vi.fn(),
      doDiscardHeld: vi.fn(),
      onEditHeld: vi.fn(),
    });
    await nextFrame();

    // While spawning, the button reads "starting…", is busy, and is disabled so the
    // click can't fire twice — the missing affordance that made it read as "does nothing".
    const spawn = page.getByRole("button", { name: m.topbar_held_spawning() });
    await expect.element(spawn).toBeDisabled();
    expect((spawn.element() as HTMLElement).getAttribute("aria-busy")).toBe("true");
  });

  it("clicking Edit hands the whole held task to onEditHeld", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const task: HeldTask = {
      id: "held-1",
      repoPath: "/work/shepherd",
      createdAt: 1_700_000_000_000,
      input: {
        repoPath: "/work/shepherd",
        baseBranch: "main",
        prompt: "fix the thing",
        agentProvider: "claude",
        model: null,
      },
    };
    const onEditHeld = vi.fn();

    render(TopBarHeldBadge, {
      heldCount: 1,
      mobile: false,
      compactBadges: false,
      hotter: null,
      nowMs: 1_700_000_000_000,
      heldPopFlipUp: false,
      heldItems: [task],
      heldLoading: false,
      heldAutoRelease: true,
      heldAutoReleaseBusy: false,
      toggleHeldAutoRelease: vi.fn(),
      heldPopOpen: true,
      heldBadgeBtn: null,
      heldPopEl: null,
      toggleHeldPop: vi.fn(),
      closeHeldPop: vi.fn(),
      doSpawnHeld: vi.fn(),
      doDiscardHeld: vi.fn(),
      onEditHeld,
    });
    await nextFrame();

    await page.getByRole("button", { name: m.topbar_held_edit() }).click();
    expect(onEditHeld).toHaveBeenCalledTimes(1);
    expect(onEditHeld.mock.calls[0]![0]).toEqual(task);
  });
});

describe("TopBar — working-while-blocked counts in the working tally, not blocked", () => {
  it("desktop: a flagged blocked session tallies as working; halt keeps the raw count", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const list = [
      { id: "r1", status: "running" },
      { id: "wb", status: "blocked" }, // herdr-latched, server flags it working
      { id: "b1", status: "blocked" }, // genuinely blocked
    ] as unknown as Session[];
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: list,
      workingBlocked: { wb: true },
    });
    const working = page.getByTitle(
      m.topbar_tally_filter_title({ status: m.topbar_working_label() }),
    );
    const blocked = page.getByTitle(
      m.topbar_tally_filter_title({ status: m.topbar_blocked_label() }),
    );
    // display tallies: flagged session counts as working (2), not blocked (1)
    await expect.element(working).toHaveTextContent("2");
    await expect.element(blocked).toHaveTextContent("1");
    // the e-stop stays RAW: only 1 raw-running agent is haltable, so the gear menu
    // offers "Halt 1", not 2 (the server's haltAll can't reach the latched session)
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    await expect
      .element(page.getByRole("button", { name: m.halt_all_aria({ count: 1 }) }))
      .toBeInTheDocument();
  });
});

describe("TopBar — gear attention dot is settings-owned", () => {
  it("desktop: running or blocked sessions do not put a pip on the gear", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const list = [
      { id: "r1", status: "running" },
      { id: "b1", status: "blocked" },
    ] as unknown as Session[];
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: list,
    });

    expect(document.querySelector(".halt-pip")).toBeNull();
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    await expect
      .element(page.getByRole("button", { name: m.halt_all_aria({ count: 1 }) }))
      .toBeInTheDocument();
  });

  it("mobile: running, blocked, update and what's-new signals do not put a pip on the gear", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    const list = [
      { id: "r1", status: "running" },
      { id: "b1", status: "blocked" },
    ] as unknown as Session[];
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.mobile,
      sessions: list,
      update: { behind: 2 } as UpdateStatus,
      herdrUpdate: { updateAvailable: true } as HerdrUpdateStatus,
      whatsNew: true,
      diagnosticsOverall: "ok",
    });

    expect(document.querySelector(".gear-pip")).toBeNull();
  });

  it("mobile: diagnostics warning/error put the settings-attention pip on the gear", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    const { rerender } = await render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.mobile,
      sessions: [],
      diagnosticsOverall: "error",
    });

    expect(document.querySelector(".gear-pip")?.getAttribute("data-tier")).toBe("red");

    await rerender({
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.mobile,
      sessions: [],
      diagnosticsOverall: "warning",
    });

    expect(document.querySelector(".gear-pip")?.getAttribute("data-tier")).toBe("yellow");
  });
});

describe("TopBar — gear always opens the telemetry menu", () => {
  it("desktop: an idle herd's gear opens the menu; only the Settings row calls onsettings", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onsettings = vi.fn();
    const list = [
      { id: "b1", status: "blocked" },
      { id: "d1", status: "done" },
    ] as unknown as Session[];
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: list,
      onsettings,
    });
    // the gear is ALWAYS a menu button now — clicking opens the popover, not Settings
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    expect(onsettings).not.toHaveBeenCalled();
    const settingsRow = page.getByRole("button", { name: m.settings_title() });
    await expect.element(settingsRow).toBeInTheDocument();
    // idle herd → the halt hero renders natively disabled with no WORKING chip
    const hero = page.getByRole("button", { name: m.gearmenu_halt_herd() });
    await expect.element(hero).toBeDisabled();
    expect(document.querySelector(".gear-menu .chip")).toBeNull();
    await settingsRow.click();
    expect(onsettings).toHaveBeenCalledTimes(1);
  });

  it("desktop: a running herd's gear opens the menu with the enabled halt hero + chip", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onsettings = vi.fn();
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: sessions(1),
      onsettings,
    });
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    expect(onsettings).not.toHaveBeenCalled();
    // running → the halt hero is enabled and carries the live WORKING chip
    const hero = page.getByRole("button", { name: m.halt_all_aria({ count: 1 }) });
    await expect.element(hero).toBeInTheDocument();
    await expect.element(page.getByText(m.gearmenu_working_chip({ count: 1 }))).toBeInTheDocument();
    const settingsRow = page.getByRole("button", { name: m.settings_title() });
    await settingsRow.click();
    expect(onsettings).toHaveBeenCalledTimes(1);
  });

  it("desktop: the menu STAYS open when the herd goes quiet — halt hero just disables", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const { rerender } = await render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: sessions(1),
    });
    // running → open the menu
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    await expect
      .element(page.getByRole("button", { name: m.settings_title() }))
      .toBeInTheDocument();
    // agents finish → the menu is still valid (usage, docs, support), so it stays
    // open; the halt hero flips to disabled and drops its chip
    await rerender({
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: sessions(0),
    });
    await expect
      .element(page.getByRole("button", { name: m.settings_title() }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: m.gearmenu_halt_herd() })).toBeDisabled();
    expect(document.querySelector(".gear-menu .chip")).toBeNull();
  });

  it("mobile: an idle gear opens the menu with the quick theme/contrast controls", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    const onsettings = vi.fn();
    const list = [{ id: "d1", status: "done" }] as unknown as Session[];
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.mobile,
      sessions: list,
      onsettings,
    });
    // mobile → the gear is always a menu button, even with an idle herd
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    expect(onsettings).not.toHaveBeenCalled();
    // the quick controls and the Settings row are all present in the open menu
    await expect
      .element(
        page.getByRole("button", { name: m.actionbar_theme_option({ label: m.theme_light() }) }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.actionbar_contrast_toggle() }))
      .toBeInTheDocument();
    // mobile bottom sheet: Settings is a plain button (not role=menuitem — invalid in dialog)
    await expect
      .element(page.getByRole("button", { name: m.settings_title() }))
      .toBeInTheDocument();
    // mobile footer: a link to Shepherd's home (README + docs) and the build version
    // The sheet uses plain <a>, not role=menuitem (invalid inside role=dialog)
    const docs = page.getByRole("link", { name: m.topbar_menu_docs() });
    await expect.element(docs).toBeInTheDocument();
    await expect.element(docs).toHaveAttribute("href", REPO_URL);
    // plus the hosted documentation site (docs.shepherd.run), distinct from the README
    const docsSite = page.getByRole("link", { name: m.topbar_docs() });
    await expect.element(docsSite).toBeInTheDocument();
    await expect.element(docsSite).toHaveAttribute("href", DOCS_URL);
    await expect.element(page.getByText(`v${version}`)).toBeInTheDocument();
  });

  it("desktop: the gear menu omits the quick theme/contrast controls", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: sessions(1),
    });
    // running desktop → menu opens, but the quick controls stay ActionBar-only
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    await expect
      .element(page.getByRole("button", { name: m.settings_title() }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.actionbar_contrast_toggle() }))
      .not.toBeInTheDocument();
    // the documentation entry (docs.shepherd.run) lives in the desktop gear menu too
    const docs = page.getByRole("link", { name: m.topbar_docs() });
    await expect.element(docs).toBeInTheDocument();
    await expect.element(docs).toHaveAttribute("href", DOCS_URL);
    // the GitHub README link + version footer stay mobile-only (desktop has the ActionBar footer)
    await expect
      .element(page.getByRole("link", { name: m.topbar_menu_docs() }))
      .not.toBeInTheDocument();
  });

  it("desktop compact + idle herd: the gear opens a menu (not Settings directly), carrying Documentation", async () => {
    // The standalone bar docs link and the learnings badge are both gone (moved into
    // the command bar via the search pill) — this now just guards that measured
    // overflow still forces menu mode on an idle herd, keeping the gear's own
    // Documentation entry reachable.
    await page.viewport(1236, 900);
    document.body.style.width = "1236px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      limits: fullLimits,
      ...allBadges,
      sessions: sessions(0), // idle herd → gear would normally open Settings directly
    });
    const hud = document.querySelector<HTMLElement>(".hud");
    await waitNoOverflow(hud!);
    await drainFrames(hud!);
    expect(
      hud!.querySelector(".search")?.classList.contains("compact"),
      "bar is compacted at 1236 with full chrome",
    ).toBe(true);
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    const docs = page.getByRole("link", { name: m.topbar_docs() });
    await expect.element(docs).toBeInTheDocument();
    await expect.element(docs).toHaveAttribute("href", DOCS_URL);
  });
});

describe("TopBar — CR extra-credit gauge", () => {
  type Credit = NonNullable<UsageLimits["credits"]>;
  function limitsWithCredit(credit: Partial<Credit>): UsageLimits {
    return {
      session5h: { pct: 88, resetAt: 1_700_003_600_000 },
      week: { pct: 64, resetAt: 1_700_600_000_000 },
      perModelWeek: [],
      stale: false,
      calibratedAt: 1_700_000_000_000,
      subscriptionOnly: false,
      credits: {
        pct: 0,
        spent: 0.29,
        cap: 50,
        currency: "€",
        resetAt: 1_702_600_000_000,
        scrapedAt: 1_700_000_000_000 - 5 * 60_000, // 5m before nowMs
        stale: false,
        ...credit,
      },
    };
  }

  async function renderDesktop(limits: UsageLimits | null) {
    await page.viewport(1436, 900);
    document.body.style.width = "1436px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      ...sessionsProp(0),
      limits,
    });
    const hud = document.querySelector<HTMLElement>(".hud");
    expect(hud, "TopBar .hud mounted").not.toBeNull();
    return hud!;
  }

  // Capped limits: a window pinned at 100% → desktop inline swaps the percentages for the CR amount.
  function cappedLimitsWithCredit(credit: Partial<Credit> = {}): UsageLimits {
    return {
      ...limitsWithCredit(credit),
      session5h: { pct: 100, resetAt: 1_700_003_600_000 },
      week: { pct: 100, resetAt: 1_700_600_000_000 },
    };
  }
  // Credits-only: no usage windows scraped, but extra spend present.
  function creditsOnly(credit: Partial<Credit> = {}): UsageLimits {
    return { ...limitsWithCredit(credit), session5h: null, week: null };
  }

  function codexOnly({ stale = false }: { stale?: boolean } = {}): UsageLimits {
    return {
      session5h: null,
      week: null,
      perModelWeek: [],
      credits: null,
      stale: false,
      calibratedAt: null,
      subscriptionOnly: false,
      providers: [
        {
          provider: "codex",
          kind: "tokens",
          totalTokens: 92_600_000,
          session5hTokens: 404_000,
          weekTokens: 92_600_000,
          updatedAt: 1_700_000_000_000,
          stale,
          session5h: null,
          week: null,
        },
      ],
    };
  }

  function withCodex(
    base: UsageLimits,
    {
      stale = false,
      windows = false,
    }: {
      stale?: boolean;
      windows?: boolean;
    } = {},
  ): UsageLimits {
    return {
      ...base,
      providers: [
        {
          provider: "claude",
          kind: "limits",
          session5h: base.session5h,
          week: base.week,
          perModelWeek: base.perModelWeek,
          credits: base.credits,
          stale: base.stale,
          calibratedAt: base.calibratedAt,
          subscriptionOnly: base.subscriptionOnly,
        },
        {
          provider: "codex",
          kind: "tokens",
          totalTokens: 92_600_000,
          session5hTokens: 404_000,
          weekTokens: 92_600_000,
          updatedAt: 1_700_000_000_000,
          stale,
          session5h: windows ? { pct: 9, resetAt: 1_700_014_400_000 } : null,
          week: windows ? { pct: 1, resetAt: 1_700_600_000_000 } : null,
        },
      ],
    };
  }

  async function renderTouch(limits: UsageLimits | null) {
    await page.viewport(1000, 900);
    document.body.style.width = "1000px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS["touch-desktop"],
      ...sessionsProp(0),
      limits,
    });
    const hud = document.querySelector<HTMLElement>(".hud");
    expect(hud, "TopBar .hud mounted").not.toBeNull();
    return hud!;
  }

  it("below cap: shows the percentages inline, NOT the CR amount (CR lives in the popover)", async () => {
    const hud = await renderDesktop(limitsWithCredit({})); // 88% / 64% → not capped
    const toggle = hud.querySelector<HTMLElement>(".gauges-toggle");
    expect(toggle, "gauges toggle present").not.toBeNull();
    expect(hud.querySelector(".credit-gauge"), "no inline CR amount below cap").toBeNull();
    expect(toggle!.textContent ?? "", "percentages inline").toContain("88%");
  });

  it("at cap: inline swaps the percentages for the CR amount", async () => {
    const hud = await renderDesktop(cappedLimitsWithCredit());
    const cr = hud.querySelector<HTMLElement>(".credit-gauge");
    expect(cr, "inline CR amount shown at cap").not.toBeNull();
    expect(cr!.textContent ?? "", "CR label + amount").toContain("€0.29");
    // percentages are swapped out — the inline cluster shows "CR …", not the "5H"/"WK" windows
    const toggle = hud.querySelector<HTMLElement>(".gauges-toggle");
    expect(toggle!.textContent ?? "", "no inline window label at cap").not.toContain("5H");
  });

  it("credits-only (no usage windows): toggle shows the CR amount, never blank", async () => {
    const hud = await renderDesktop(creditsOnly());
    const toggle = hud.querySelector<HTMLElement>(".gauges-toggle");
    expect(toggle, "toggle present in credits-only state").not.toBeNull();
    const cr = toggle!.querySelector<HTMLElement>(".credit-gauge");
    expect(cr, "credits-only toggle renders the CR amount (not blank)").not.toBeNull();
    expect(toggle!.textContent ?? "", "toggle is named by the CR amount").toContain("€0.29");
  });

  // Per-model-only: no calibrated 5H/WK, no credits/codex — only a Fable passthrough bar. The
  // usage section must still render an openable affordance (regression for the missing gate).
  function perModelOnly(): UsageLimits {
    return {
      session5h: null,
      week: null,
      perModelWeek: [
        { model: "fable", pct: 7, resetAt: null, scrapedAt: 1_700_000_000_000, stale: false },
      ],
      credits: null,
      stale: false,
      calibratedAt: 1_700_000_000_000,
      subscriptionOnly: false,
    };
  }

  it("per-model-only (desktop): inline toggle isn't blank and opens the Fable popover bar", async () => {
    const hud = await renderDesktop(perModelOnly());
    const toggle = hud.querySelector<HTMLElement>(".gauges-toggle");
    expect(toggle, "toggle present in per-model-only state").not.toBeNull();
    expect(toggle!.textContent ?? "", "inline shows the Fable pct, not blank").toContain("7%");
    toggle!.click();
    await nextFrame();
    const pop = hud.querySelector<HTMLElement>(".gauge-pop-desk");
    expect(pop, "popover opens").not.toBeNull();
    expect(pop!.querySelector(".mw-bar"), "Fable passthrough bar in popover").not.toBeNull();
  });

  it("per-model-only (touch): collapsed button isn't blank and opens the popover", async () => {
    const hud = await renderTouch(perModelOnly());
    const btn = hud.querySelector<HTMLButtonElement>(".gauge-btn");
    expect(btn, "collapsed button present in per-model-only state").not.toBeNull();
    expect(btn!.textContent ?? "", "collapsed button shows the Fable pct").toContain("7%");
    btn!.click();
    await nextFrame();
    expect(hud.querySelector(".gauge-pop"), "popover opens on tap").not.toBeNull();
  });

  it("does NOT render the CR gauge inline when credits is null", async () => {
    const hud = await renderDesktop(fullLimits); // fullLimits.credits === null
    expect(hud.querySelector(".credit-gauge"), "no CR gauge without credits").toBeNull();
  });

  it("does NOT render anything credit-related when limits is null", async () => {
    const hud = await renderDesktop(null);
    expect(hud.querySelector(".credit-gauge"), "no CR gauge without limits").toBeNull();
  });

  it("flags the alert state when spend > 0 on a fresh snapshot", async () => {
    const hud = await renderDesktop(cappedLimitsWithCredit({ spent: 0.29, stale: false }));
    const cr = hud.querySelector<HTMLElement>(".credit-gauge");
    expect(cr!.classList.contains("alert"), "CR gauge alert when overspending").toBe(true);
  });

  it("does NOT flag alert when spend is zero", async () => {
    const hud = await renderDesktop(cappedLimitsWithCredit({ spent: 0, stale: false }));
    const cr = hud.querySelector<HTMLElement>(".credit-gauge");
    expect(cr!.classList.contains("alert"), "no alert without spend").toBe(false);
  });

  it("renders muted/stale (no alert) on a stale snapshot even with spend", async () => {
    const hud = await renderDesktop(cappedLimitsWithCredit({ spent: 5, stale: true }));
    const cr = hud.querySelector<HTMLElement>(".credit-gauge");
    expect(cr!.classList.contains("stale"), "CR gauge stale class").toBe(true);
    expect(cr!.classList.contains("alert"), "stale never alerts").toBe(false);
  });

  // Desktop now opens the breakdown on CLICK (not hover), so the REFRESH inside stays reachable.
  const openDesktopPopover = (hud: HTMLElement) => {
    const toggle = hud.querySelector<HTMLButtonElement>(".gauges-toggle");
    expect(toggle, "gauges toggle present").not.toBeNull();
    toggle!.click();
  };

  it("clicking the cluster opens the popover with the amount + age + reachable REFRESH", async () => {
    const hud = await renderDesktop(limitsWithCredit({}));
    expect(hud.querySelector(".credit-detail"), "popover closed before click").toBeNull();
    openDesktopPopover(hud);
    await nextFrame();
    const pop = hud.querySelector<HTMLElement>(".gauge-pop-desk");
    expect(pop, "popover is a dialog").not.toBeNull();
    expect(pop!.getAttribute("role"), "role=dialog (interactive, not tooltip)").toBe("dialog");
    const detail = hud.querySelector<HTMLElement>(".credit-detail");
    expect(detail, "credit detail rendered on click").not.toBeNull();
    const txt = detail!.textContent ?? "";
    expect(txt, "amount line").toContain("€0.29");
    // 2-decimal precision, aligned with the server push copy (src/push.ts extraCreditsBody)
    expect(txt, "cap").toContain("€50.00");
    expect(txt, "snapshot age (5m)").toContain(m.topbar_credits_age({ age: "5m" }));
    // REFRESH is reachable — present in the open, clickable dialog (the bug was it closed on mouseout).
    // It lives at the Claude-section level now (not inside the credit block), so it survives credits
    // being hidden.
    expect(pop!.querySelector(".usage-refresh"), "refresh button reachable").not.toBeNull();
  });

  it("a stale Claude snapshot dims only the Claude section, not fresh Codex usage", async () => {
    // Claude limits stale + a fresh Codex provider: the Claude subsection dims, but the Codex
    // section (own codexUsage.stale=false) must stay lit — the stale must not ride the popover root.
    const limits: UsageLimits = {
      session5h: { pct: 42, resetAt: 1_700_003_600_000 },
      week: { pct: 30, resetAt: 1_700_600_000_000 },
      perModelWeek: [],
      credits: null,
      stale: true,
      calibratedAt: 1_700_000_000_000,
      subscriptionOnly: false,
      providers: [
        {
          provider: "codex",
          kind: "tokens",
          totalTokens: 1_000_000,
          session5hTokens: 100_000,
          weekTokens: 1_000_000,
          session5h: null,
          week: null,
          updatedAt: 1_700_000_000_000,
          stale: false,
        },
      ],
    };
    const hud = await renderDesktop(limits);
    openDesktopPopover(hud);
    await nextFrame();
    const pop = hud.querySelector<HTMLElement>(".gauge-pop-desk");
    expect(pop, "popover open").not.toBeNull();
    expect(pop!.classList.contains("stale"), "root popover is not globally dimmed").toBe(false);
    expect(
      pop!.querySelector(".gauge-pop-claude")!.classList.contains("stale"),
      "Claude section is dimmed",
    ).toBe(true);
    expect(
      pop!.querySelector(".token-window")!.classList.contains("stale"),
      "fresh Codex usage is NOT dimmed",
    ).toBe(false);
  });

  it("the per-window reset detail is present in the dialog the instant it opens", async () => {
    const hud = await renderDesktop(limitsWithCredit({}));
    openDesktopPopover(hud);
    await nextFrame();
    const pop = hud.querySelector<HTMLElement>(".gauge-pop-desk");
    // reset-time text is rendered (visible) inside the dialog — in the a11y tree on open, not
    // behind a hover/aria-label
    const resets = pop!.querySelectorAll(".gauge-pop-reset");
    expect(resets.length, "per-window reset lines present").toBeGreaterThan(0);
    expect(pop!.textContent ?? "", "period name present").toContain(m.topbar_gauge_period_5h());
  });

  it("shows 'just now' (not 'now ago') for a fresh scrape", async () => {
    const hud = await renderDesktop(
      limitsWithCredit({ scrapedAt: 1_700_000_000_000 - 10_000 }), // 10s before nowMs
    );
    openDesktopPopover(hud);
    await nextFrame();
    const txt = hud.querySelector<HTMLElement>(".credit-detail")!.textContent ?? "";
    expect(txt, "just-now line").toContain(m.topbar_credits_age_now());
    expect(txt, "no 'now ago'").not.toContain(m.topbar_credits_age({ age: "now" }));
  });

  it("shows the stale note in the popover for a stale snapshot", async () => {
    const hud = await renderDesktop(limitsWithCredit({ stale: true }));
    openDesktopPopover(hud);
    await nextFrame();
    const detail = hud.querySelector<HTMLElement>(".credit-detail");
    expect(detail!.textContent ?? "", "stale note").toContain(m.topbar_credits_stale());
  });

  it("credits-only: clicking the toggle opens the popover with REFRESH (no usage windows)", async () => {
    const hud = await renderDesktop(creditsOnly());
    openDesktopPopover(hud);
    await nextFrame();
    const detail = hud.querySelector<HTMLElement>(".credit-detail");
    expect(detail, "credit detail in credits-only popover").not.toBeNull();
    expect(hud.querySelector(".usage-refresh"), "refresh reachable in credits-only").not.toBeNull();
    // no usage windows → the popover carries no 5-Hour/Weekly window blocks (only the credit detail,
    // whose own header reads "Extra credits", not a window period label)
    const pop = hud.querySelector<HTMLElement>(".gauge-pop-desk");
    expect(pop!.textContent ?? "", "no 5-Hour window block").not.toContain(
      m.topbar_gauge_period_5h(),
    );
  });

  it("codex-only: clicking the toggle opens provider token telemetry", async () => {
    const hud = await renderDesktop(codexOnly());
    const toggle = hud.querySelector<HTMLElement>(".gauges-toggle");
    expect(toggle, "codex-only toggle present").not.toBeNull();
    expect(toggle!.textContent ?? "", "inline codex token count").toContain(
      formatTokenLabel(92_600_000),
    );
    expect(toggle!.textContent ?? "", "single provider is unprefixed").not.toContain(
      m.topbar_usage_provider_short_codex(),
    );

    openDesktopPopover(hud);
    await nextFrame();
    const pop = hud.querySelector<HTMLElement>(".gauge-pop-desk");
    expect(pop, "popover rendered").not.toBeNull();
    const text = pop!.textContent ?? "";
    expect(text, "codex provider label").toContain(m.agent_provider_codex());
    expect(text, "codex limits fallback").toContain(m.topbar_codex_limits_unavailable());
    expect(text, "5H token row").toContain(m.topbar_tokens_window({ period: "5H" }));
    expect(text, "weekly token row").toContain(m.topbar_tokens_window({ period: "WK" }));
  });

  it("rotates desktop compact usage from Claude to Codex limit gauges", async () => {
    vi.useFakeTimers();
    const hud = await renderDesktop(withCodex(fullLimits, { windows: true }));
    const toggle = hud.querySelector<HTMLElement>(".gauges-toggle");
    expect(toggle, "rotating toggle present").not.toBeNull();
    expect(toggle!.textContent ?? "", "starts on Claude").toContain(
      m.topbar_usage_provider_short_claude(),
    );
    expect(toggle!.textContent ?? "", "Claude window visible").toContain("88%");

    await vi.advanceTimersByTimeAsync(120_000);
    await Promise.resolve();

    expect(toggle!.textContent ?? "", "rotates to Codex").toContain(
      m.topbar_usage_provider_short_codex(),
    );
    expect(toggle!.textContent ?? "", "Codex window visible").toContain("9%");

    openDesktopPopover(hud);
    await Promise.resolve();
    const pop = hud.querySelector<HTMLElement>(".gauge-pop-desk");
    const text = pop!.textContent ?? "";
    expect(text, "full popover still has Claude").toContain(m.agent_provider_claude());
    expect(text, "full popover still has Codex").toContain(m.agent_provider_codex());
  });

  it("does not restart compact usage rotation on live percentage updates", async () => {
    vi.useFakeTimers();
    await page.viewport(1436, 900);
    document.body.style.width = "1436px";
    const props = {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      ...sessionsProp(0),
    };
    const { rerender } = await render(TopBar, {
      ...props,
      limits: withCodex(fullLimits, { windows: true }),
    });
    const hud = document.querySelector<HTMLElement>(".hud");
    expect(hud, "TopBar .hud mounted").not.toBeNull();
    const toggle = hud!.querySelector<HTMLElement>(".gauges-toggle");
    expect(toggle, "rotating toggle present").not.toBeNull();
    expect(toggle!.textContent ?? "", "starts on Claude").toContain(
      m.topbar_usage_provider_short_claude(),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await rerender({
      ...props,
      limits: withCodex(
        {
          ...fullLimits,
          session5h: { pct: 89, resetAt: 1_700_003_600_000 },
          week: { pct: 65, resetAt: 1_700_600_000_000 },
        },
        { windows: true },
      ),
    });
    await Promise.resolve();
    expect(toggle!.textContent ?? "", "usage update does not immediately rotate").toContain(
      m.topbar_usage_provider_short_claude(),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();

    expect(toggle!.textContent ?? "", "rotates at the original two-minute mark").toContain(
      m.topbar_usage_provider_short_codex(),
    );
  });

  it("rotates desktop compact usage to Codex token fallback when Codex has no windows", async () => {
    vi.useFakeTimers();
    const hud = await renderDesktop(withCodex(fullLimits));
    const toggle = hud.querySelector<HTMLElement>(".gauges-toggle");
    expect(toggle, "rotating toggle present").not.toBeNull();
    expect(toggle!.textContent ?? "", "starts on Claude").toContain(
      m.topbar_usage_provider_short_claude(),
    );
    expect(toggle!.textContent ?? "", "Claude window visible").toContain("88%");

    await vi.advanceTimersByTimeAsync(120_000);
    await Promise.resolve();

    expect(toggle!.textContent ?? "", "rotates to Codex").toContain(
      m.topbar_usage_provider_short_codex(),
    );
    expect(toggle!.textContent ?? "", "Codex token fallback visible").toContain(
      formatTokenLabel(92_600_000),
    );
  });

  it("rotates touch compact usage from Claude to Codex limit gauges with provider aria labels", async () => {
    vi.useFakeTimers();
    const hud = await renderTouch(withCodex(fullLimits, { windows: true }));
    const toggle = hud.querySelector<HTMLElement>(".gauge-btn");
    expect(toggle, "rotating touch toggle present").not.toBeNull();
    expect(toggle!.textContent ?? "", "starts on Claude").toContain(
      m.topbar_usage_provider_short_claude(),
    );
    expect(toggle!.getAttribute("aria-label") ?? "", "Claude provider in aria label").toContain(
      m.agent_provider_claude(),
    );
    expect(toggle!.getAttribute("aria-label") ?? "", "Claude limit in aria label").toContain(
      m.topbar_gauge_toggle_aria({ period: m.topbar_gauge_period_5h(), pct: 88 }),
    );

    await vi.advanceTimersByTimeAsync(120_000);
    await Promise.resolve();

    const rotated = hud.querySelector<HTMLElement>(".gauge-btn");
    expect(rotated, "rotated touch toggle present").not.toBeNull();
    expect(rotated!.textContent ?? "", "rotates to Codex").toContain(
      m.topbar_usage_provider_short_codex(),
    );
    expect(rotated!.getAttribute("aria-label") ?? "", "Codex provider in aria label").toContain(
      m.agent_provider_codex(),
    );
    expect(rotated!.getAttribute("aria-label") ?? "", "Codex limit in aria label").toContain(
      m.topbar_gauge_toggle_aria({ period: m.topbar_gauge_period_5h(), pct: 9 }),
    );
  });

  it("rotates touch compact usage to Codex token fallback", async () => {
    vi.useFakeTimers();
    const hud = await renderTouch(withCodex(fullLimits));
    const toggle = hud.querySelector<HTMLElement>(".gauge-btn");
    expect(toggle, "rotating touch toggle present").not.toBeNull();
    expect(toggle!.textContent ?? "", "starts on Claude").toContain(
      m.topbar_usage_provider_short_claude(),
    );

    await vi.advanceTimersByTimeAsync(120_000);
    await Promise.resolve();

    const rotated = hud.querySelector<HTMLElement>(".gauge-btn");
    expect(rotated, "rotated touch toggle present").not.toBeNull();
    expect(rotated!.textContent ?? "", "rotates to Codex").toContain(
      m.topbar_usage_provider_short_codex(),
    );
    expect(rotated!.textContent ?? "", "Codex token fallback visible").toContain(
      formatTokenLabel(92_600_000),
    );
  });

  it("codex-only touch toggle dims when the Codex snapshot is stale", async () => {
    const hud = await renderTouch(codexOnly({ stale: true }));
    const toggle = hud.querySelector<HTMLElement>(".gauge-btn");

    expect(toggle, "codex-only touch toggle present").not.toBeNull();
    expect(toggle!.textContent ?? "", "inline codex token count").toContain(
      formatTokenLabel(92_600_000),
    );
    expect(toggle!.textContent ?? "", "single provider is unprefixed").not.toContain(
      m.topbar_usage_provider_short_codex(),
    );
    expect(toggle!.classList.contains("stale"), "stale codex-only toggle is dimmed").toBe(true);
  });

  it("mobile sheet: codex-only without rate limits explains the token-only fallback", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.mobile,
      ...sessionsProp(0),
      limits: codexOnly(),
    });

    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    // the per-window breakdown now lives behind the usage block's "all" disclosure
    await page.getByRole("button", { name: m.gearmenu_usage_all_aria() }).click();
    const sheet = document.querySelector<HTMLElement>(".gear-sheet");
    expect(sheet, "mobile sheet rendered").not.toBeNull();
    const text = sheet!.textContent ?? "";
    expect(text, "codex fallback visible in mobile sheet").toContain(
      m.topbar_codex_limits_unavailable(),
    );
    expect(text, "codex token rows remain visible").toContain(
      m.topbar_tokens_window({ period: "5H" }),
    );
  });

  it("fail-closed: a rejected refresh surfaces the error state, not silent success", async () => {
    // The house-rule fail-closed path: refreshUsage() rejects → the popover must show
    // its visible error state (role=alert / .usage-refresh-error / retry message) so the user
    // sees the refresh FAILED rather than it looking like a success.
    vi.mocked(refreshUsage).mockRejectedValueOnce(new Error("network down"));
    const hud = await renderDesktop(limitsWithCredit({}));
    openDesktopPopover(hud);
    await nextFrame();
    const detail = hud.querySelector<HTMLElement>(".credit-detail");
    expect(detail, "credit detail rendered on click").not.toBeNull();
    // No error before the refresh is attempted.
    expect(hud.querySelector(".usage-refresh-error"), "no error before refresh").toBeNull();

    const refreshBtn = hud.querySelector<HTMLButtonElement>(".usage-refresh");
    expect(refreshBtn, "refresh button present").not.toBeNull();
    refreshBtn!.click();

    // The rejection sets refreshError → the error alert appears. Poll for the rAF/
    // microtask settle so a genuinely-missing error state still fails the test.
    await vi.waitFor(() => {
      const err = hud.querySelector<HTMLElement>(".usage-refresh-error");
      expect(err, "error state appears on rejected refresh").not.toBeNull();
      expect(err!.getAttribute("role"), "error is an alert").toBe("alert");
      expect(err!.textContent ?? "", "retry message").toContain(m.common_retry());
    });
    expect(vi.mocked(refreshUsage), "refresh was attempted").toHaveBeenCalledTimes(1);
  });

  it("touch: the collapsed credits-only button carries the alert class when overspending", async () => {
    // On touch the gauges collapse to one button; with no usage windows but extra
    // spend present it's the credits-only collapsed button, which must read as alert.
    await page.viewport(1000, 900);
    document.body.style.width = "1000px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS["touch-desktop"],
      ...sessionsProp(0),
      // credits-only: usage windows null so `hotter` is absent → credits-only branch.
      limits: {
        session5h: null,
        week: null,
        stale: false,
        calibratedAt: 1_700_000_000_000,
        credits: {
          pct: 0,
          spent: 0.29,
          cap: 50,
          currency: "€",
          resetAt: 1_702_600_000_000,
          scrapedAt: 1_700_000_000_000 - 5 * 60_000,
          stale: false,
        },
      } as unknown as UsageLimits,
    });
    const hud = document.querySelector<HTMLElement>(".hud");
    const btn = hud!.querySelector<HTMLButtonElement>(".gauge-btn");
    expect(btn, "collapsed gauge button present").not.toBeNull();
    expect(btn!.classList.contains("alert"), "collapsed button alerts when overspending").toBe(
      true,
    );
  });

  it("mobile sheet: extra-credits bar is full-width (matches sibling 5H/Weekly bars)", async () => {
    // Regression guard for the "46px stub" bug: CreditDetail rendered its bar at 46px
    // in any context that did not pass the `wide` prop (touch popover, mobile sheet).
    // The fix collapses the .g-bar rule to always be 100% wide. In the mobile sheet,
    // sibling gauge rows are `width:100%` so credit-bar and gauge-bar widths must be
    // equal within sub-pixel rounding.
    //
    // Mutation check (verified): with CreditDetail's .g-bar left at `width: 46px` (no
    // full-width rule reachable from mobile-sheet context), this test FAILS — the credit
    // bar measures ~46px while the sibling .g-bar-wide measures the full sheet width, so
    // the equality assertion fails. Restoring .g-bar { width: 100% } makes it pass.
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.mobile,
      ...sessionsProp(0),
      limits: limitsWithCredit({}),
    });
    // Open the gear sheet, then the usage block's "all" disclosure (the breakdown
    // now renders inside it).
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    await page.getByRole("button", { name: m.gearmenu_usage_all_aria() }).click();
    // The sheet renders a usage section with gauge rows + credit detail.
    const creditBar = document.querySelector<HTMLElement>(".credit-detail .g-bar");
    expect(creditBar, "credit bar rendered in mobile sheet").not.toBeNull();
    const siblingBar = document.querySelector<HTMLElement>(".sheet-gauge-row .g-bar-wide");
    expect(siblingBar, "sibling gauge bar rendered in mobile sheet").not.toBeNull();
    const creditWidth = creditBar!.getBoundingClientRect().width;
    const siblingWidth = siblingBar!.getBoundingClientRect().width;
    expect(creditWidth, "credit bar must be wider than the 46px stub").toBeGreaterThan(100);
    // Sub-pixel rounding tolerance of 1px — both are width:100% of the same parent.
    expect(
      Math.abs(creditWidth - siblingWidth),
      `credit bar (${creditWidth.toFixed(1)}px) must match sibling gauge bar (${siblingWidth.toFixed(1)}px)`,
    ).toBeLessThanOrEqual(1);
  });
});

describe("TopBar — mobile gear sheet stays open on in-sheet clicks (dismissOnOutside bug)", () => {
  // Regression guard for the critical bug: on mobile, every click inside the gear
  // bottom sheet bubbled to <svelte:window onclick={dismissOnOutside}> and closed the
  // sheet because the sheet is rendered OUTSIDE .gear-wrap. The fix gates the
  // gearWrap-containment branch to !mobile; the sheet's own .menu-scrim backdrop and
  // use:dialog handle dismissal on mobile.
  //
  // This test opens the mobile sheet then clicks a theme button that is rendered
  // inside it. Without the !mobile guard that click wrongly triggers closeMenu() via
  // the window handler. With the fix the sheet stays open.

  it("mobile: clicking a theme button inside the sheet does NOT close the sheet", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    // Use an idle session list so the gear always opens the menu on mobile.
    const list = [{ id: "d1", status: "done" }] as unknown as Session[];
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.mobile,
      sessions: list,
    });

    // Open the sheet.
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    // Confirm the sheet rendered (the theme button is one of its controls).
    const themeBtn = page.getByRole("button", {
      name: m.actionbar_theme_option({ label: m.theme_light() }),
    });
    await expect.element(themeBtn).toBeInTheDocument();

    // Click the theme button — this is an in-sheet click that must NOT close the
    // sheet (it should NOT propagate to the window dismissOnOutside handler and call
    // closeMenu, because mobile is excluded from that branch).
    await themeBtn.click();

    // The sheet must still be in the document: the Settings button lives in the same
    // sheet and would disappear if closeMenu() had run.
    await expect
      .element(page.getByRole("button", { name: m.settings_title() }))
      .toBeInTheDocument();
  });

  it("desktop: clicking outside the gear wrap still closes the desktop dropdown", async () => {
    // Guard that the !mobile change does NOT regress the desktop outside-click path.
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: sessions(1),
    });

    // Open the desktop dropdown.
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    await expect
      .element(page.getByRole("button", { name: m.settings_title() }))
      .toBeInTheDocument();

    // Simulate an outside click by dispatching a MouseEvent on document.body (which
    // is outside .gear-wrap). The svelte:window handler should call closeMenu().
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextFrame();

    await expect
      .element(page.getByRole("button", { name: m.settings_title() }))
      .not.toBeInTheDocument();
  });
});

describe("TopBar — search pill replaces the docs link + learnings badge on desktop", () => {
  const idleSession = [{ id: "d1", status: "done" }] as unknown as Session[];

  it("desktop: renders the search pill and calls oncommandbar; no learnings badge even with learnings pending", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const oncommandbar = vi.fn();
    const onlearnings = vi.fn();
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: idleSession,
      learnings: 3,
      learningsCurate: 2,
      onlearnings,
      oncommandbar,
    });
    const search = page.getByRole("button", { name: m.topbar_search_aria() });
    await expect.element(search).toBeVisible();
    await search.click();
    expect(oncommandbar).toHaveBeenCalledTimes(1);

    const hud = document.querySelector<HTMLElement>(".hud");
    expect(hud, "TopBar .hud mounted").not.toBeNull();
    expect(
      hud!.querySelector(".learnings-btn"),
      "no learnings badge on desktop — Learnings now lives in the command bar",
    ).toBeNull();
    expect(onlearnings).not.toHaveBeenCalled();
  });
});

describe("TopBar — mobile learnings sheet row", () => {
  const idleSession = [{ id: "d1", status: "done" }] as unknown as Session[];

  it("mobile sheet: learnings row appears after opening gear sheet and calls onlearnings", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    const onlearnings = vi.fn();
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.mobile,
      sessions: idleSession,
      learnings: 2,
      onlearnings,
    });
    // Open the sheet by clicking the gear
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    // The sheet should contain the learnings row
    const learningsBtn = page.getByRole("button", { name: m.learnings_open_aria({ count: 2 }) });
    await expect.element(learningsBtn).toBeInTheDocument();
    await learningsBtn.click();
    expect(onlearnings).toHaveBeenCalledTimes(1);
  });
});

describe("TopBar — desktop learnings menu row", () => {
  it("idle desktop: learnings opens the menu, calls onlearnings, and closes", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onlearnings = vi.fn();
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: [{ id: "d1", status: "done" }] as unknown as Session[],
      learnings: 2,
      onlearnings,
    });

    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    const learningsItem = page.getByRole("button", {
      name: m.learnings_open_aria({ count: 2 }),
    });
    await expect.element(learningsItem).toBeInTheDocument();
    await learningsItem.click();
    expect(onlearnings).toHaveBeenCalledTimes(1);
    await expect.element(learningsItem).not.toBeInTheDocument();
  });

  it("desktop menu: choosing learnings disarms the halt action", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onhalt = vi.fn();
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: sessions(1),
      learnings: 2,
      onhalt,
    });

    const menuItem = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("[data-gear-row]")].find(
        (item) => item.getAttribute("aria-label") === name,
      );
    const gear = document.querySelector<HTMLButtonElement>(".gear")!;

    gear.click();
    await Promise.resolve();
    menuItem(m.halt_all_aria({ count: 1 }))!.click();
    menuItem(m.learnings_open_aria({ count: 2 }))!.click();
    await Promise.resolve();

    gear.click();
    await Promise.resolve();
    const haltItem = menuItem(m.halt_all_aria({ count: 1 }));
    expect(haltItem, "halt action is unarmed after choosing Learnings").toBeDefined();
    haltItem!.click();
    expect(onhalt).not.toHaveBeenCalled();
  });
});

describe("TopBar — mobile gear sheet portals out of transformed ancestor", () => {
  // Regression guard for the fixed-containing-block bug: on mobile the sheet lives
  // inside <header class="chrome"> which carries `will-change: transform` on
  // `.shell.mobile.list .chrome`. That establishes a CSS containing block so
  // `position: fixed` on `.gear-sheet` resolves against the short chrome box, not
  // the viewport — the sheet is clipped to the top of the screen.
  //
  // The fix wraps .menu-scrim + .gear-sheet in a `use:portal` wrapper so they are
  // re-parented to <body> (no transformed ancestor there), restoring honest
  // viewport-relative fixed positioning.

  let container: HTMLDivElement;

  afterEach(() => {
    container?.remove();
  });

  it("gear sheet escapes a will-change:transform ancestor and sits at the viewport bottom", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";

    // Reproduce the trapping ancestor: a small container with will-change:transform,
    // mirroring .shell.mobile.list .chrome which is top-pinned and short.
    container = document.createElement("div");
    container.style.cssText =
      "will-change:transform;position:fixed;top:0;left:0;width:390px;height:60px;overflow:hidden;";
    document.body.appendChild(container);

    const list = [{ id: "d1", status: "done" }] as unknown as Session[];
    render(TopBar, {
      target: container,
      props: {
        nowMs: 1_700_000_000_000,
        connected: true,
        ...FLAGS.mobile,
        sessions: list,
      },
    });

    // Open the sheet.
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    // Wait for the sheet to appear.
    await expect
      .element(page.getByRole("button", { name: m.settings_title() }))
      .toBeInTheDocument();

    const gearSheet = document.querySelector<HTMLElement>(".gear-sheet");
    expect(gearSheet, ".gear-sheet is in the document").not.toBeNull();

    // Structural: sheet must have escaped the transformed container.
    expect(
      container.contains(gearSheet),
      "gear-sheet must NOT be a descendant of the transformed ancestor",
    ).toBe(false);

    // Geometry: sheet bottom must sit at/near the viewport bottom (within 2px).
    const rect = gearSheet!.getBoundingClientRect();
    expect(
      rect.bottom,
      `gear-sheet bottom (${rect.bottom}) must be near viewport bottom (${window.innerHeight})`,
    ).toBeGreaterThanOrEqual(window.innerHeight - 2);
  });
});

describe("TopBar — plugin gear items", () => {
  const pluginBase = {
    nowMs: 1_700_000_000_000,
    connected: true,
    sessions: [] as Session[],
  };

  it("desktop: plugin items render in the gear menu with verbatim label and icon", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    render(TopBar, {
      ...pluginBase,
      ...FLAGS.desktop,
      pluginItems: [
        { id: "my-plugin", label: "My Action", icon: "🔌", hint: "Whisper" },
        // hint === label → the right-side hint is suppressed (it would just repeat)
        { id: "dup", label: "Echo", hint: "Echo" },
      ],
    });
    // Click the gear to open the menu (the gear always opens the menu now)
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    // Plugin item button is visible with verbatim label under the counted group label
    await expect.element(page.getByText(`${m.gearmenu_plugins_label()} · 2`)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "My Action" })).toBeVisible();
    await expect.element(page.getByText("🔌")).toBeVisible();
    // hint renders only when it differs from the label
    await expect.element(page.getByText("Whisper")).toBeVisible();
    const echoRow = page.getByRole("button", { name: "Echo" }).element();
    expect(echoRow.querySelector(".row-meta")).toBeNull();
  });

  it("desktop: clicking a plugin item calls onpluginitem with its id", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onpluginitem = vi.fn();
    render(TopBar, {
      ...pluginBase,
      ...FLAGS.desktop,
      pluginItems: [{ id: "act-plugin", label: "Do Something" }],
      onpluginitem,
    });
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    await page.getByRole("button", { name: "Do Something" }).click();
    expect(onpluginitem).toHaveBeenCalledWith("act-plugin");
  });

  it("desktop: idle herd + pluginItems — gear opens a menu instead of going directly to settings", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onsettings = vi.fn();
    render(TopBar, {
      ...pluginBase,
      ...FLAGS.desktop,
      pluginItems: [{ id: "p1", label: "Plugin Action" }],
      onsettings,
    });
    // With pluginItems, gear is a menu button (not a direct-settings button)
    const gear = page.getByRole("button", { name: m.topbar_menu_aria() });
    await expect.element(gear).toBeVisible();
    await gear.click();
    // Menu is open — the plugin item is visible, settings was NOT called directly
    await expect.element(page.getByRole("button", { name: "Plugin Action" })).toBeVisible();
    expect(onsettings).not.toHaveBeenCalled();
  });
});

// ── Telemetry menu (design handoff 3b/3c) — novel contracts ─────────────────
// One visual/geometry path (desktop + mobile phase) + behavioral cases. All other
// menu behavior is covered by the updated legacy describes above.

describe("TopBar — telemetry menu visual/geometry path", () => {
  it("desktop: square 300px popover, gear-anchored, clamped + scrollable on a short viewport", async () => {
    // Short viewport + plugins + expanded usage: the worst-case height.
    await page.viewport(900, 500);
    document.body.style.width = "900px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      ...sessionsProp(1),
      limits: fullLimits,
      pluginItems: [
        { id: "p1", label: "Plugin One" },
        { id: "p2", label: "Plugin Two" },
        { id: "p3", label: "Plugin Three" },
      ],
    });
    // Open via KEYBOARD so the focus-visible treatment applies to the auto-focused row.
    const gear = page.getByRole("button", { name: m.topbar_menu_aria() });
    (gear.element() as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
    const menu = document.querySelector<HTMLElement>(".gear-menu");
    expect(menu, "popover rendered").not.toBeNull();
    // Square + 300px wide, anchored below the gear with right edges aligned.
    expect(getComputedStyle(menu!).borderRadius).toBe("0px");
    const rect = menu!.getBoundingClientRect();
    expect(Math.abs(rect.width - 300)).toBeLessThanOrEqual(1);
    const wrapRect = document.querySelector(".gear-wrap")!.getBoundingClientRect();
    expect(Math.abs(rect.right - wrapRect.right)).toBeLessThanOrEqual(1);
    expect(rect.top).toBeGreaterThan(wrapRect.bottom);
    // Focus landed on the first enabled row and shows the tokenized treatment.
    const focused = document.activeElement as HTMLElement;
    expect(focused.hasAttribute("data-gear-row"), "first enabled row focused").toBe(true);
    const fs = getComputedStyle(focused);
    const hover = getComputedStyle(document.documentElement).getPropertyValue("--hover").trim();
    // resolve the token to rgb via a probe element for a robust comparison
    const probe = document.createElement("div");
    probe.style.backgroundColor = hover;
    document.body.appendChild(probe);
    expect(fs.backgroundColor).toBe(getComputedStyle(probe).backgroundColor);
    probe.remove();
    expect(fs.boxShadow).not.toBe("none");
    // Expand the usage breakdown → the popover must clamp and scroll internally.
    await page.getByRole("button", { name: m.gearmenu_usage_all_aria() }).click();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const clamped = menu!.getBoundingClientRect();
    expect(clamped.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(menu!.scrollHeight).toBeGreaterThan(menu!.clientHeight);
    // The last Support row stays reachable: scroll it into view and click it.
    const sendRow = page.getByRole("button", { name: m.feedback_dialog_title_feedback() });
    (sendRow.element() as HTMLElement).scrollIntoView({ block: "nearest" });
    await expect.element(sendRow).toBeVisible();
  });

  it("mobile: 12px-top-radius full-bleed sheet with the 52/48/44px row tiers", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.mobile,
      ...sessionsProp(1),
      pluginItems: [{ id: "p1", label: "Plugin One" }],
    });
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    const sheet = document.querySelector<HTMLElement>(".gear-sheet");
    expect(sheet, "sheet rendered").not.toBeNull();
    // wait out the rise transition so geometry is settled
    await vi.waitFor(() => {
      const r = sheet!.getBoundingClientRect();
      expect(Math.abs(r.bottom - window.innerHeight)).toBeLessThanOrEqual(1);
    });
    const cs = getComputedStyle(sheet!);
    expect(cs.borderTopLeftRadius).toBe("12px");
    expect(cs.borderTopRightRadius).toBe("12px");
    expect(cs.borderBottomLeftRadius).toBe("0px");
    const r = sheet!.getBoundingClientRect();
    expect(Math.abs(r.width - window.innerWidth)).toBeLessThanOrEqual(1);
    // Touch tiers: Halt 52 / workspace+plugin 48 / support 44.
    const hero = page.getByRole("button", { name: m.halt_all_aria({ count: 1 }) }).element();
    expect(hero.getBoundingClientRect().height).toBeGreaterThanOrEqual(52);
    const settingsRow = page.getByRole("button", { name: m.settings_title() }).element();
    expect(settingsRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    const pluginRow = page.getByRole("button", { name: "Plugin One" }).element();
    expect(pluginRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    const supportRow = page.getByRole("button", { name: m.feedback_dialog_title_bug() }).element();
    expect(supportRow.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });
});

describe("TopBar — telemetry menu behavior", () => {
  const base = {
    nowMs: 1_700_000_000_000,
    connected: true,
  };

  it("desktop: `all ▾` disclosure flips aria-expanded + region; block click opens the usage view and closes", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onusage = vi.fn();
    render(TopBar, {
      ...base,
      ...FLAGS.desktop,
      ...sessionsProp(0),
      limits: fullLimits,
      onusage,
    });
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    const all = page.getByRole("button", { name: m.gearmenu_usage_all_aria() });
    await expect.element(all).toHaveAttribute("aria-expanded", "false");
    const controlsId = all.element().getAttribute("aria-controls")!;
    expect(document.getElementById(controlsId)).toBeNull();
    await all.click();
    await expect.element(all).toHaveAttribute("aria-expanded", "true");
    const region = document.getElementById(controlsId);
    expect(region, "breakdown region rendered").not.toBeNull();
    expect(region!.textContent).toContain(
      m.topbar_usage_provider_title({ provider: m.agent_provider_claude() }),
    );
    await all.click();
    await expect.element(all).toHaveAttribute("aria-expanded", "false");
    // Block click-through → usage view, menu closes.
    await page.getByRole("button", { name: m.topbar_usage_link() }).click();
    expect(onusage).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".gear-menu")).toBeNull();
  });

  it("desktop: no-data usage block keeps the label-row click-through; stale hottest window is marked", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const { rerender } = await render(TopBar, {
      ...base,
      ...FLAGS.desktop,
      ...sessionsProp(0),
      limits: null,
    });
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    // no windows → no gauge line, but the block still opens the usage view
    expect(document.querySelector(".gm-line")).toBeNull();
    await expect.element(page.getByRole("button", { name: m.topbar_usage_link() })).toBeVisible();
    // stale limits → the selected window renders with the stale marker (dim treatment)
    await rerender({
      ...base,
      ...FLAGS.desktop,
      ...sessionsProp(0),
      limits: { ...fullLimits, stale: true },
    });
    await expect.element(page.getByRole("button", { name: m.topbar_usage_link() })).toBeVisible();
    expect(document.querySelector(".gm[data-stale]")).not.toBeNull();
    expect(document.querySelector(".gm-line")).not.toBeNull();
  });

  it("desktop: `manage ▾` is a plain action (no aria-expanded, aria-haspopup=dialog) → onmanageplugins", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onmanageplugins = vi.fn();
    render(TopBar, {
      ...base,
      ...FLAGS.desktop,
      ...sessionsProp(0),
      pluginItems: [{ id: "p1", label: "Plugin One" }],
      onmanageplugins,
    });
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    const manage = page.getByRole("button", { name: `${m.gearmenu_plugins_manage()} ▾` });
    await expect.element(manage).toBeVisible();
    expect(manage.element().hasAttribute("aria-expanded")).toBe(false);
    expect(manage.element().getAttribute("aria-haspopup")).toBe("dialog");
    await manage.click();
    expect(onmanageplugins).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".gear-menu")).toBeNull();
  });

  it("desktop: identity header swaps live ↔ offline with the connection state", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const { rerender } = await render(TopBar, {
      ...base,
      ...FLAGS.desktop,
      ...sessionsProp(0),
    });
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    const ident = document.querySelector<HTMLElement>(".gear-menu .ident");
    expect(ident!.textContent).toContain(m.gearmenu_conn_live());
    expect(ident!.querySelector(".ident-dot.on")).not.toBeNull();
    await rerender({ ...base, connected: false, ...FLAGS.desktop, ...sessionsProp(0) });
    expect(ident!.textContent).toContain(m.gearmenu_conn_offline());
    expect(ident!.querySelector(".ident-dot.on")).toBeNull();
  });

  it("desktop keyboard: open focuses the first ENABLED row, arrows cycle, Esc refocuses the gear", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    render(TopBar, {
      ...base,
      ...FLAGS.desktop,
      ...sessionsProp(0), // idle → halt hero disabled, must be SKIPPED by focus + roving
      limits: fullLimits,
    });
    const gear = page.getByRole("button", { name: m.topbar_menu_aria() });
    (gear.element() as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => {
      const a = document.activeElement as HTMLElement;
      expect(a.hasAttribute("data-gear-row")).toBe(true);
    });
    const first = document.activeElement as HTMLElement;
    expect((first as HTMLButtonElement).disabled ?? false).toBe(false);
    // ArrowDown → next enabled row; ArrowUp → back to the first.
    await userEvent.keyboard("{ArrowDown}");
    const second = document.activeElement as HTMLElement;
    expect(second).not.toBe(first);
    expect(second.hasAttribute("data-gear-row")).toBe(true);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(first);
    // Esc closes and returns focus to the gear.
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector(".gear-menu")).toBeNull();
    expect(document.activeElement).toBe(gear.element());
  });

  it("settings chord: Ctrl+, → onsettings (defaultPrevented); guard-false blocks; input focus doesn't", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onsettings = vi.fn();
    let allowed = true;
    render(TopBar, {
      ...base,
      ...FLAGS.desktop,
      ...sessionsProp(0),
      onsettings,
      settingsChordAllowed: () => allowed,
    });
    const chord = () => {
      const e = new KeyboardEvent("keydown", {
        key: ",",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(e);
      return e;
    };
    const e1 = chord();
    expect(onsettings).toHaveBeenCalledTimes(1);
    expect(e1.defaultPrevented).toBe(true);
    // Page-level guard (e.g. an overlay is open) blocks the chord.
    allowed = false;
    chord();
    expect(onsettings).toHaveBeenCalledTimes(1);
    allowed = true;
    // Modifier chords bypass the typing bail (Cmd+K parity): fire from a focused input.
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const e2 = new KeyboardEvent("keydown", {
      key: ",",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(e2);
    expect(onsettings).toHaveBeenCalledTimes(2);
    input.remove();
  });

  it("mobile: the chord is not bound (desktop-only affordance)", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    const onsettings = vi.fn();
    render(TopBar, {
      ...base,
      ...FLAGS.mobile,
      ...sessionsProp(0),
      onsettings,
    });
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(onsettings).not.toHaveBeenCalled();
  });
});

describe("TopBar — mobile sheet swipe-down", () => {
  // Synthetic pointer events aren't retargeted by pointer capture, so the capture
  // call itself is spied and the post-capture stream is dispatched on the handle —
  // the exact stream capture would deliver for a drag that leaves the handle.
  function pt(type: string, pointerId: number, clientY: number): PointerEvent {
    return new PointerEvent(type, { pointerId, clientY, bubbles: true, cancelable: true });
  }

  async function openSheet() {
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    const handle = document.querySelector<HTMLElement>(".sheet-handle-row");
    expect(handle, "handle rendered").not.toBeNull();
    const sheet = document.querySelector<HTMLElement>(".gear-sheet")!;
    // wait for the fly intro to finish (drag state is inert until introend)
    await vi.waitFor(
      () => {
        const r = sheet.getBoundingClientRect();
        expect(Math.abs(r.bottom - window.innerHeight)).toBeLessThanOrEqual(1);
      },
      { timeout: 2000 },
    );
    await new Promise((r) => setTimeout(r, 250));
    return { handle: handle!, sheet };
  }

  it("a captured drag past 64px closes; a short drag settles back open", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    const capture = vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => {});
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.mobile,
      ...sessionsProp(0),
    });
    const { handle, sheet } = await openSheet();

    // Short drag (dy=30): stays open, inline transform resets to the baseline.
    handle.dispatchEvent(pt("pointerdown", 1, 200));
    expect(capture).toHaveBeenCalledWith(1);
    handle.dispatchEvent(pt("pointermove", 1, 230));
    await vi.waitFor(() => expect(sheet.style.transform).toContain("translateY(30px)"));
    handle.dispatchEvent(pt("pointerup", 1, 230));
    expect(document.querySelector(".gear-sheet"), "short drag keeps the sheet").not.toBeNull();
    await vi.waitFor(() => expect(sheet.style.transform).toBe(""));

    // Long drag (dy=150, wandering off the handle mid-way): closes on release.
    handle.dispatchEvent(pt("pointerdown", 2, 200));
    handle.dispatchEvent(pt("pointermove", 2, 350));
    handle.dispatchEvent(pt("pointerup", 2, 350));
    await vi.waitFor(() => expect(document.querySelector(".gear-sheet")).toBeNull());
    capture.mockRestore();
  });

  it("pointercancel / lost capture resets cleanly and the next drag still works", async () => {
    await page.viewport(390, 800);
    document.body.style.width = "390px";
    const capture = vi.spyOn(Element.prototype, "setPointerCapture").mockImplementation(() => {});
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.mobile,
      ...sessionsProp(0),
    });
    const { handle, sheet } = await openSheet();

    // Cancel mid-drag at dy=100 (>64): must NOT close, transform resets.
    handle.dispatchEvent(pt("pointerdown", 1, 200));
    handle.dispatchEvent(pt("pointermove", 1, 300));
    await vi.waitFor(() => expect(sheet.style.transform).toContain("translateY(100px)"));
    handle.dispatchEvent(pt("pointercancel", 1, 300));
    handle.dispatchEvent(pt("lostpointercapture", 1, 300));
    expect(document.querySelector(".gear-sheet"), "cancel keeps the sheet").not.toBeNull();
    await vi.waitFor(() => expect(sheet.style.transform).toBe(""));

    // State fully reset: a fresh drag closes as normal.
    handle.dispatchEvent(pt("pointerdown", 3, 200));
    handle.dispatchEvent(pt("pointermove", 3, 340));
    handle.dispatchEvent(pt("pointerup", 3, 340));
    await vi.waitFor(() => expect(document.querySelector(".gear-sheet")).toBeNull());
    capture.mockRestore();
  });
});

describe("TopBar — every menu close path disarms the e-stop", () => {
  it("desktop: closing via the Documentation link disarms; a later single click cannot halt", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onhalt = vi.fn();
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: sessions(2),
      onhalt,
    });
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    // First activation ARMS the red confirm state.
    await page.getByRole("button", { name: m.halt_all_aria({ count: 2 }) }).click();
    await expect
      .element(page.getByRole("button", { name: m.halt_arm_aria({ count: 2 }) }))
      .toBeInTheDocument();
    // Close the menu via the Documentation link (navigation itself suppressed).
    const docs = page.getByRole("link", { name: m.topbar_docs() });
    (docs.element() as HTMLAnchorElement).addEventListener("click", (e) => e.preventDefault());
    await docs.click();
    expect(document.querySelector(".gear-menu")).toBeNull();
    // Reopen: the hero must be back in the UNARMED state — a single click arms
    // again instead of committing the halt.
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    await expect
      .element(page.getByRole("button", { name: m.halt_all_aria({ count: 2 }) }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: m.halt_all_aria({ count: 2 }) }).click();
    expect(onhalt).not.toHaveBeenCalled();
  });
});
