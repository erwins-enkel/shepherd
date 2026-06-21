import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Session, UsageLimits, UpdateStatus, HerdrUpdateStatus } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { REPO_URL, DOCS_URL, version } from "$lib/build-info";

// Mock api so the manual /usage refresh path never fires a real network call —
// individual tests stub refreshUsage's resolution/rejection per case.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  // Default: resolve (success). The value is ignored by the component (the gauge
  // self-updates via the ln WS frame); the fail-closed test overrides with a reject.
  return { ...actual, refreshUsage: vi.fn(async () => undefined) };
});

const { default: TopBar } = await import("./TopBar.svelte");
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
  needsYou: 3,
  update: { behind: 4 } as UpdateStatus,
  herdrUpdate: { updateAvailable: true } as HerdrUpdateStatus,
  whatsNew: true,
};

// Production-worst desktop chrome: both usage windows render as inline gauges
// (gaugeList yields a gauge per non-null window), widening the bar further.
const fullLimits: UsageLimits = {
  session5h: { pct: 88, resetAt: 1_700_003_600_000 },
  week: { pct: 64, resetAt: 1_700_600_000_000 },
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
    name: "touch-desktop 1000 — dual-update + needsYou + whatsNew",
    mode: "touch-desktop",
    width: 1000,
    props: {
      needsYou: 2,
      update: { behind: 1 },
      herdrUpdate: { updateAvailable: true },
      whatsNew: true,
      ...sessionsProp(0),
    },
  },
  {
    name: "touch-desktop 1000 — lone needsYou (#322 regression)",
    mode: "touch-desktop",
    width: 1000,
    props: { needsYou: 4, ...sessionsProp(0) },
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
  // compacts (labels → icons, clock-time drops, Mission-Control label hides) iff it
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
  // measures ~1333px for 2 badges (needsYou + update) and ~1450px for 3 — so it
  // overflows BOTH narrow widths even at just 2 badges, which the old count-3
  // threshold never compacted. Runtime measurement does. Each asserts the bar
  // compacts just enough to NOT overflow + keeps controls hittable. (Verified: with
  // the measured-OR removed these overflow — full 1333/1450 vs client 1320/1234 —
  // so they genuinely exercise the fix.)
  {
    name: "desktop 1322 — 2 full-label badges + gauges (1366px laptop, measured compaction)",
    mode: "desktop",
    width: 1322,
    props: { needsYou: 2, update: { behind: 3 }, limits: fullLimits, ...sessionsProp(0) },
  },
  {
    name: "desktop 1322 — 3 badges + gauges (1366px laptop, measured compaction)",
    mode: "desktop",
    width: 1322,
    props: {
      needsYou: 2,
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
    props: { needsYou: 2, update: { behind: 3 }, limits: fullLimits, ...sessionsProp(0) },
  },
  {
    name: "desktop 1236 — 3 badges + gauges (1280px window, measured compaction)",
    mode: "desktop",
    width: 1236,
    props: {
      needsYou: 2,
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
  const read = () => bar.querySelector(".needsyou")?.classList.contains("compact");
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

  it("narrow fold (800): lone learnings overflows full-label → compacts to fit, gear hittable", async () => {
    // Full-label intrinsic (clock already dropped) ≈ 840 > 800, so the old count rule
    // overflowed here; the measured path compacts the chip to fit.
    const hud = await renderTD(800, { learnings: 87 });
    await waitNoOverflow(hud);
    await drainFrames(hud);
    const btn = hud.querySelector<HTMLElement>(".learnings-btn");
    expect(btn, "learnings chip present").not.toBeNull();
    expect(btn!.classList.contains("compact"), "lone learnings compacts to fit the fold").toBe(
      true,
    );
    expect(hud.querySelector(".learnings-btn .learn-label"), "full label dropped").toBeNull();
    assertControlsHittable(hud);
  });

  it("wide tablet (1366): lone learnings FITS → stays full-label (measurement does not over-compact)", async () => {
    // Full-with-clock intrinsic ≈ 928 < 1366, so it must stay full: label kept, clock
    // shown — the no-over-fire direction of the ungated measurement.
    const hud = await renderTD(1366, { learnings: 87 });
    await nextFrame();
    await nextFrame();
    await drainFrames(hud);
    assertNoOverflow(hud);
    const btn = hud.querySelector<HTMLElement>(".learnings-btn");
    expect(btn!.classList.contains("compact"), "not compacted when it fits").toBe(false);
    expect(hud.querySelector(".learnings-btn .learn-label"), "full label kept").not.toBeNull();
    expect(
      hud.querySelector(".clock")!.classList.contains("no-time"),
      "clock shown when it fits",
    ).toBe(false);
    assertControlsHittable(hud);
  });

  it("wide tablet (1366): two badges keep full labels (old count-floor over-compaction is gone)", async () => {
    const hud = await renderTD(1366, { needsYou: 2, update: { behind: 3 } as UpdateStatus });
    await nextFrame();
    await nextFrame();
    await drainFrames(hud);
    assertNoOverflow(hud);
    const needsYou = hud.querySelector<HTMLElement>(".needsyou");
    expect(needsYou!.classList.contains("compact"), "needsYou full at wide tablet").toBe(false);
    expect(hud.querySelector(".update-badge .up-label"), "update full label kept").not.toBeNull();
    assertControlsHittable(hud);
  });

  it("clock-drop and label-collapse are COUPLED across all widths (#322 two-step ladder dropped)", async () => {
    // The single measured signal couples the two flags: on a measured overflow the bar
    // drops the numeric clock AND compacts the labels together — there is NO
    // clock-dropped-but-full-label intermediate (the deliberate loss of #322's two-step
    // ladder, matching desktop). Asserted as an invariant over a width sweep rather than a
    // fixed band, so it's independent of font metrics (the exact transition width varies
    // by the monospace fallback). At every width: clock-dropped iff labels-compacted; and
    // the sweep must exercise BOTH states (a wide width stays full, a narrow width
    // compacts) so the invariant can't pass vacuously.
    // Widths start at 800 (proven to fit once compacted, in CI + local) and span up to a
    // wide tablet; the exact compact↔full transition is font-dependent, but coupling must
    // hold at every width regardless.
    const states: { width: number; clockDropped: boolean; labelsCompact: boolean }[] = [];
    for (const width of [800, 880, 960, 1100, 1250, 1366]) {
      const hud = await renderTD(width, { learnings: 87 });
      await waitNoOverflow(hud);
      await drainFrames(hud);
      const clockDropped = hud.querySelector(".clock")!.classList.contains("no-time");
      const labelsCompact = hud
        .querySelector<HTMLElement>(".learnings-btn")!
        .classList.contains("compact");
      expect(clockDropped, `coupled at ${width}px (clock vs labels)`).toBe(labelsCompact);
      assertControlsHittable(hud);
      states.push({ width, clockDropped, labelsCompact });
    }
    expect(
      states.some((s) => s.clockDropped),
      "sweep exercises the compacted state (some narrow width drops clock + compacts)",
    ).toBe(true);
    expect(
      states.some((s) => !s.clockDropped),
      "sweep exercises the full state (some wide width keeps clock + full labels)",
    ).toBe(true);
  });
});

describe("TopBar — wide desktop keeps full labels (measurement does NOT over-compact)", () => {
  // Width-awareness must not over-fire: at the TRUE usable cap (1436px = .shell
  // 1480 - 2x22 padding) a wide 2-badge selection (needsYou + update ~1354px
  // incl. both usage gauges) STILL FITS, so the measured path must leave it FULL —
  // proving compaction triggers on real overflow, not merely on badge presence.
  // Settle the rAF first (the measurement might briefly flip), then assert it stays
  // non-compact. Plus a no-gauge variant. Both keep full labels AND fit 1436.
  //
  // Asserts: (a) the needsYou + update badges are present and showing their FULL
  // labels (needsYou not in .compact form; the update badge still rendering its
  // .up-label word), (b) no overflow, (c) all controls hittable - catching a future
  // left-cluster or gap change that silently overflows the non-compact desktop path.
  // (Sub-1436px desktop windows have less usable width and DO compact — covered by
  // the narrow-desktop scenarios above.)
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
        // Two full-label badges (needsYou + update).
        needsYou: 2,
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

      // Full-label: both badges present and NOT in compact (icon/count) form.
      const update = hud!.querySelector<HTMLElement>(".update-badge");
      const needsYou = hud!.querySelector<HTMLElement>(".needsyou");
      expect(update, "update badge present").not.toBeNull();
      expect(needsYou, "needsYou badge present").not.toBeNull();
      expect(needsYou!.classList.contains("compact"), "needsYou NOT compact").toBe(false);
      // The full word label renders inside the update badge (compact form omits it).
      const upLabel = update!.querySelector<HTMLElement>(".up-label");
      expect(upLabel, "update full label present").not.toBeNull();
      expect(upLabel!.textContent ?? "", "update full label text").toContain(
        m.topbar_update_badge(),
      );
      expect(update!.getBoundingClientRect().width, "update has width").toBeGreaterThan(0);
      expect(needsYou!.getBoundingClientRect().width, "needsYou has width").toBeGreaterThan(0);

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
      // Widest 2-badge full-label chrome + both gauges (~1354px): fits 1436, overflows 1236.
      needsYou: 2,
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
      hud!.querySelector(".needsyou")?.classList.contains("compact"),
      "full (not compact) at 1436",
    ).toBe(false);

    // Pure RESIZE narrow (content unchanged): only decideFromCache can fire. It must
    // compact from the cached full width vs the new clientWidth, and the bar must fit.
    await page.viewport(1236, 900);
    document.body.style.width = "1236px";
    await drainFrames(hud!);
    expect(
      hud!.querySelector(".needsyou")?.classList.contains("compact"),
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
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
    try {
      // Widest 2-badge desktop chrome, but limits START null: ~1113px of full-label
      // content fits the ~1250px window → no gauges, desktopCompact=false.
      const { component } = render(TopBarLimitsHarness, {
        nowMs: 1_700_000_000_000,
        connected: true,
        mobile: false,
        touch: false,
        needsYou: 2,
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
        hud!.querySelector(".needsyou")?.classList.contains("compact"),
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
      .element(page.getByRole("menuitem", { name: m.halt_all_aria({ count: 1 }) }))
      .toBeInTheDocument();
  });
});

describe("TopBar — idle gear opens Settings directly", () => {
  it("desktop: an idle herd's gear opens Settings without a menu", async () => {
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
    // idle → the gear's accessible name is the settings label, not the menu label
    await page.getByRole("button", { name: m.topbar_settings_aria() }).click();
    expect(onsettings).toHaveBeenCalledTimes(1);
    // no menu opened: neither the dropdown Settings row nor any menuitem exists
    await expect
      .element(page.getByRole("menuitem", { name: m.settings_title() }))
      .not.toBeInTheDocument();
  });

  it("desktop: a running herd's gear still opens the menu, only the row calls onsettings", async () => {
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
    // running → gear is a menu button; clicking it opens the menu, not Settings
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    expect(onsettings).not.toHaveBeenCalled();
    const settingsRow = page.getByRole("menuitem", { name: m.settings_title() });
    await expect.element(settingsRow).toBeInTheDocument();
    await settingsRow.click();
    expect(onsettings).toHaveBeenCalledTimes(1);
  });

  it("desktop: the open menu dismisses itself when the herd goes quiet underneath it", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const { rerender } = render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: sessions(1),
    });
    // running → open the menu
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    await expect
      .element(page.getByRole("menuitem", { name: m.settings_title() }))
      .toBeInTheDocument();
    // agents finish → no haltable session left; the stale menu must close itself
    await rerender({
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: sessions(0),
    });
    await expect
      .element(page.getByRole("menuitem", { name: m.settings_title() }))
      .not.toBeInTheDocument();
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
      .element(page.getByRole("menuitem", { name: m.settings_title() }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.actionbar_contrast_toggle() }))
      .not.toBeInTheDocument();
    // the documentation entry (docs.shepherd.run) lives in the desktop gear menu too
    const docs = page.getByRole("menuitem", { name: m.topbar_docs() });
    await expect.element(docs).toBeInTheDocument();
    await expect.element(docs).toHaveAttribute("href", DOCS_URL);
    // the GitHub README link + version footer stay mobile-only (desktop has the ActionBar footer)
    await expect
      .element(page.getByRole("menuitem", { name: m.topbar_menu_docs() }))
      .not.toBeInTheDocument();
  });

  it("desktop: a standalone documentation link sits in the bar regardless of herd state", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: sessions(0), // idle herd → no gear menu, but the bar link is still there
    });
    const docs = page.getByRole("link", { name: m.topbar_docs_aria() });
    await expect.element(docs).toBeInTheDocument();
    await expect.element(docs).toHaveAttribute("href", DOCS_URL);
  });

  it("desktop compact + idle herd: docs folds away from the bar but the gear menu carries it", async () => {
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
    // measured overflow → the standalone bar docs link folds away with the labels/clock…
    expect(
      hud!.querySelector(".needsyou")?.classList.contains("compact"),
      "bar is compacted at 1236 with full chrome",
    ).toBe(true);
    await expect
      .element(page.getByRole("link", { name: m.topbar_docs_aria() }))
      .not.toBeInTheDocument();
    // …but the gear now opens a menu (not Settings directly) that still carries Documentation,
    // so the docs stay reachable in the compact + idle state.
    await page.getByRole("button", { name: m.topbar_menu_aria() }).click();
    const docs = page.getByRole("menuitem", { name: m.topbar_docs() });
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

  it("renders the CR gauge on desktop when credits are present", async () => {
    const hud = await renderDesktop(limitsWithCredit({}));
    const cr = hud.querySelector<HTMLElement>(".credit-gauge");
    expect(cr, "CR gauge present").not.toBeNull();
    expect(cr!.textContent ?? "", "CR label + amount").toContain("CR");
    expect(cr!.textContent ?? "", "amount text").toContain("€0.29");
  });

  it("does NOT render the CR gauge when credits is null", async () => {
    const hud = await renderDesktop(fullLimits); // fullLimits.credits === null
    expect(hud.querySelector(".credit-gauge"), "no CR gauge without credits").toBeNull();
  });

  it("does NOT render anything credit-related when limits is null", async () => {
    const hud = await renderDesktop(null);
    expect(hud.querySelector(".credit-gauge"), "no CR gauge without limits").toBeNull();
  });

  it("flags the alert state when spend > 0 on a fresh snapshot", async () => {
    const hud = await renderDesktop(limitsWithCredit({ spent: 0.29, stale: false }));
    const cr = hud.querySelector<HTMLElement>(".credit-gauge");
    expect(cr!.classList.contains("alert"), "CR gauge alert when overspending").toBe(true);
  });

  it("does NOT flag alert when spend is zero", async () => {
    const hud = await renderDesktop(limitsWithCredit({ spent: 0, stale: false }));
    const cr = hud.querySelector<HTMLElement>(".credit-gauge");
    expect(cr!.classList.contains("alert"), "no alert without spend").toBe(false);
  });

  it("renders muted/stale (no alert) on a stale snapshot even with spend", async () => {
    const hud = await renderDesktop(limitsWithCredit({ spent: 5, stale: true }));
    const cr = hud.querySelector<HTMLElement>(".credit-gauge");
    expect(cr!.classList.contains("stale"), "CR gauge stale class").toBe(true);
    expect(cr!.classList.contains("alert"), "stale never alerts").toBe(false);
  });

  it("shows the amount + age text in the hover detail popover", async () => {
    const hud = await renderDesktop(limitsWithCredit({}));
    const wrap = hud.querySelector<HTMLElement>(".gauges-wrap");
    expect(wrap, "gauges-wrap present").not.toBeNull();
    wrap!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await nextFrame();
    const detail = hud.querySelector<HTMLElement>(".credit-detail");
    expect(detail, "credit detail rendered on hover").not.toBeNull();
    const txt = detail!.textContent ?? "";
    expect(txt, "amount line").toContain("€0.29");
    // 2-decimal precision, aligned with the server push copy (src/push.ts extraCreditsBody)
    expect(txt, "cap").toContain("€50.00");
    expect(txt, "snapshot age (5m)").toContain(m.topbar_credits_age({ age: "5m" }));
    // refresh control present
    expect(detail!.querySelector(".credit-refresh"), "refresh button present").not.toBeNull();
  });

  it("shows 'just now' (not 'now ago') for a fresh scrape", async () => {
    const hud = await renderDesktop(
      limitsWithCredit({ scrapedAt: 1_700_000_000_000 - 10_000 }), // 10s before nowMs
    );
    const wrap = hud.querySelector<HTMLElement>(".gauges-wrap");
    wrap!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await nextFrame();
    const txt = hud.querySelector<HTMLElement>(".credit-detail")!.textContent ?? "";
    expect(txt, "just-now line").toContain(m.topbar_credits_age_now());
    expect(txt, "no 'now ago'").not.toContain(m.topbar_credits_age({ age: "now" }));
  });

  it("shows the stale note in the popover for a stale snapshot", async () => {
    const hud = await renderDesktop(limitsWithCredit({ stale: true }));
    const wrap = hud.querySelector<HTMLElement>(".gauges-wrap");
    wrap!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await nextFrame();
    const detail = hud.querySelector<HTMLElement>(".credit-detail");
    expect(detail!.textContent ?? "", "stale note").toContain(m.topbar_credits_stale());
  });

  it("fail-closed: a rejected refresh surfaces the error state, not silent success", async () => {
    // The house-rule fail-closed path: refreshUsage() rejects → the popover must show
    // its visible error state (role=alert / .credit-error / retry message) so the user
    // sees the refresh FAILED rather than it looking like a success.
    vi.mocked(refreshUsage).mockRejectedValueOnce(new Error("network down"));
    const hud = await renderDesktop(limitsWithCredit({}));
    const wrap = hud.querySelector<HTMLElement>(".gauges-wrap");
    wrap!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await nextFrame();
    const detail = hud.querySelector<HTMLElement>(".credit-detail");
    expect(detail, "credit detail rendered on hover").not.toBeNull();
    // No error before the refresh is attempted.
    expect(detail!.querySelector(".credit-error"), "no error before refresh").toBeNull();

    const refreshBtn = detail!.querySelector<HTMLButtonElement>(".credit-refresh");
    expect(refreshBtn, "refresh button present").not.toBeNull();
    refreshBtn!.click();

    // The rejection sets refreshError → the error alert appears. Poll for the rAF/
    // microtask settle so a genuinely-missing error state still fails the test.
    await vi.waitFor(() => {
      const err = hud.querySelector<HTMLElement>(".credit-error");
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
      .element(page.getByRole("menuitem", { name: m.settings_title() }))
      .toBeInTheDocument();

    // Simulate an outside click by dispatching a MouseEvent on document.body (which
    // is outside .gear-wrap). The svelte:window handler should call closeMenu().
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextFrame();

    await expect
      .element(page.getByRole("menuitem", { name: m.settings_title() }))
      .not.toBeInTheDocument();
  });
});

describe("TopBar — global learnings button", () => {
  const idleSession = [{ id: "d1", status: "done" }] as unknown as Session[];

  it("desktop, proposed: shows learnings button with correct aria-label and calls onlearnings", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onlearnings = vi.fn();
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: idleSession,
      learnings: 3,
      onlearnings,
    });
    const btn = page.getByRole("button", { name: m.learnings_open_aria({ count: 3 }) });
    await expect.element(btn).toBeVisible();
    await btn.click();
    expect(onlearnings).toHaveBeenCalledTimes(1);
  });

  it("desktop, none: no learnings button when learnings=0 and learningsCurate=0", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: idleSession,
      learnings: 0,
      learningsCurate: 0,
    });
    const hud = document.querySelector<HTMLElement>(".hud");
    expect(hud, "TopBar .hud mounted").not.toBeNull();
    expect(hud!.querySelector(".learnings-btn"), "no learnings button when none").toBeNull();
  });

  it("desktop, curate-only: shows button with curate aria-label and calls onlearnings", async () => {
    await page.viewport(1280, 900);
    document.body.style.width = "1280px";
    const onlearnings = vi.fn();
    render(TopBar, {
      nowMs: 1_700_000_000_000,
      connected: true,
      ...FLAGS.desktop,
      sessions: idleSession,
      learnings: 0,
      learningsCurate: 2,
      onlearnings,
    });
    const btn = page.getByRole("button", { name: m.learnings_open_curate_aria({ count: 2 }) });
    await expect.element(btn).toBeVisible();
    await btn.click();
    expect(onlearnings).toHaveBeenCalledTimes(1);
  });

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

