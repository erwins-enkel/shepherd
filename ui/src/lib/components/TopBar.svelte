<script lang="ts">
  import type {
    Session,
    UsageLimits,
    UpdateStatus,
    HerdrUpdateStatus,
    DiagnosticState,
  } from "$lib/types";
  import { formatReset, formatResetIn } from "$lib/format";
  import { displayStatus } from "$lib/display-status";
  import { gaugeList, hotterGauge, overspending, gaugeColor, type GaugeKey } from "./usage-gauges";
  import { refreshUsage, listHeld, spawnHeld, discardHeld } from "$lib/api";
  import type { HeldTask } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { modeOf, topBarPlan, badgeCount } from "./top-bar-layout";
  import { theme, type ThemePref } from "$lib/theme.svelte";
  import ThemeIcon from "$lib/components/ThemeIcon.svelte";
  import { REPO_URL, version } from "$lib/build-info";
  import { fly } from "svelte/transition";
  import { dialog } from "$lib/a11yDialog";
  import { portal } from "$lib/portal";
  import CreditDetail from "./top-bar/CreditDetail.svelte";
  import TopBarTallies from "./top-bar/TopBarTallies.svelte";
  import TopBarHeldBadge from "./top-bar/TopBarHeldBadge.svelte";
  import TopBarUsage from "./top-bar/TopBarUsage.svelte";
  import TopBarBadges from "./top-bar/TopBarBadges.svelte";
  import TopBarGear from "./top-bar/TopBarGear.svelte";

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  type TallyStatus = "running" | "idle" | "blocked";

  // Quick theme controls surfaced directly in the gear menu on mobile — the desktop
  // ActionBar carries these, but on phone it hides them, leaving Settings → Device the
  // only home. Mirrors the ActionBar's compact recipe: two explicit choices (dark/light;
  // "system" stays the implicit default), keyed on the resolved value.
  const QUICK_THEMES: {
    pref: Exclude<ThemePref, "system">;
    icon: "moon" | "sun";
    label: () => string;
  }[] = [
    { pref: "dark", icon: "moon", label: m.theme_dark },
    { pref: "light", icon: "sun", label: m.theme_light },
  ];

  let {
    sessions,
    nowMs,
    connected = false,
    mobile = false,
    touch = false,
    limits = null,
    onsettings,
    onhalt,
    needsYou = 0,
    ontriage,
    update = null,
    onupdate,
    herdrUpdate = null,
    onherdrupdate,
    whatsNew = false,
    onwhatsnew,
    statusFilter = null,
    onstatusfilter,
    workingBlocked = {},
    diagnosticsOverall = "ok",
    ondiagnose,
    learnings = 0,
    learningsCurate = 0,
    onlearnings,
    heldCount = 0,
  }: {
    sessions: Session[];
    nowMs: number;
    connected?: boolean;
    mobile?: boolean;
    touch?: boolean;
    limits?: UsageLimits | null;
    onsettings?: () => void;
    onhalt?: () => void;
    needsYou?: number;
    ontriage?: () => void;
    update?: UpdateStatus | null;
    onupdate?: () => void;
    herdrUpdate?: HerdrUpdateStatus | null;
    onherdrupdate?: () => void;
    whatsNew?: boolean;
    onwhatsnew?: () => void;
    // page-level session-status filter the tallies toggle; null = no filter
    statusFilter?: TallyStatus | null;
    onstatusfilter?: (status: TallyStatus | null) => void;
    // working-while-blocked display flags (store map); tallies + gear pip read the
    // DISPLAY status through it — the halt e-stop keeps the raw status (see below)
    workingBlocked?: Record<string, boolean>;
    /** Worst-of diagnostics state; hidden when "ok". */
    diagnosticsOverall?: DiagnosticState;
    /** Called when the health pip is clicked — should open Settings → Diagnose tab. */
    ondiagnose?: () => void;
    /** Count of proposed learnings awaiting approve/dismiss across all repos. */
    learnings?: number;
    /** Count of over-budget ("curate") active rules across all repos. */
    learningsCurate?: number;
    /** Opens the global learnings drawer. */
    onlearnings?: () => void;
    /** Number of held tasks; updated live by held:changed WS events. */
    heldCount?: number;
  } = $props();

  // tally click: toggle — clicking the active status clears the filter
  const clickStatus = (s: TallyStatus) => onstatusfilter?.(statusFilter === s ? null : s);

  const updateAvailable = $derived(!!update && update.behind > 0);
  const herdrUpdateAvailable = $derived(!!herdrUpdate && herdrUpdate.updateAvailable);
  // Tallies are DISPLAY: a working-while-blocked session counts as working, not
  // blocked (displayStatus upgrades it). The halt e-stop instead reads the RAW
  // status (`haltable` below): the server's haltAll only reaches agents herdr
  // itself reports working, which the latched-"blocked" session is not.
  const working = $derived(
    sessions.filter((s) => displayStatus(s, workingBlocked) === "running").length,
  );
  const haltable = $derived(sessions.filter((s) => s.status === "running").length);
  // Responsive right-cluster decisions live in ./top-bar-layout (pure + unit-tested,
  // see top-bar-layout.test.ts). "touch-desktop" is the unfolded-foldable crunch
  // (~1000px) the #247/#322 overflow fixes targeted. The halt e-stop is NOT a bar
  // badge — it folds into the always-present gear menu — so it never counts here.
  const mode = $derived(modeOf(mobile, touch));
  const learningsPresent = $derived(learnings > 0 || learningsCurate > 0);
  // Badge shows proposed count when any proposed, else the curate count
  const learningsCount = $derived(learnings > 0 ? learnings : learningsCurate);
  const learningsLabel = $derived(learnings > 0 ? m.learnings_title() : m.learnings_trim_title());
  const learningsTip = $derived(
    learnings > 0 ? m.topbar_learnings_tip() : m.topbar_learnings_curate_tip(),
  );
  const chrome = $derived({
    updateAvailable,
    herdrUpdateAvailable,
    needsYou,
    whatsNew,
    learnings: learnings + learningsCurate,
  });
  const plan = $derived(topBarPlan(mode, chrome));

  // ── Desktop compaction is MEASURED, not count-based ──────────────────────────
  // touch-desktop (≈fixed 1000px device, #322) + mobile stay rule-driven in
  // top-bar-layout. But real desktop WIDTH varies — a ~1366px laptop gives the bar
  // ~1322px usable, where even two full-label badges (~1354px) overflow, which a
  // fixed badge count can't catch. So on desktop we compact only when the bar would
  // ACTUALLY overflow its container, measured at runtime.
  let hudEl = $state<HTMLElement | null>(null);
  let desktopCompact = $state(false);
  // Cached TRUE full-label content width (scrollWidth at the full render). The
  // full-label content is RESIZE-INVARIANT — nothing inside the bar wraps or reflows
  // on container width at desktop, so the content's intrinsic width doesn't change
  // when only .hud's clientWidth does. We therefore measure it ONCE per content change
  // and cache it, then a pure resize just compares the cached width against the new
  // clientWidth — no reset-to-full, so no per-frame flicker during a window drag.
  // 0 = unknown/stale (must re-measure). Non-reactive: changing it must not re-run effects.
  let fullWidth = 0;
  let measureScheduled = false;

  // Re-measure the true full-label width: render full (so scrollWidth IS the full-label
  // width), then in the next frame read + cache it and decide compaction. Used on a
  // CONTENT change (badge/mode/gauge), where the cached width is stale. The brief
  // full-render frame only happens on content changes now, not on every resize tick.
  function measureFull() {
    if (measureScheduled) return;
    measureScheduled = true;
    desktopCompact = false; // render full so scrollWidth is the full-label width
    requestAnimationFrame(() => {
      measureScheduled = false;
      if (!hudEl || mode !== "desktop") {
        desktopCompact = false;
        fullWidth = 0;
        return;
      }
      fullWidth = hudEl.scrollWidth;
      // 1px slack absorbs sub-pixel layout rounding, so a flush-fitting full-label bar
      // (scrollWidth a hair over clientWidth) isn't needlessly compacted.
      desktopCompact = fullWidth > hudEl.clientWidth + 1;
    });
  }

  // Resize path: decide compaction from the CACHED full width vs the current
  // clientWidth — NO reset-to-full, so a continuous window drag doesn't flash
  // full→compact every frame. If the cache is stale (0), fall back to a one-shot
  // full measurement.
  function decideFromCache() {
    if (mode !== "desktop" || !hudEl) {
      desktopCompact = false;
      fullWidth = 0; // off-desktop: clear so re-entry re-measures fresh (matches content effect)
      return;
    }
    if (fullWidth > 0) desktopCompact = fullWidth > hudEl.clientWidth + 1;
    else measureFull();
  }

  // Re-measure when what's-in-the-bar (badge count), the layout mode, or the gauges
  // change. These are the CONTENT changes that alter the full-label width, so they
  // INVALIDATE the cache and force a fresh full measurement.
  $effect(() => {
    void mode;
    void badgeCount(chrome);
    // Gauges MUST be a tracked dependency: `limits` (store.usageLimits) starts null
    // and is filled ASYNCHRONOUSLY (snapshot/SSE land after first paint), then ~110px
    // of inline gauges render inside .hud. That arrival changes NEITHER mode/badgeCount
    // NOR the .shell-capped box width (only inner content grows), so without this read
    // neither this effect nor the ResizeObserver would re-fire — the bar would stay
    // un-compacted and overflow until an unrelated resize/badge change self-healed it.
    void gauges.length;
    if (mode !== "desktop") {
      desktopCompact = false;
      fullWidth = 0; // off-desktop: clear the cache so re-entry re-measures fresh
      return;
    }
    fullWidth = 0; // content changed → cached full width is stale
    measureFull();
  });
  // Re-decide when the bar's own box size changes (window resize). This takes the
  // CACHED-width path (decideFromCache) — no reset-to-full — so it does NOT flash the
  // bar back to full on every drag frame, and the .shell-capped box means content
  // compacting can't re-trigger it into an oscillation.
  $effect(() => {
    if (!hudEl) return;
    const ro = new ResizeObserver(() => decideFromCache());
    ro.observe(hudEl);
    return () => ro.disconnect();
  });

  // OR the measured desktop result into the flags the markup already keys off
  // (compactBadges / hideClockTime). The touch-desktop rules from top-bar-layout
  // stay as-is; desktop adds the measured overflow signal.
  const hideClockTime = $derived(plan.hideClockTime || (mode === "desktop" && desktopCompact));
  const compactBadges = $derived(plan.compactBadges || (mode === "desktop" && desktopCompact));

  const idle = $derived(sessions.filter((s) => displayStatus(s, workingBlocked) === "idle").length);
  const blocked = $derived(
    sessions.filter((s) => displayStatus(s, workingBlocked) === "blocked").length,
  );
  const clock = $derived(new Date(nowMs).toTimeString().slice(0, 8));
  const connText = $derived(
    connected ? m.topbar_clock_tip_connected() : m.topbar_clock_tip_disconnected(),
  );

  // Three-step ladder (usage-gauges.ts): muted at rest, amber 75–90 (warming),
  // red >90 (approaching cap). Red is a documented Four-Light exception — gauge
  // bar-fill/text only (no halo/pip), so blocked pip stays the loudest red on screen.

  const periodLabel = (k: GaugeKey) =>
    k === "5H" ? m.topbar_gauge_period_5h() : m.topbar_gauge_period_weekly();

  function gaugeTip(k: GaugeKey, pct: number, resetAt: number): string {
    return `${m.topbar_gauge_title({
      period: periodLabel(k),
      pct,
      rel: formatResetIn(resetAt, nowMs),
      abs: formatReset(resetAt, nowMs),
    })}${limits?.stale ? m.topbar_gauge_stale_suffix() : ""}`;
  }

  // Desktop (fine pointer) shows both windows with hover tooltips. Touch has no
  // hover, so it collapses to the window closest to its cap and exposes the full
  // breakdown — including reset times — through a tap popover instead.
  const gauges = $derived(gaugeList(limits));
  const hotter = $derived(hotterGauge(limits));
  // api-key auth mode: subscription usage windows carry no data. Fail closed —
  // render an explicit note instead of empty/zero meters.
  const subscriptionOnly = $derived(limits?.subscriptionOnly === true);

  // Paid extra-credit overage. Rendered as a distinct CR element (NOT a gaugeList
  // entry — its window shape carries no credit fields, and a 0%-pct credit gauge
  // must never become the "hotter" collapsed gauge). Null → render nothing.
  const credits = $derived(limits?.credits ?? null);
  const overspend = $derived(overspending(limits));
  // Bar fill is spent/cap (NOT pct — pct rounds to 0 while money is already spent).
  const creditFill = $derived(
    credits && credits.cap > 0 ? Math.min(Math.max(credits.spent / credits.cap, 0), 1) : 0,
  );
  // Currency + numbers are passthrough data, NOT translated. Amounts use 2 decimals to match the
  // server push copy (src/push.ts extraCreditsBody) so the gauge and the notification read identically.
  const creditAmount = $derived(
    credits
      ? `${credits.currency}${credits.spent.toFixed(2)} / ${credits.currency}${credits.cap.toFixed(2)}`
      : "",
  );
  // Alert hue: amber is the design system's caution token (also used by the update
  // badge). The usage gauges now go red >90 (see gaugeColor); amber is their 75–90
  // warning tier. pct is 0 here so gaugeColor(pct) can't drive it — overspend keys
  // off real spend instead. Stale → muted; idle → neutral.
  const creditColor = $derived(
    credits?.stale ? "var(--color-muted)" : overspend ? "var(--color-amber)" : "var(--color-muted)",
  );

  // Refresh: POST /api/usage/refresh; the server's calibrate emit bridges back to the
  // client `ln` WS frame, so the gauge self-updates — we ignore the returned value.
  // Fail closed: a rejected refresh sets an error flag so it never looks like success.
  let refreshing = $state(false);
  let refreshError = $state(false);
  async function doRefresh() {
    if (refreshing) return;
    refreshing = true;
    refreshError = false;
    try {
      await refreshUsage();
    } catch {
      refreshError = true;
    } finally {
      refreshing = false;
    }
  }

  let popoverOpen = $state(false);
  // Desktop (fine pointer): hovering the inline gauges opens a richer detail
  // card — full window names, wide bars, percentages and reset times — in place
  // of the bare one-line text tooltip. Hover-only, matching the prior CSS
  // tooltip; screen readers still get the full tip via each gauge's aria-label.
  // The inline bars stay for the at-a-glance read; the card is the detail view.
  let detailOpen = $state(false);
  let gaugeWrap = $state<HTMLElement | null>(null);

  // ── Held-tasks popover ────────────────────────────────────────────────────
  // Non-modal anchored popover (design-system "small anchored popover" exemption:
  // not aria-modal on desktop, no scrim). Cloned from AutomationPanel's .auto-pop.
  let heldPopOpen = $state(false);
  let heldPopEl = $state<HTMLDivElement | null>(null);
  let heldBadgeBtn = $state<HTMLButtonElement | null>(null);
  let heldPopFlipUp = $state(false);
  let heldItems = $state<HeldTask[]>([]);
  let heldLoading = $state(false);

  async function loadHeld() {
    heldLoading = true;
    try {
      heldItems = await listHeld();
    } catch {
      // best-effort; count stays live via WS
    } finally {
      heldLoading = false;
    }
  }

  function openHeldPop() {
    heldPopOpen = true;
    loadHeld();
  }

  function closeHeldPop(returnFocus = false) {
    heldPopOpen = false;
    if (returnFocus) heldBadgeBtn?.focus();
  }

  function toggleHeldPop() {
    if (heldPopOpen) closeHeldPop();
    else openHeldPop();
  }

  async function doSpawnHeld(id: string) {
    try {
      await spawnHeld(id);
      await loadHeld();
    } catch {
      // ignore; WS will update count
    }
  }

  async function doDiscardHeld(id: string) {
    try {
      await discardHeld(id);
      await loadHeld();
    } catch {
      // ignore
    }
  }

  // Flip-up + height clamp for held popover — mirrors AutomationPanel's $effect.
  const MIN_HEIGHT_HELD = 120;
  const EDGE_GAP_HELD = 12;
  const ANCHOR_GAP_HELD = 4;
  $effect(() => {
    const el = heldPopEl;
    if (!el) return;
    const clamp = () => {
      const anchor = el.offsetParent;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - ANCHOR_GAP_HELD - EDGE_GAP_HELD;
      const above = rect.top - ANCHOR_GAP_HELD - EDGE_GAP_HELD;
      heldPopFlipUp = below < MIN_HEIGHT_HELD && above > below;
      el.style.maxHeight = `${Math.max(MIN_HEIGHT_HELD, heldPopFlipUp ? above : below)}px`;
    };
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        clamp();
      });
    };
    clamp();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const ro = new ResizeObserver(schedule);
    if (el.offsetParent) ro.observe(el.offsetParent);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      ro.disconnect();
    };
  });

  // Auto-close held popover when count drops to 0 while open.
  $effect(() => {
    if (heldPopOpen && (heldCount ?? 0) === 0) closeHeldPop();
  });
  // Refresh held list when the WS count changes while the popover is open.
  $effect(() => {
    void heldCount;
    if (heldPopOpen) loadHeld();
  });
  $effect(() => {
    // close the popover when it can no longer be opened (no gauge AND no credit, or off touch)
    if (!touch || (!hotter && !credits)) popoverOpen = false;
  });

  // The gear adapts to herd state. When the herd is idle (haltable === 0) a click
  // opens the Settings pane directly — matching the gear's "Settings" tooltip/aria.
  // Only when something is haltable does it become a menu button: one click opens a
  // small popup with the e-stop row above a "Settings…" row.
  let menuOpen = $state(false);
  let gearBtn = $state<HTMLButtonElement | null>(null);
  let gearWrap = $state<HTMLElement | null>(null);
  let menuEl = $state<HTMLElement | null>(null);

  // Two-step arm→confirm for the emergency stop, now living inside the menu: the first
  // activation arms the red "Halt N?" row, a second commits (onhalt). It auto-disarms
  // after a few seconds, on Escape, on close, or once nothing is left running — so a
  // stray tap on a rarely-used control can never halt the fleet on its own.
  let armed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  function disarmHalt() {
    armed = false;
    clearTimeout(armTimer);
  }
  function closeMenu(returnFocus = false) {
    menuOpen = false;
    disarmHalt();
    if (returnFocus) gearBtn?.focus();
  }
  function toggleMenu() {
    if (menuOpen) closeMenu();
    else menuOpen = true;
  }
  // On mobile the gear ALWAYS opens the menu — it now also hosts the quick theme /
  // contrast controls, which must be reachable with an idle herd. On desktop those
  // controls live in the ActionBar, so the gear keeps its leaner behaviour: idle herd
  // opens Settings directly; only a haltable herd turns it into a menu button.
  const gearOpensMenu = $derived(mobile || haltable > 0);
  // Mobile only: every gear-area signal collapses into ONE dot, colored by the
  // most serious active tier (red > orange > yellow > blue). Desktop keeps its
  // halt-pip + dedicated badges, so this stays null off-mobile.
  type GearPipTier = "red" | "orange" | "yellow" | "blue" | null;
  const gearPipTier = $derived<GearPipTier>(
    !mobile
      ? null
      : blocked > 0 || diagnosticsOverall === "error"
        ? "red"
        : haltable > 0 || updateAvailable
          ? "orange"
          : diagnosticsOverall === "warning"
            ? "yellow"
            : herdrUpdateAvailable || whatsNew || learningsPresent
              ? "blue"
              : null,
  );
  function clickGear() {
    if (!gearOpensMenu) {
      onsettings?.();
      return;
    }
    toggleMenu();
  }
  function clickHalt() {
    if (!armed) {
      armed = true;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => (armed = false), 4000);
    } else {
      disarmHalt();
      menuOpen = false;
      onhalt?.();
    }
  }
  function chooseSettings() {
    menuOpen = false;
    disarmHalt();
    onsettings?.();
  }
  // On open, move focus to the first menu item (proper menu-button keyboard flow).
  $effect(() => {
    if (menuOpen) menuEl?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  });
  // ArrowUp/Down cycle between the menu items; Escape closes and returns focus to the gear.
  function onMenuKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menuEl?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []);
    if (!items.length) return;
    const here = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown" ? (here + 1) % items.length : (here - 1 + items.length) % items.length;
    items[next]?.focus();
  }
  // If the herd goes quiet underneath the gear (agents finished), dismiss the menu and
  // drop any armed state. Otherwise the e-stop row vanishes from the open menu, leaving a
  // stale lone-Settings popup — and since an idle gear opens Settings directly, the next
  // click would surface Settings without first dismissing it. When the menu wasn't open we
  // still disarm, so a later run never surfaces a pre-armed row.
  $effect(() => {
    if (haltable !== 0) return;
    // On mobile the menu also hosts the quick theme/contrast controls, so it stays
    // valid with an idle herd — keep it open and just drop any armed e-stop state.
    if (mobile) {
      disarmHalt();
      return;
    }
    if (menuOpen) closeMenu(true);
    else disarmHalt();
  });
  // Destroy-only cleanup (no tracked reads → runs once): never leak the disarm timer.
  $effect(() => () => clearTimeout(armTimer));

  function dismissOnEscape(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (popoverOpen) popoverOpen = false;
    if (heldPopOpen) {
      closeHeldPop(true);
      return;
    }
    if (menuOpen) closeMenu(true);
  }
  function dismissOnOutside(e: MouseEvent) {
    if (popoverOpen && gaugeWrap && !gaugeWrap.contains(e.target as Node)) popoverOpen = false;
    if (
      heldPopOpen &&
      heldBadgeBtn &&
      heldPopEl &&
      !heldBadgeBtn.contains(e.target as Node) &&
      !heldPopEl.contains(e.target as Node)
    ) {
      closeHeldPop();
    }
    // On mobile the sheet's own `.menu-scrim` backdrop (onclick={() => closeMenu()}) handles
    // outside-tap and `use:dialog` handles Esc — so we MUST NOT gate on gearWrap containment
    // here, or every in-sheet click (which bubbles to <svelte:window>) wrongly dismisses the
    // sheet.  Desktop keeps the original outside-click behaviour unchanged.
    if (menuOpen && !mobile && gearWrap && !gearWrap.contains(e.target as Node)) closeMenu();
  }
