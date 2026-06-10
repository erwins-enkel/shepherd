<script lang="ts">
  import type { Session, UsageLimits, UpdateStatus, HerdrUpdateStatus } from "$lib/types";
  import { formatReset } from "$lib/format";
  import { displayStatus } from "$lib/display-status";
  import { gaugeList, hotterGauge, type GaugeKey } from "./usage-gauges";
  import { m } from "$lib/paraglide/messages";
  import { modeOf, topBarPlan, badgeCount } from "./top-bar-layout";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";

  type TallyStatus = "running" | "idle" | "blocked";

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
  let popoverOpen = $state(false);
  let gaugeWrap = $state<HTMLElement | null>(null);
  $effect(() => {
    // close the popover when it can no longer be opened (gauge gone / switched off touch)
    if (!touch || !hotter) popoverOpen = false;
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
  // Gear click: idle herd → open Settings directly; something haltable → open the menu.
  function clickGear() {
    if (haltable === 0) {
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
  // Drop the armed state if the herd goes quiet underneath it (agents finished), so a
  // later run doesn't surface a pre-armed row.
  $effect(() => {
    if (haltable === 0) disarmHalt();
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
    {#if touch}
      {#if hotter}
        <!-- touch: collapse to the hotter window; tap for the full breakdown -->
        <div class="gauge-wrap" bind:this={gaugeWrap}>
          <button
            class="gauge gauge-btn"
            class:stale={limits?.stale}
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
            </div>
          {/if}
        </div>
      {/if}
    {:else if gauges.length}
      <div class="gauges" class:stale={limits?.stale}>
        {#each gauges as g (g.label)}
          {@const tip = gaugeTip(g.label, g.w.pct, g.w.resetAt)}
          <div class="gauge tip" data-tip={tip} aria-label={tip}>
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
        data-tip={haltable > 0 ? m.topbar_menu_aria() : m.settings_title()}
        aria-haspopup={haltable > 0 ? "menu" : undefined}
        aria-expanded={haltable > 0 ? menuOpen : undefined}
        aria-label={haltable > 0 ? m.topbar_menu_aria() : m.topbar_settings_aria()}
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
          role="menu"
          tabindex="-1"
          aria-label={m.topbar_menu_label()}
          bind:this={menuEl}
          onkeydown={onMenuKey}
        >
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
        </div>
      {/if}
    </div>
  </div>
</div>

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