describe("TopBar — learnings chip label switches between proposed and curate-only mode", () => {
  // At 1436px wide desktop, the chip is NOT compacted (confirmed by the
  // "wide desktop keeps full labels" suite), so .learn-label renders.
  const desktopBase = {
    nowMs: 1_700_000_000_000,
    connected: true,
    ...FLAGS.desktop,
    ...sessionsProp(0),
    limits: null as UsageLimits | null,
  };

  it("curate-only: chip reads TRIM with curate tooltip and curate aria-label", async () => {
    await page.viewport(1436, 900);
    document.body.style.width = "1436px";
    render(TopBar, { ...desktopBase, learnings: 0, learningsCurate: 5 });

    await nextFrame();
    await nextFrame();

    const btn = document.querySelector<HTMLElement>(".learnings-btn");
    expect(btn, ".learnings-btn rendered").not.toBeNull();

    const label = btn!.querySelector<HTMLElement>(".learn-label");
    expect(label, ".learn-label rendered (not compacted at 1436px)").not.toBeNull();
    expect(label!.textContent, "chip label is TRIM in curate-only mode").toBe(
      m.learnings_trim_title(),
    );

    const countEl = btn!.querySelector<HTMLElement>(".learn-n");
    expect(countEl, ".learn-n rendered").not.toBeNull();
    expect(countEl!.textContent, "chip count is curate count").toBe("5");

    expect(btn!.getAttribute("title"), "tooltip is curate tip").toBe(
      m.topbar_learnings_curate_tip(),
    );
    expect(btn!.getAttribute("aria-label"), "aria-label is curate aria").toBe(
      m.learnings_open_curate_aria({ count: 5 }),
    );
  });

  it("proposed: chip reads LEARNINGS with proposed aria-label", async () => {
    await page.viewport(1436, 900);
    document.body.style.width = "1436px";
    render(TopBar, { ...desktopBase, learnings: 5, learningsCurate: 0 });

    await nextFrame();
    await nextFrame();

    const btn = document.querySelector<HTMLElement>(".learnings-btn");
    expect(btn, ".learnings-btn rendered").not.toBeNull();

    const label = btn!.querySelector<HTMLElement>(".learn-label");
    expect(label, ".learn-label rendered (not compacted at 1436px)").not.toBeNull();
    expect(label!.textContent, "chip label is LEARNINGS in proposed mode").toBe(
      m.learnings_title(),
    );

    expect(btn!.getAttribute("aria-label"), "aria-label is proposed aria").toBe(
      m.learnings_open_aria({ count: 5 }),
    );
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
