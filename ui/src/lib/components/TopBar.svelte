<script lang="ts">
  import type {
    Session,
    UsageLimits,
    UpdateStatus,
    HerdrUpdateStatus,
    DiagnosticState,
  } from "$lib/types";
  import { formatReset, relativeAge } from "$lib/format";
  import { displayStatus } from "$lib/display-status";
  import { gaugeList, hotterGauge, overspending, type GaugeKey } from "./usage-gauges";
  import { refreshUsage } from "$lib/api";
  import { m } from "$lib/paraglide/messages";
  import { modeOf, topBarPlan, badgeCount } from "./top-bar-layout";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { theme, type ThemePref } from "$lib/theme.svelte";
  import ThemeIcon from "$lib/components/ThemeIcon.svelte";
  import { REPO_URL, version } from "$lib/build-info";

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
  const chrome = $derived({
    updateAvailable,
    herdrUpdateAvailable,
    needsYou,
    whatsNew,
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

  // Two-step ladder: neutral muted fill at rest, amber once the window runs hot.
  // Usage level is telemetry, not agent state — red stays reserved for "blocked,
  // needs you" and green for "ready to ship" (Four-Light Rule, DESIGN.md).
  function gaugeColor(pct: number): string {
    return pct >= 90 ? "var(--color-amber)" : "var(--color-muted)";
  }

  const periodLabel = (k: GaugeKey) =>
    k === "5H" ? m.topbar_gauge_period_5h() : m.topbar_gauge_period_weekly();

  function gaugeTip(k: GaugeKey, pct: number, resetAt: number): string {
    return `${m.topbar_gauge_title({
      period: periodLabel(k),
      pct,
      reset: formatReset(resetAt, nowMs),
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
  // Alert hue: amber is the design system's caution token (reused by the usage
  // gauges' hot state + the update badge). pct is 0 here so gaugeColor(pct) can't
  // drive it — overspend keys off real spend instead. Stale → muted; idle → neutral.
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
    if (menuOpen) closeMenu(true);
  }
  function dismissOnOutside(e: MouseEvent) {
    if (popoverOpen && gaugeWrap && !gaugeWrap.contains(e.target as Node)) popoverOpen = false;
    if (menuOpen && gearWrap && !gearWrap.contains(e.target as Node)) closeMenu();
  }
</script>

<svelte:window onkeydown={dismissOnEscape} onclick={dismissOnOutside} />

<!-- CR credit gauge: the compact inline bar (label + bar + amount), reused across the
     desktop .gauges row and the desktop hover popover. Mirrors the .gauge recipe. -->
{#snippet creditGauge()}
  {#if credits}
    <div
      class="gauge credit-gauge"
      class:stale={credits.stale}
      class:alert={overspend}
      aria-label={overspend
        ? m.topbar_credits_alert_aria({ amount: creditAmount })
        : `${m.topbar_credits_period()} · ${creditAmount}`}
    >
      <span class="g-label micro">CR</span>
      <span class="g-bar"
        ><span class="g-fill" style="transform:scaleX({creditFill});background:{creditColor}"
        ></span></span
      >
      <span class="g-pct credit-amount" style="color:{creditColor}">{creditAmount}</span>
    </div>
  {/if}
{/snippet}

<!-- CR credit detail block for the popovers: full name, wide bar + amount, reset,
     snapshot age, stale note, and an on-demand refresh button. -->
{#snippet creditDetail()}
  {#if credits}
    <div class="credit-detail" class:stale={credits.stale}>
      <div class="gp-head">
        <span class="gp-period">{m.topbar_credits_period()}</span>
        <span class="g-pct credit-amount" style="color:{creditColor}">{creditAmount}</span>
      </div>
      <span class="g-bar g-bar-wide"
        ><span class="g-fill" style="transform:scaleX({creditFill});background:{creditColor}"
        ></span></span
      >
      <div class="credit-sub micro">
        {m.topbar_credits_amount({
          spent: `${credits.currency}${credits.spent.toFixed(2)}`,
          cap: `${credits.currency}${credits.cap.toFixed(2)}`,
        })}
      </div>
      {#if credits.resetAt !== null}
        <div class="gauge-pop-reset micro">
          {m.topbar_gauge_reset({ reset: formatReset(credits.resetAt, nowMs) })}
        </div>
      {/if}
      <div class="gauge-pop-reset micro">
        {m.topbar_credits_age({ age: relativeAge(credits.scrapedAt, nowMs) })}
      </div>
      {#if credits.stale}
        <div class="credit-stale micro">{m.topbar_credits_stale()}</div>
      {/if}
      <button
        type="button"
        class="credit-refresh micro"
        disabled={refreshing}
        aria-busy={refreshing}
        onclick={doRefresh}
      >
        {refreshing ? m.common_loading() : m.topbar_credits_refresh()}
      </button>
      {#if refreshError}
        <div class="credit-error micro" role="alert">{m.common_retry()}</div>
      {/if}
    </div>
  {/if}
{/snippet}

<div class="hud bracket" class:mobile bind:this={hudEl}>
  <div class="logo">SHEP<b>HERD</b></div>
  {#if !mobile && !touch}
    <!-- hidden on phones AND unfolded foldables: the label crowds the bar and
         pushes the gear out on touch layouts narrower than a real desktop -->
    <div class="sep"></div>
    <div class="micro">Mission&nbsp;Control</div>
  {/if}
  <div class="sep"></div>
  {#if mobile}
    <div class="tallies compact">
      <!-- aria-labels carry the COUNT alongside the action (the visible text is a
           bare digit, and an action-only label would hide the tally from screen
           readers — the desktop buttons get this for free from their text content) -->
      <button
        type="button"
        class="ctally"
        disabled={statusFilter == null}
        title={m.topbar_tally_clear_title()}
        aria-label={m.topbar_tally_total_aria({ count: sessions.length })}
        onclick={() => onstatusfilter?.(null)}
      >
        <span class="n">{sessions.length}</span>
      </button>
      <button
        type="button"
        class="ctally"
        class:active={statusFilter === "running"}
        title={m.topbar_tally_filter_title({ status: m.topbar_working_label() })}
        aria-label={m.topbar_tally_status_aria({
          status: m.topbar_working_label(),
          count: working,
        })}
        aria-pressed={statusFilter === "running"}
        onclick={() => clickStatus("running")}
      >
        <span class="cdot" style="color:var(--color-amber)">●</span><span class="n">{working}</span>
      </button>
      <span class="csep">·</span>
      <button
        type="button"
        class="ctally"
        class:active={statusFilter === "idle"}
        title={m.topbar_tally_filter_title({ status: m.topbar_idle_label() })}
        aria-label={m.topbar_tally_status_aria({ status: m.topbar_idle_label(), count: idle })}
        aria-pressed={statusFilter === "idle"}
        onclick={() => clickStatus("idle")}
      >
        <span class="n">{idle}</span>
      </button>
      <button
        type="button"
        class="ctally"
        class:active={statusFilter === "blocked"}
        title={m.topbar_tally_filter_title({ status: m.topbar_blocked_label() })}
        aria-label={m.topbar_tally_status_aria({
          status: m.topbar_blocked_label(),
          count: blocked,
        })}
        aria-pressed={statusFilter === "blocked"}
        onclick={() => clickStatus("blocked")}
      >
        <span class="cdot" style="color:var(--color-red)">!</span><span class="n">{blocked}</span>
      </button>
    </div>
  {:else}
    <div class="tallies" use:coachTarget={"tally-filter"}>
      <!-- the total is a CLEAR action — without an active filter it's a no-op, so
           it renders disabled (no hover/click affordance) until a status is set -->
      <button
        type="button"
        class="tally"
        disabled={statusFilter == null}
        title={m.topbar_tally_clear_title()}
        onclick={() => onstatusfilter?.(null)}
      >
        <span class="micro">{m.topbar_herd_label()}</span><span class="n">{sessions.length}</span>
      </button>
      <button
        type="button"
        class="tally"
        class:active={statusFilter === "running"}
        title={m.topbar_tally_filter_title({ status: m.topbar_working_label() })}
        aria-pressed={statusFilter === "running"}
        onclick={() => clickStatus("running")}
      >
        <span class="micro" style="color:var(--color-amber)">{m.topbar_working_label()}</span><span
          class="n">{working}</span
        >
      </button>
      <button
        type="button"
        class="tally"
        class:active={statusFilter === "idle"}
        title={m.topbar_tally_filter_title({ status: m.topbar_idle_label() })}
        aria-pressed={statusFilter === "idle"}
        onclick={() => clickStatus("idle")}
      >
        <span class="micro">{m.topbar_idle_label()}</span><span class="n">{idle}</span>
      </button>
      <button
        type="button"
        class="tally"
        class:active={statusFilter === "blocked"}
        title={m.topbar_tally_filter_title({ status: m.topbar_blocked_label() })}
        aria-pressed={statusFilter === "blocked"}
        onclick={() => clickStatus("blocked")}
      >
        <span class="micro" style="color:var(--color-red)">{m.topbar_blocked_label()}</span><span
          class="n">{blocked}</span
        >
      </button>
    </div>
  {/if}
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
    {#if subscriptionOnly}
      <span class="usage-sub-only micro">{m.usage_subscription_only()}</span>
    {:else if touch}
      {#if hotter || credits}
        <!-- touch: collapse to the hotter window (or the CR gauge when credits are the
             only signal); tap for the full breakdown. The collapsed button carries an
             alert state while extra credits are being spent. -->
        <div class="gauge-wrap" bind:this={gaugeWrap}>
          {#if hotter}
            <button
              class="gauge gauge-btn"
              class:stale={limits?.stale}
              class:alert={overspend}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={popoverOpen}
              aria-label={m.topbar_gauge_toggle_aria({
                period: periodLabel(hotter.label),
                pct: hotter.w.pct,
              })}
              onclick={() => (popoverOpen = !popoverOpen)}
            >
              <span class="g-label micro">{hotter.label}</span>
              <span class="g-bar"
                ><span
                  class="g-fill"
                  style="transform:scaleX({Math.min(Math.max(hotter.w.pct, 0), 100) /
                    100});background:{gaugeColor(hotter.w.pct)}"
                ></span></span
              >
              <span class="g-pct" style="color:{gaugeColor(hotter.w.pct)}">{hotter.w.pct}%</span>
            </button>
          {:else}
            <!-- credits-only: no usage windows scraped, but extra spend exists -->
            <button
              class="gauge gauge-btn"
              class:stale={credits?.stale}
              class:alert={overspend}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={popoverOpen}
              aria-label={overspend
                ? m.topbar_credits_alert_aria({ amount: creditAmount })
                : `${m.topbar_credits_period()} · ${creditAmount}`}
              onclick={() => (popoverOpen = !popoverOpen)}
            >
              <span class="g-label micro">CR</span>
              <span class="g-bar"
                ><span
                  class="g-fill"
                  style="transform:scaleX({creditFill});background:{creditColor}"
                ></span></span
              >
              <span class="g-pct credit-amount" style="color:{creditColor}">{creditAmount}</span>
            </button>
          {/if}
          {#if popoverOpen}
            <div
              class="gauge-pop"
              role="dialog"
              aria-label={m.topbar_gauge_popover_title()}
              class:stale={limits?.stale}
            >
              <div class="gauge-pop-title micro">
                {m.topbar_gauge_popover_title()}{limits?.stale ? m.topbar_gauge_stale_suffix() : ""}
              </div>
              {#each gauges as g (g.label)}
                <div class="gauge-pop-row">
                  <span class="g-label micro">{g.label}</span>
                  <span class="g-bar g-bar-wide"
                    ><span
                      class="g-fill"
                      style="transform:scaleX({Math.min(Math.max(g.w.pct, 0), 100) /
                        100});background:{gaugeColor(g.w.pct)}"
                    ></span></span
                  >
                  <span class="g-pct" style="color:{gaugeColor(g.w.pct)}">{g.w.pct}%</span>
                </div>
                <div class="gauge-pop-reset micro">
                  {m.topbar_gauge_reset({ reset: formatReset(g.w.resetAt, nowMs) })}
                </div>
              {/each}
              {@render creditDetail()}
            </div>
          {/if}
        </div>
      {/if}
    {:else if gauges.length || credits}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="gauges-wrap"
        onmouseenter={() => (detailOpen = true)}
        onmouseleave={() => (detailOpen = false)}
      >
        <div class="gauges" class:stale={limits?.stale}>
          {#each gauges as g (g.label)}
            <div class="gauge" aria-label={gaugeTip(g.label, g.w.pct, g.w.resetAt)}>
              <span class="g-label micro">{g.label}</span>
              <span class="g-bar"
                ><span
                  class="g-fill"
                  style="transform:scaleX({Math.min(Math.max(g.w.pct, 0), 100) /
                    100});background:{gaugeColor(g.w.pct)}"
                ></span></span
              >
              <span class="g-pct" style="color:{gaugeColor(g.w.pct)}">{g.w.pct}%</span>
            </div>
          {/each}
          {@render creditGauge()}
        </div>
        {#if detailOpen}
          <div class="gauge-pop gauge-pop-desk" role="tooltip" class:stale={limits?.stale}>
            <div class="gauge-pop-title micro">
              {m.topbar_gauge_popover_title()}{limits?.stale ? m.topbar_gauge_stale_suffix() : ""}
            </div>
            {#each gauges as g (g.label)}
              <div class="gp-window">
                <div class="gp-head">
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
                  {m.topbar_gauge_reset({ reset: formatReset(g.w.resetAt, nowMs) })}
                </div>
              </div>
            {/each}
            {#if credits}
              <div class="gp-window">
                {@render creditDetail()}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    <div class="clock tip" class:no-time={hideClockTime} data-tip={connText} aria-label={connText}>
      <span class="dot" class:on={connected}>●</span><span class="time">{clock}</span>
    </div>
    {#if updateAvailable}
      <button
        class="update-badge"
        class:mobile
        onclick={() => onupdate?.()}
        title="{update!.behind} {update!.behind === 1
          ? m.updatemodal_commits_one()
          : m.updatemodal_commits_other()}"
      >
        <span class="up-dot">▲</span>
        {#if !mobile && !compactBadges}<span class="up-label">{m.topbar_update_badge()}</span>{/if}
        <span class="up-n">{update!.behind}</span>
      </button>
    {/if}
    <!-- Desktop keeps the inline HERDR badge; on a phone it folds into the gear
         (blue dot below) to free a slot in the single-row control cluster. The
         touch-desktop badge crunch drops the label to a bare ▲ (aria-label keeps
         it named) so two stacked update badges still fit. -->
    {#if herdrUpdateAvailable && !mobile}
      <button
        class="update-badge herdr"
        onclick={() => onherdrupdate?.()}
        aria-label={m.topbar_herdr_update_badge()}
        title={m.topbar_herdr_update_title({
          current: herdrUpdate!.current ?? "?",
          latest: herdrUpdate!.latest ?? "?",
        })}
      >
        <span class="up-dot">▲</span>
        {#if !compactBadges}<span class="up-label">{m.topbar_herdr_update_badge()}</span>{/if}
      </button>
    {/if}
    {#if whatsNew}
      <!-- Desktop: labelled button with hover-tip; Mobile (and the touch-desktop
           multi-badge crunch) collapse to dot-only to avoid crowding the
           single-row control cluster (mirrors .gear-dot pattern). -->
      {#if !mobile && !compactBadges}
        <button
          class="whatsnew-badge tip"
          type="button"
          onclick={() => onwhatsnew?.()}
          data-tip={m.whatsnew_open()}
          aria-label={m.whatsnew_topbar_aria()}
        >
          <span class="wn-dot" aria-hidden="true">●</span>
          <span class="wn-label">{m.whatsnew_open()}</span>
        </button>
      {:else}
        <button
          class="whatsnew-dot-btn"
          type="button"
          onclick={() => onwhatsnew?.()}
          aria-label={m.whatsnew_topbar_aria()}
          ><span class="wn-pip" aria-hidden="true"></span></button
        >
      {/if}
    {/if}
    <!-- Health pip: visible ONLY when diagnosticsOverall !== "ok".
         Own slot left of the gear-wrap so it never overlaps the halt-pip (gear top-right)
         or the herdr blue gear-dot. Color: slate ring with state-colored core —
         amber for warning, red for error — distinct from both the halt-pip identity
         and the herdr blue. Token choice: --color-amber / --color-red for the core,
         --color-line-bright for the ring. Never --color-green (hidden when ok anyway). -->
    {#if diagnosticsOverall !== "ok"}
      <button
        class="health-pip tip"
        class:alert={diagnosticsOverall === "error"}
        type="button"
        onclick={() => ondiagnose?.()}
        data-tip={m.diagnostics_pip_label()}
        aria-label={m.diagnostics_pip_label()}
        use:coachTarget={"diagnostics"}
      >
        <span class="health-dot" aria-hidden="true"></span>
      </button>
    {/if}
    <!-- The gear adapts to state: idle herd → a click opens Settings directly;
         when something is haltable it becomes a menu button opening the e-stop above
         the Settings entry. A pip on the gear is the only at-rest cue that there's a
         herd to halt: amber while agents simply work (matches the working colour),
         escalating to red only when something is blocked — so red keeps meaning
         "needs you", consistent with the rest of the bar. The blue herdr-update dot
         (mobile) shifts to the opposite corner when both want the gear. -->
    <div class="gear-wrap" bind:this={gearWrap}>
      <button
        bind:this={gearBtn}
        class="gear tip"
        type="button"
        onclick={clickGear}
        data-tip={gearOpensMenu ? m.topbar_menu_aria() : m.settings_title()}
        aria-haspopup={gearOpensMenu ? "menu" : undefined}
        aria-expanded={gearOpensMenu ? menuOpen : undefined}
        aria-label={gearOpensMenu ? m.topbar_menu_aria() : m.topbar_settings_aria()}
        >⚙{#if haltable > 0}<span class="halt-pip" class:alert={blocked > 0} aria-hidden="true"
          ></span>{/if}{#if herdrUpdateAvailable && mobile}<span
            class="gear-dot"
            class:shift={haltable > 0}
            aria-hidden="true"
          ></span>{/if}</button
      >
      {#if menuOpen}
        <div
          class="gear-menu"
          class:mobile
          role="menu"
          tabindex="-1"
          aria-label={m.topbar_menu_label()}
          bind:this={menuEl}
          onkeydown={onMenuKey}
        >
          {#if mobile}
            <!-- Quick appearance controls, surfaced directly (not buried in Settings):
                 dark/light theme + the high-contrast readability lift. Mirrors the
                 desktop ActionBar recipe, sized up for touch. -->
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
            <div class="menu-sep" role="separator"></div>
          {/if}
          {#if haltable > 0}
            <!-- e-stop row: first activation arms (red "Halt N?"), a second commits.
                 Full intent stays in the aria-label. -->
            <button
              class="menu-item halt-item"
              class:armed
              type="button"
              role="menuitem"
              onclick={clickHalt}
              aria-label={armed
                ? m.halt_arm_aria({ count: haltable })
                : m.halt_all_aria({ count: haltable })}
            >
              <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 2 H16 L22 8 V16 L16 22 H8 L2 16 V8 Z" fill="currentColor" />
              </svg>
              <span class="menu-label"
                >{armed
                  ? m.halt_arm({ count: haltable })
                  : m.halt_menu_item({ count: haltable })}</span
              >
            </button>
            <div class="menu-sep" role="separator"></div>
          {/if}
          <button class="menu-item" type="button" role="menuitem" onclick={chooseSettings}>
            <span class="menu-glyph" aria-hidden="true">⚙</span>
            <span class="menu-label">{m.settings_title()}</span>
          </button>
          {#if mobile}
            <!-- Mobile footer: a jump to Shepherd's home (the repo's README + docs) and the
                 running build version. Desktop surfaces these in the ActionBar footer +
                 Settings → About instead, so they're folded into the gear menu only here. -->
            <div class="menu-sep" role="separator"></div>
            <a
              class="menu-item"
              href={REPO_URL}
              target="_blank"
              rel="external noreferrer noopener"
              role="menuitem"
              onclick={() => closeMenu()}
            >
              <span class="menu-glyph" aria-hidden="true">↗</span>
              <span class="menu-label">{m.topbar_menu_docs()}</span>
            </a>
            <div class="menu-foot micro">v{version}</div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- Blur backdrop behind the opened mobile menu, so the panel reads as the focus and the
     herd recedes. Decorative only — the window-level outside-click handler closes the menu.
     Rendered outside .gear-wrap so that outside-click detection still fires on it. -->
{#if menuOpen && mobile}
  <div class="menu-scrim scrim" aria-hidden="true"></div>
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
  .tallies {
    display: flex;
    /* was 18px between static divs: the tally buttons now carry 4px side padding
       each, so 10px gap keeps the content-to-content rhythm (4+10+4) and the bar's
       intrinsic width ~stable — the measured desktop compaction threshold
       (hudEl.scrollWidth) must not drift */
    gap: 10px;
    align-items: center;
  }
  .tally {
    display: flex;
    gap: 7px;
    align-items: center;
    background: none;
    border: 1px solid transparent;
    padding: 2px 4px;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .tally:not(:disabled):hover {
    background: var(--color-inset);
  }
  /* the disabled total (no active filter → clearing is a no-op) keeps its full
     tally appearance, just without the click affordance */
  .tally:disabled,
  .ctally:disabled {
    cursor: default;
  }
  .tally.active {
    background: var(--color-inset);
    border-color: var(--color-line-bright);
  }
  .tally .n {
    color: var(--color-ink-bright);
    font-weight: 500;
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
  /* Gear menu: a small popup hung below-right of the gear, holding the e-stop (when
     working) above the Settings entry. Quiet panel chrome matching the gauge popover. */
  .gear-wrap {
    position: relative;
    display: inline-flex;
  }
  .gear-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    min-width: 184px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 5px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  }
  /* Mobile: the menu is a real control panel (quick theme/contrast + halt + Settings),
     so it sits flush against the screen's right edge and reads larger and more evenly
     spaced. The -8px pulls its right edge out past the bar's 16px content gutter to an
     8px screen margin; min-width + roomier padding give it deliberate presence. */
  .gear-menu.mobile {
    right: -8px;
    min-width: 240px;
    gap: 4px;
    padding: 8px;
    border-radius: 4px;
  }
  .gear-menu.mobile .menu-item {
    padding: 12px;
    font-size: var(--fs-lg);
    gap: 12px;
  }
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
  /* Sits below the menu (z 30) but above app content, so the herd blurs while the
     panel stays crisp. Uses the canonical .scrim primitive (dim + blur) from app.css. */
  .menu-scrim {
    z-index: 25;
  }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    padding: 8px 10px;
    cursor: pointer;
    white-space: nowrap;
  }
  .menu-item:hover,
  .menu-item:focus-visible {
    background: color-mix(in srgb, var(--color-line-bright) 40%, transparent);
    outline: none;
  }
  .menu-icon {
    width: var(--fs-lg);
    height: var(--fs-lg);
    display: block;
    flex-shrink: 0;
  }
  .menu-glyph {
    width: var(--fs-lg);
    text-align: center;
    flex-shrink: 0;
  }
  .menu-label {
    font-variant-numeric: tabular-nums;
  }
  /* e-stop row: muted by default, goes loud (red) only on hover/focus and once armed —
     so a rarely-pressed control never dominates the menu. */
  .halt-item {
    color: var(--color-muted);
  }
  .halt-item:hover,
  .halt-item:focus-visible {
    background: color-mix(in srgb, var(--color-red) 14%, transparent);
    color: var(--color-red);
  }
  .halt-item.armed {
    background: color-mix(in srgb, var(--color-red) 22%, transparent);
    border-color: var(--color-red);
    color: var(--color-red);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: var(--fs-meta);
  }
  /* Keep the octagon glyph at full size even when arming drops the row font-size. */
  .halt-item.armed .menu-icon {
    width: var(--fs-lg);
    height: var(--fs-lg);
  }
  .menu-sep {
    height: 1px;
    margin: 3px 2px;
    background: var(--color-line);
  }
  /* Build-version footer under the mobile menu's docs link — a quiet, non-interactive
     line, so it stays understated next to the tappable rows above it. */
  .menu-foot {
    padding: 6px 12px 2px;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  /* Pip on the gear: the only at-rest cue that there's a herd to halt. Amber while
     agents merely work; red (.alert) only when something is blocked, so red stays
     reserved for "needs you" rather than the normal running state. */
  .halt-pip {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-amber);
    box-shadow: 0 0 0 2px var(--color-panel);
  }
  .halt-pip.alert {
    background: var(--color-red);
  }
  .rightside {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .gear {
    position: relative;
    background: transparent;
    border: none;
    color: var(--color-muted);
    font-size: var(--fs-xl);
    line-height: 1;
    padding: 5px 8px;
    cursor: pointer;
  }
  .gear:hover {
    color: var(--color-amber);
  }
  /* phone-only: the folded HERDR-update cue — a blue pip on the gear that mirrors
     the calm informational blue of the desktop badge and rings against the panel
     to stay legible */
  .gear-dot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-blue);
    box-shadow: 0 0 0 2px var(--color-panel);
  }
  /* When the red halt pip owns the top-right corner, the blue herdr dot drops to the
     bottom-right so the two cues never overlap. */
  .gear-dot.shift {
    top: auto;
    bottom: 3px;
  }
  /* Health pip: a standalone button placed left of the gear-wrap in .rightside.
     Visible only when diagnosticsOverall !== "ok" (hidden-when-OK via {#if}).
     Ring: --color-line-bright (neutral slate) — a quiet outline that doesn't
     read as the halt-pip or the herdr dot.
     Core: --color-amber (warning) or --color-red (error, .alert). */
  .health-pip {
    position: relative;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 50%;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    padding: 0;
  }
  .health-pip:hover {
    border-color: var(--color-muted);
  }
  .health-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--color-amber);
    display: block;
  }
  .health-pip.alert .health-dot {
    background: var(--color-red);
  }
  /* What's New affordance — blue informational accent (shared with the herdr cue),
     distinct from amber (app-update). */
  .whatsnew-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    background: color-mix(in srgb, var(--color-blue) 14%, transparent);
    border: 1px solid var(--color-blue);
    color: var(--color-blue);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    border-radius: 2px;
  }
  .whatsnew-badge:hover {
    background: color-mix(in srgb, var(--color-blue) 22%, transparent);
  }
  .whatsnew-badge .wn-dot {
    font-size: var(--fs-micro);
  }
  /* Phone-only: bare pip button, no label — mirrors .gear-dot folded pattern. */
  .whatsnew-dot-btn {
    position: relative;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 5px 8px;
    border-radius: 2px;
    cursor: pointer;
    min-height: 44px;
    min-width: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .wn-pip {
    display: block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--color-blue);
    box-shadow: 0 0 0 2px var(--color-panel);
  }
  .gauges-wrap {
    position: relative;
  }
  /* api-key mode: explicit fail-closed note in place of the usage meters. */
  .usage-sub-only {
    color: var(--color-muted);
    max-width: 22rem;
  }
  .gauges {
    display: flex;
    gap: 14px;
    align-items: center;
  }
  .gauges.stale {
    opacity: 0.5;
  }
  .gauge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-variant-numeric: tabular-nums;
  }
  .g-label {
    color: var(--color-muted);
  }
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
  /* CR credit gauge: reuses the .gauge recipe. The amount text is wider than a
     percentage, so it gets a larger min-width and rides on the same tabular nums. */
  .credit-gauge.alert .g-label {
    color: var(--color-amber);
  }
  .credit-gauge.stale {
    opacity: 0.5;
  }
  .credit-amount {
    min-width: max-content;
    white-space: nowrap;
  }
  /* CR collapsed touch button + popover detail when extra credits are being spent. */
  .gauge-btn.alert {
    border-color: var(--color-amber);
  }
  .credit-detail {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .credit-detail.stale {
    opacity: 0.5;
  }
  .credit-sub {
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-ink);
  }
  .credit-stale {
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-amber);
  }
  .credit-error {
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-red);
  }
  .credit-refresh {
    align-self: flex-start;
    margin-top: 2px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    text-transform: none;
    letter-spacing: 0.04em;
    padding: 4px 9px;
    cursor: pointer;
  }
  .credit-refresh:hover:not(:disabled) {
    background: var(--color-inset);
  }
  .credit-refresh:disabled {
    cursor: default;
    opacity: 0.5;
  }
  /* Touch: a single collapsed gauge rendered as a tappable button. */
  .gauge-wrap {
    position: relative;
  }
  .gauge-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    font: inherit;
    /* finger-sized tap target, matching the gear on touch HUDs */
    min-height: 40px;
    padding: 0 8px;
  }
  .gauge-btn:hover,
  .gauge-btn[aria-expanded="true"] {
    border-color: var(--color-line-bright);
  }
  .gauge-btn.stale {
    opacity: 0.5;
  }
  /* Popover: full breakdown of every window, anchored under the gauge. */
  .gauge-pop {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 50;
    min-width: 200px;
    max-width: min(280px, 85vw);
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
    padding: 10px 11px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .gauge-pop.stale {
    opacity: 0.5;
  }
  .gauge-pop-title {
    margin-bottom: 6px;
  }
  .gauge-pop-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-variant-numeric: tabular-nums;
  }
  .gauge-pop-row .g-bar-wide {
    flex: 1;
    width: auto;
    height: 6px;
  }
  .gauge-pop-row .g-pct {
    min-width: 34px;
  }
  .gauge-pop-reset {
    margin: 0 0 6px 30px;
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-faint);
  }
  .gauge-pop-reset:last-child {
    margin-bottom: 0;
  }
  /* Desktop hover detail card: one block per window — period name + percentage
     on a header row, a full-width bar below, reset time as a faint subline. */
  .gauge-pop-desk {
    gap: 0;
  }
  .gp-window {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .gp-window + .gp-window {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--color-line);
  }
  .gp-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    font-variant-numeric: tabular-nums;
  }
  .gp-period {
    color: var(--color-text);
    font-size: var(--fs-meta);
    text-transform: capitalize;
  }
  .gauge-pop-desk .g-bar-wide {
    width: 100%;
    height: 6px;
  }
  .gauge-pop-desk .gauge-pop-reset {
    margin: 0;
  }
  .update-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    background: color-mix(in srgb, var(--color-amber) 14%, transparent);
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    border-radius: 2px;
    animation: update-pulse 2.4s ease-in-out infinite;
  }
  .update-badge .up-dot {
    font-size: var(--fs-micro);
  }
  .update-badge .up-n {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }
  .update-badge.mobile {
    padding: 4px 8px;
    gap: 4px;
    letter-spacing: 0.08em;
  }
  /* herdr badge: informational (operator updates manually), so it reads as calm
     blue — the informational accent — and doesn't pulse like the actionable
     self-update badge */
  .update-badge.herdr {
    background: color-mix(in srgb, var(--color-blue) 14%, transparent);
    border-color: var(--color-blue);
    color: var(--color-blue);
    animation: none;
  }
  @keyframes update-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-amber) 40%, transparent);
    }
    50% {
      box-shadow: 0 0 0 4px transparent;
    }
  }
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
  .tallies.compact {
    display: flex;
    align-items: center;
    /* button side padding (5px) now provides the separation the old 4px gap gave */
    gap: 0;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .ctally {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    background: none;
    border: 1px solid transparent;
    padding: 0 5px;
    font: inherit;
    color: inherit;
    cursor: pointer;
    /* 44px touch floor in HEIGHT only (matches .hud.mobile .gear/.needsyou); a
       44px width floor for four buttons would blow the ~260px usable line-1
       budget on fold-cover phones. 24px min width keeps even the bare-digit
       Idle segment at the WCAG 2.5.8 (AA) target size. */
    min-height: 44px;
    min-inline-size: 24px;
  }
  .ctally.active {
    background: var(--color-inset);
    border-color: var(--color-line-bright);
  }
  .tallies.compact .cdot {
    font-size: var(--fs-micro);
  }
  .tallies.compact .csep {
    color: var(--color-faint);
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
  /* finger-sized tap targets on touch HUDs (≥44px) — the desktop sizes are
     tuned for a cursor and are too small to hit reliably on a phone. These
     phone-layout rules (.hud.mobile …) outrank the @media (pointer: coarse)
     block below on specificity, so the 44px floor must live here too. */
  .hud.mobile .gear {
    min-height: 44px;
    min-width: 44px;
    padding: 5px 11px;
    font-size: var(--fs-xl);
  }
  .hud.mobile .gauge-btn {
    padding: 0 6px;
    gap: 5px;
  }
  .hud.mobile .gauge-btn .g-bar {
    width: 28px;
  }
  /* Phone: collapse the gauge to a bare colour bar — drop both the numeric
     percentage and the period label. The bar fill + colour carry the level at a
     glance and the tap popover still shows the labelled windows with exact
     numbers — so the control row holds one line down to ~360px phones. */
  .hud.mobile .gauge-btn .g-pct,
  .hud.mobile .gauge-btn .g-label {
    display: none;
  }
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
  .hud.mobile .update-badge {
    min-height: 44px;
  }

  /* Coarse pointers (touch, any layout width): the secondary icon buttons are
     tuned tight for a cursor on desktop. Give them a ≥44px hit area on touch
     without enlarging glyphs — padding/min-size only. Applies regardless of the
     mobile-width class so coarse-pointer tablets/foldables in desktop layout
     also clear the 44px guideline. Desktop (pointer: fine) sizing is untouched. */
  @media (pointer: coarse) {
    .gear,
    .needsyou,
    .needsyou.compact,
    .gauge-btn,
    .update-badge {
      min-height: 44px;
      min-width: 44px;
    }
    /* Menu rows get the same ≥44px touch floor without enlarging the desktop layout. */
    .menu-item {
      min-height: 44px;
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