</script>

<svelte:window onkeydown={dismissOnEscape} onclick={dismissOnOutside} />

<!-- CR credit gauge + detail: extracted to top-bar/ children (#855). -->

<div class="hud bracket" class:mobile bind:this={hudEl}>
  <div class="logo">SHEP<b>HERD</b></div>
  {#if !mobile && !touch}
    <!-- hidden on phones AND unfolded foldables: the label crowds the bar and
         pushes the gear out on touch layouts narrower than a real desktop -->
    <div class="sep"></div>
    <div class="micro">Mission&nbsp;Control</div>
  {/if}
  <div class="sep"></div>
  <TopBarTallies
    {mobile}
    total={sessions.length}
    {working}
    {idle}
    {blocked}
    {statusFilter}
    {onstatusfilter}
    {clickStatus}
  />
  <div class="rightside">
    {#if needsYou > 0}
      <button
        class="needsyou"
        class:compact={mobile || compactBadges}
        onclick={() => ontriage?.()}
        aria-label={m.common_needs_you({ count: needsYou })}
      >
        {#if mobile || compactBadges}
          <span class="ny-icon" aria-hidden="true">!</span><span class="ny-n">{needsYou}</span>
        {:else}
          {m.common_needs_you({ count: needsYou })}
        {/if}
      </button>
    {/if}
    <TopBarHeldBadge
      {heldCount}
      {mobile}
      {compactBadges}
      {hotter}
      {nowMs}
      {heldPopFlipUp}
      {heldItems}
      {heldLoading}
      bind:heldPopOpen
      bind:heldBadgeBtn
      bind:heldPopEl
      {toggleHeldPop}
      {doSpawnHeld}
      {doDiscardHeld}
    />
    {#if !mobile}
      <TopBarUsage
        {subscriptionOnly}
        {touch}
        stale={limits?.stale ?? false}
        {hotter}
        {gauges}
        {credits}
        {overspend}
        {creditFill}
        {creditColor}
        {creditAmount}
        {nowMs}
        {refreshing}
        {refreshError}
        onRefresh={doRefresh}
        {periodLabel}
        {gaugeTip}
        bind:popoverOpen
        bind:detailOpen
        bind:gaugeWrap
      />
    {/if}
    <div class="clock tip" class:no-time={hideClockTime} data-tip={connText} aria-label={connText}>
      <span class="dot" class:on={connected}>●</span><span class="time">{clock}</span>
    </div>
    {#if !mobile}<TopBarBadges
        {compactBadges}
        {updateAvailable}
        {update}
        {onupdate}
        {herdrUpdateAvailable}
        {herdrUpdate}
        {onherdrupdate}
        {whatsNew}
        {onwhatsnew}
        {diagnosticsOverall}
        {ondiagnose}
        {learningsPresent}
        {learnings}
        {learningsCurate}
        {learningsTip}
        {learningsLabel}
        {learningsCount}
        {onlearnings}
      />{/if}
    <!-- The gear adapts to state: idle herd → a click opens Settings directly;
         when something is haltable it becomes a menu button opening the e-stop above
         the Settings entry. The pip differs by platform:
         • Desktop keeps the dedicated halt-pip — the only at-rest cue that there's a
           herd to halt: amber while agents simply work (matches the working colour),
           escalating to red only when something is blocked. Other signals (update,
           health, what's-new, learnings) live in their own labelled badges.
         • Mobile folds those badges into the gear's bottom sheet, so the gear carries
           a SINGLE collapsed dot (gearPipTier) coloured by the most serious active
           signal — red > orange > yellow > blue. Red still means "needs you",
           consistent with the rest of the bar. -->
    <TopBarGear
      {mobile}
      {haltable}
      {blocked}
      {gearPipTier}
      {gearOpensMenu}
      {armed}
      bind:menuOpen
      bind:gearWrap
      bind:gearBtn
      bind:menuEl
      {clickGear}
      {clickHalt}
      {chooseSettings}
      {onMenuKey}
    />
  </div>
</div>

<!-- Blur backdrop behind the opened mobile bottom sheet, so the panel reads as the focus
     and the herd recedes. Rendered outside .gear-wrap so outside-click detection fires on it.
     onclick also wires close explicitly to complement the window-level handler.
     The portal wrapper re-parents both children to <body> so position:fixed resolves
     against the viewport, not the will-change:transform chrome header. The wrapper itself
     is display:contents with no transform/filter/will-change so it establishes no
     containing block of its own. -->
{#if menuOpen && mobile}
  <div class="gear-sheet-portal" use:portal>
    <div class="menu-scrim scrim" aria-hidden="true" onclick={() => closeMenu()}></div>
    <!-- Mobile bottom sheet: slides up from the bottom of the screen. role=dialog + use:dialog
         provides focus-trap + Esc→closeMenu + focus-restore. Children are plain buttons/links,
         NOT role="menuitem" (that role is invalid inside a dialog). -->
    <div
      class="gear-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={m.topbar_sheet_title()}
      use:dialog={{ onclose: closeMenu }}
      transition:fly={{ y: 520, duration: reduceMotion ? 0 : 220, opacity: 1 }}
    >
      <!-- Grab handle + title row -->
      <div class="sheet-handle-row" aria-hidden="true">
        <div class="sheet-handle"></div>
      </div>
      <div class="sheet-title-row">
        <span class="sheet-title micro">{m.topbar_sheet_title()}</span>
        <button
          type="button"
          class="sheet-close"
          onclick={() => closeMenu()}
          aria-label={m.common_close()}>✕</button
        >
      </div>

      <!-- Quick appearance: dark/light theme + high-contrast toggle -->
      <div class="quick">
        <div class="theme-seg" role="group" aria-label={m.actionbar_theme_group_aria()}>
          {#each QUICK_THEMES as t (t.pref)}
            <button
              type="button"
              class="t-opt"
              class:on={theme.resolved === t.pref}
              aria-pressed={theme.resolved === t.pref}
              aria-label={m.actionbar_theme_option({ label: t.label() })}
              onclick={() => theme.setPref(t.pref)}><ThemeIcon icon={t.icon} /></button
            >
          {/each}
        </div>
        <button
          type="button"
          class="contrast-toggle"
          class:on={theme.contrast}
          aria-pressed={theme.contrast}
          aria-label={m.actionbar_contrast_toggle()}
          onclick={() => theme.toggleContrast()}><ThemeIcon icon="contrast" /></button
        >
      </div>
      <div class="sheet-sep"></div>

      <!-- Usage section: full gauge breakdown (mirrors the touch popover content) -->
      {#if gauges.length || credits || subscriptionOnly}
        <div class="sheet-section-label micro">{m.topbar_sheet_usage()}</div>
        {#if subscriptionOnly}
          <div class="sheet-row-text micro">{m.usage_subscription_only()}</div>
        {:else}
          <div class="sheet-gauges" class:stale={limits?.stale}>
            {#each gauges as g (g.label)}
              <div class="sheet-gauge-row">
                <div class="sheet-gauge-head">
                  <span class="gp-period">{periodLabel(g.label)}</span>
                  <span class="g-pct" style="color:{gaugeColor(g.w.pct)}">{g.w.pct}%</span>
                </div>
                <span class="g-bar g-bar-wide"
                  ><span
                    class="g-fill"
                    style="transform:scaleX({Math.min(Math.max(g.w.pct, 0), 100) /
                      100});background:{gaugeColor(g.w.pct)}"
                  ></span></span
                >
                <div class="gauge-pop-reset micro">
                  {m.topbar_gauge_reset_rel({
                    rel: formatResetIn(g.w.resetAt, nowMs),
                    abs: formatReset(g.w.resetAt, nowMs),
                  })}
                </div>
              </div>
            {/each}
            <CreditDetail
              {credits}
              {creditFill}
              {creditColor}
              {creditAmount}
              {nowMs}
              {refreshing}
              {refreshError}
              onRefresh={doRefresh}
            />
          </div>
        {/if}
        <div class="sheet-sep"></div>
      {/if}

      <!-- Diagnose row: only when health is not ok -->
      {#if diagnosticsOverall !== "ok"}
        <button
          type="button"
          class="sheet-item"
          class:alert={diagnosticsOverall === "error"}
          onclick={() => {
            closeMenu();
            ondiagnose?.();
          }}
          aria-label={m.diagnostics_pip_label()}
        >
          <span class="sheet-glyph" aria-hidden="true"
            >{diagnosticsOverall === "error" ? "✕" : "⚠"}</span
          >
          <span class="sheet-label">{m.diagnostics_pip_label()}</span>
        </button>
      {/if}

      <!-- Update row: when shepherd update is available -->
      {#if updateAvailable}
        <button
          type="button"
          class="sheet-item sheet-update"
          onclick={() => {
            closeMenu();
            onupdate?.();
          }}
          aria-label={m.topbar_update_badge()}
        >
          <span class="sheet-glyph" aria-hidden="true">▲</span>
          <span class="sheet-label">{m.topbar_update_badge()} · {update!.behind}</span>
        </button>
      {/if}

      <!-- Herdr update row: when herdr update is available -->
      {#if herdrUpdateAvailable}
        <button
          type="button"
          class="sheet-item sheet-update"
          onclick={() => {
            closeMenu();
            onherdrupdate?.();
          }}
          aria-label={m.topbar_herdr_update_badge()}
        >
          <span class="sheet-glyph" aria-hidden="true">▲</span>
          <span class="sheet-label">{m.topbar_herdr_update_badge()}</span>
        </button>
      {/if}

      <!-- What's New row -->
      {#if whatsNew}
        <button
          type="button"
          class="sheet-item"
          onclick={() => {
            closeMenu();
            onwhatsnew?.();
          }}
          aria-label={m.whatsnew_topbar_aria()}
        >
          <span class="sheet-glyph" aria-hidden="true">●</span>
          <span class="sheet-label">{m.whatsnew_open()}</span>
        </button>
      {/if}

      <!-- Learnings row: review proposed house rules across all repos -->
      {#if learningsPresent}
        <button
          type="button"
          class="sheet-item"
          onclick={() => {
            closeMenu();
            onlearnings?.();
          }}
          aria-label={learnings > 0
            ? m.learnings_open_aria({ count: learnings })
            : m.learnings_open_curate_aria({ count: learningsCurate })}
        >
          <span class="sheet-glyph" aria-hidden="true">✦</span>
          <span class="sheet-label">{learningsLabel} · {learningsCount}</span>
        </button>
      {/if}

      <div class="sheet-sep"></div>

      <!-- Halt e-stop: two-step arm→confirm, same as desktop -->
      {#if haltable > 0}
        <button
          class="sheet-item halt-item"
          class:armed
          type="button"
          onclick={clickHalt}
          aria-label={armed
            ? m.halt_arm_aria({ count: haltable })
            : m.halt_all_aria({ count: haltable })}
        >
          <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 2 H16 L22 8 V16 L16 22 H8 L2 16 V8 Z" fill="currentColor" />
          </svg>
          <span class="sheet-label"
            >{armed ? m.halt_arm({ count: haltable }) : m.halt_menu_item({ count: haltable })}</span
          >
        </button>
        <div class="sheet-sep"></div>
      {/if}

      <!-- Settings -->
      <button type="button" class="sheet-item" onclick={chooseSettings}>
        <span class="sheet-glyph" aria-hidden="true">⚙</span>
        <span class="sheet-label">{m.settings_title()}</span>
      </button>

      <!-- Docs + version footer -->
      <div class="sheet-sep"></div>
      <a
        class="sheet-item"
        href={REPO_URL}
        target="_blank"
        rel="external noreferrer noopener"
        onclick={() => closeMenu()}
      >
        <span class="sheet-glyph" aria-hidden="true">↗</span>
        <span class="sheet-label">{m.topbar_menu_docs()}</span>
      </a>
      <div class="sheet-foot micro">v{version}</div>
    </div>
  </div>
{/if}

<style>
  .hud {
    position: relative;
    border: 1px solid var(--color-line);
    /* flat tonal step + hairline; depth never comes from gradients (DESIGN.md) */
    background: var(--color-panel);
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 22px;
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: -1px;
    right: -1px;
    border-left: 0;
    border-top: 0;
  }
  .logo {
    font-weight: 700;
    letter-spacing: 0.34em;
    color: var(--color-ink-bright);
    font-size: var(--fs-lg);
    flex-shrink: 0;
  }
  .logo b {
    color: var(--color-amber);
  }
  .sep {
    width: 1px;
    height: 20px;
    background: var(--color-line-bright);
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .needsyou {
    background: color-mix(in srgb, var(--color-red) 18%, transparent);
    border: 1px solid var(--color-red);
    color: var(--color-red);
    letter-spacing: 0.14em;
    font-size: var(--fs-meta);
    padding: 5px 10px;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  /* learnings-btn, learn-glyph, learn-n, gear-wrap, gear-menu moved to top-bar/TopBarBadges.svelte / TopBarGear.svelte (#855) */
  /* Quick appearance row: dark/light segment + high-contrast toggle, mirroring the
     desktop ActionBar but sized up for touch (44px tap targets). */
  .quick {
    display: flex;
    align-items: stretch;
    gap: 8px;
    padding: 2px;
  }
  .theme-seg {
    display: flex;
    flex: 1;
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    overflow: hidden;
  }
  .t-opt {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    background: transparent;
    border: 0;
    border-left: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: var(--fs-xl);
    line-height: 1;
    cursor: pointer;
  }
  .t-opt:first-child {
    border-left: 0;
  }
  .t-opt:hover {
    color: var(--color-ink-bright);
  }
  /* seg group clips overflow, so an inset ring would be cropped — outline instead */
  .t-opt:focus-visible {
    outline: 1.5px solid var(--color-line-bright);
    outline-offset: -1.5px;
  }
  .t-opt.on {
    color: var(--color-amber);
    background: var(--color-inset);
  }
  .contrast-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 56px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-muted);
    font-size: var(--fs-xl);
    line-height: 1;
    cursor: pointer;
  }
  .contrast-toggle:hover {
    color: var(--color-ink-bright);
  }
  .contrast-toggle:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .contrast-toggle.on {
    color: var(--color-amber);
    background: var(--color-inset);
    border-color: var(--color-amber);
  }
  /* Portal wrapper: re-parents scrim + sheet to <body> so position:fixed resolves
     against the viewport, not the will-change:transform chrome header (see portal.ts).
     display:contents collapses the wrapper in the layout — it establishes NO containing
     block of its own (no transform, filter, will-change, or contain). */
  .gear-sheet-portal {
    display: contents;
  }
  /* Scrim: sits below the mobile bottom sheet (z 49) but above app content.
     Uses the canonical .scrim primitive (dim + blur) from app.css. */
  .menu-scrim {
    z-index: 49;
  }

  /* Mobile bottom sheet: slides up from the bottom. Fixed to left/right/bottom edges,
     tall enough to hold all sections without viewport overflow. The sheet itself is
     opaque panel chrome — the .scrim behind it dims+blurs the herd content. */
  .gear-sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    background: var(--color-panel);
    border-top: 1px solid var(--color-line-bright);
    border-radius: 10px 10px 0 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 8px 12px;
    /* safe-area bottom for notched phones */
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    max-height: 90dvh;
    overflow-y: auto;
  }
  .sheet-handle-row {
    display: flex;
    justify-content: center;
    padding: 10px 0 4px;
  }
  .sheet-handle {
    width: 40px;
    height: 4px;
    border-radius: 2px;
    background: var(--color-line-bright);
  }
  .sheet-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 4px 6px;
  }
  .sheet-title {
    color: var(--color-muted);
  }
  .sheet-close {
    background: none;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    min-width: 44px;
    min-height: 44px;
    font-size: var(--fs-lg);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sheet-sep {
    height: 1px;
    margin: 5px 4px;
    background: var(--color-line);
  }
  .sheet-section-label {
    padding: 6px 8px 2px;
    color: var(--color-muted);
  }
  .sheet-row-text {
    padding: 6px 8px;
    color: var(--color-muted);
  }
  /* Full gauge breakdown in the sheet — one row per window, wider bars. */
  .sheet-gauges {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 8px 4px;
  }
  .sheet-gauges.stale {
    opacity: 0.5;
  }
  .sheet-gauge-row {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .sheet-gauge-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    font-variant-numeric: tabular-nums;
  }
  /* Sheet action rows: ≥44px targets, token-driven, no role=menuitem (invalid in dialog). */
  .sheet-item {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 44px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-lg);
    text-align: left;
    padding: 10px 12px;
    cursor: pointer;
    white-space: nowrap;
    text-decoration: none;
  }
  .sheet-item:hover,
  .sheet-item:focus-visible {
    background: color-mix(in srgb, var(--color-line-bright) 40%, transparent);
    outline: none;
  }
  .sheet-item.alert {
    color: var(--color-amber);
  }
  .sheet-item.alert:hover,
  .sheet-item.alert:focus-visible {
    background: color-mix(in srgb, var(--color-amber) 12%, transparent);
  }
  /* Update rows: amber accent (same semantic hue as the inline update badge). */
  .sheet-item.sheet-update {
    color: var(--color-amber);
  }
  .sheet-item.sheet-update:hover,
  .sheet-item.sheet-update:focus-visible {
    background: color-mix(in srgb, var(--color-amber) 12%, transparent);
  }
  /* e-stop row in the sheet — same muted-then-red pattern as the desktop menu. */
  .sheet-item.halt-item {
    color: var(--color-muted);
  }
  .sheet-item.halt-item:hover,
  .sheet-item.halt-item:focus-visible {
    background: color-mix(in srgb, var(--color-red) 14%, transparent);
    color: var(--color-red);
  }
  .sheet-item.halt-item.armed {
    background: color-mix(in srgb, var(--color-red) 22%, transparent);
    border-color: var(--color-red);
    color: var(--color-red);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: var(--fs-meta);
  }
  .sheet-item.halt-item.armed .menu-icon {
    width: var(--fs-lg);
    height: var(--fs-lg);
  }
  .sheet-glyph {
    width: var(--fs-lg);
    text-align: center;
    flex-shrink: 0;
  }
  .sheet-label {
    font-variant-numeric: tabular-nums;
  }
  .sheet-foot {
    padding: 6px 12px 2px;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  /* menu-item, menu-icon, menu-glyph, menu-label, halt-item, halt-pip, menu-sep moved to top-bar/TopBarGear.svelte (#855) */
  .rightside {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  /* gear, gear-pip, halt-pip, health-pip, health-dot moved to top-bar/TopBarGear.svelte / TopBarBadges.svelte (#855) */
  /* whatsnew-badge, whatsnew-dot-btn, wn-pip, health-pip, health-dot, update-badge, learnings-btn moved to top-bar/TopBarBadges.svelte (#855) */
  /* usage-sub-only, gauges-wrap, gauges, gauge, g-label, gauge-wrap, gauge-btn, gauge-pop,
     gauge-pop-desk, gp-window, gp-head, credit-amount moved to top-bar/TopBarUsage.svelte (#855) */
  .g-bar {
    width: 46px;
    height: 5px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  .g-fill {
    display: block;
    width: 100%;
    height: 100%;
    transform-origin: left;
    transition: transform 0.6s ease;
  }
  .g-pct {
    font-size: var(--fs-meta);
    min-width: 30px;
    text-align: right;
  }
  /* credit-gauge.* rules moved to top-bar/CreditGauge.svelte (#855) */
  /* credit-detail.* rules moved to top-bar/CreditDetail.svelte (#855) */
  .gauge-pop-reset {
    margin: 0 0 6px 30px;
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-faint);
  }
  .gauge-pop-reset:last-child {
    margin-bottom: 0;
  }
  /* gauge-pop-desk, gp-window, gp-head moved to top-bar/TopBarUsage.svelte (#855) */
  .gp-period {
    color: var(--color-text);
    font-size: var(--fs-meta);
    text-transform: capitalize;
  }
  /* gauge-pop-desk .g-bar-wide moved to top-bar/TopBarUsage.svelte (#855) */
  .sheet-gauge-row .g-bar-wide {
    width: 100%;
    height: 6px;
  }
  .sheet-gauge-row .gauge-pop-reset {
    margin: 0;
  }
  /* gauge-pop-desk .gauge-pop-reset moved to top-bar/TopBarUsage.svelte (#855) */
  /* update-badge, up-dot, up-n, update-pulse moved to top-bar/TopBarBadges.svelte (#855) */
  .clock {
    color: var(--color-ink-bright);
    letter-spacing: 0.16em;
    display: flex;
    gap: 9px;
    align-items: center;
    font-variant-numeric: tabular-nums;
  }
  /* Touch desktop-layout crowded by any right-side badge: hide the numeric
     time, keep the dot inline so the cluster no longer overflows the bar. */
  .clock.no-time {
    gap: 0;
  }
  .clock.no-time .time {
    display: none;
  }
  /* connection dot: informational, so it stays in the neutral ink ramp — bright
     when connected vs faint when dropped (brightness, not a status hue, carries
     the cue; the tooltip/aria text names the state). */
  .clock .dot {
    color: var(--color-faint);
  }
  .clock .dot.on {
    color: var(--color-ink-bright);
  }
  .hud.mobile {
    /* wrap instead of overflowing: on fold-cover (~280px) and phones the
       logo+tallies sit on line 1, the right-side controls drop to line 2
       rather than forcing horizontal page scroll or clipping the gear */
    flex-wrap: wrap;
    gap: 7px;
    row-gap: 8px;
    padding: 10px 12px;
    /* full-bleed like the herd panel in flow mode: drop the side borders +
       brackets and stretch into the shell's base edge padding
       (--mobile-shell-pad, shared with .shell.mobile in +page.svelte; with a
       larger safe-area inset the shell keeps the remainder). Top/bottom
       hairlines stay as section rules. */
    border-inline: 0;
    margin-inline: calc(-1 * var(--mobile-shell-pad));
  }
  .hud.mobile.bracket::before,
  .hud.mobile.bracket::after {
    display: none;
  }
  .hud.mobile .logo {
    font-size: var(--fs-base);
    letter-spacing: 0.12em;
  }
  /* Mobile: drop the numeric time and let the bare connection dot ride inline at
     the head of the right-side cluster (order:-1) — vertically centred with the
     gauge/gear instead of floating off-centre in the corner. */
  .hud.mobile .clock {
    order: -1;
    gap: 0;
  }
  .hud.mobile .clock .time {
    display: none;
  }
  .hud.mobile .rightside {
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 5px;
    row-gap: 8px;
  }
  /* .hud.mobile .gear moved to top-bar/TopBarGear.svelte as .gear.mobile (#855) */
  /* .hud.mobile .gauge-btn* dropped: .gauge-btn renders only when touch && !mobile,
     so .hud.mobile .gauge-btn can never match — verified dead (#855). */
  .hud.mobile .needsyou {
    min-height: 44px;
    padding: 8px 12px;
  }
  /* Phone: collapse the badge to an icon+count chip so the NEEDS YOU call-out
     fits on line 1 next to the gauge/gear instead of forcing the right-side
     controls to wrap to a second row. Full label stays as the aria-label. */
  .needsyou.compact {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-width: 44px;
    padding: 8px 10px;
    letter-spacing: 0;
    font-variant-numeric: tabular-nums;
  }
  .needsyou.compact .ny-icon {
    font-weight: 700;
    line-height: 1;
  }
  .needsyou.compact .ny-n {
    font-weight: 600;
  }

  /* Coarse pointers (touch, any layout width): the secondary icon buttons are
     tuned tight for a cursor on desktop. Give them a ≥44px hit area on touch
     without enlarging glyphs — padding/min-size only. Applies regardless of the
     mobile-width class so coarse-pointer tablets/foldables in desktop layout
     also clear the 44px guideline. Desktop (pointer: fine) sizing is untouched. */
  @media (pointer: coarse) {
    /* .gear/.menu-item moved to TopBarGear; .update-badge/.learnings-btn moved to TopBarBadges */
    .needsyou,
    .needsyou.compact {
      min-height: 44px;
      min-width: 44px;
    }
  }

  /* Desktop-only hover tooltips — never shown on touch / mobile devices. */
  @media (hover: hover) and (pointer: fine) {
    .tip {
      position: relative;
    }
    .tip::after {
      content: attr(data-tip);
      position: absolute;
      top: calc(100% + 9px);
      right: 0;
      white-space: nowrap;
      background: var(--color-panel);
      border: 1px solid var(--color-line-bright);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      color: var(--color-ink-bright);
      font-size: var(--fs-meta);
      letter-spacing: 0.06em;
      text-transform: none;
      padding: 5px 9px;
      border-radius: 2px;
      pointer-events: none;
      opacity: 0;
      transform: translateY(-3px);
      transition:
        opacity 0.12s ease,
        transform 0.12s ease;
      z-index: 50;
    }
    .tip:hover::after,
    .tip:focus-visible::after {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
