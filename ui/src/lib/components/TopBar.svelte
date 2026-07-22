<script lang="ts">
  import type {
    Session,
    UsageLimits,
    UpdateStatus,
    HerdrUpdateStatus,
    CodexUpdateStatus,
    DiagnosticState,
  } from "$lib/types";
  import { displayStatus } from "$lib/display-status";
  import {
    compactUsageViews as compactUsageViewList,
    codexTokenUsage,
    gaugeList,
    hotterGauge,
    modelWeekList,
    overspending,
    type CompactUsageView,
    type GaugeKey,
  } from "./usage-gauges";
  import {
    refreshUsage,
    listHeld,
    spawnHeld,
    discardHeld,
    getSettings,
    putUsageHoldAutoRelease,
  } from "$lib/api";
  import type { AgentProvider, HeldTask } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { openFeedback } from "$lib/feedback-dialog.svelte";
  import type { FeedbackKind } from "$lib/feedback-link";
  import { modeOf, badgeCount } from "./top-bar-layout";
  import { isSettingsChord } from "./herd-keynav";
  import TopBarTallies from "./top-bar/TopBarTallies.svelte";
  import TopBarHeldBadge from "./top-bar/TopBarHeldBadge.svelte";
  import TopBarUsage from "./top-bar/TopBarUsage.svelte";
  import TopBarBadges from "./top-bar/TopBarBadges.svelte";
  import TopBarSearch from "./top-bar/TopBarSearch.svelte";
  import TopBarGear from "./top-bar/TopBarGear.svelte";
  import TopBarMobileSheet from "./top-bar/TopBarMobileSheet.svelte";

  type TallyStatus = "running" | "idle" | "blocked";

  let {
    sessions,
    nowMs,
    connected = false,
    mobile = false,
    touch = false,
    limits = null,
    onsettings,
    onusage,
    onhalt,
    update = null,
    onupdate,
    herdrUpdate = null,
    onherdrupdate,
    codexUpdate = null,
    oncodexupdate,
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
    onedithheld,
    pluginItems = [],
    onpluginitem,
    oncommandbar,
    onmanageplugins,
    settingsChordAllowed = () => true,
  }: {
    sessions: Session[];
    nowMs: number;
    connected?: boolean;
    mobile?: boolean;
    touch?: boolean;
    limits?: UsageLimits | null;
    onsettings?: () => void;
    onusage?: () => void;
    onhalt?: () => void;
    update?: UpdateStatus | null;
    onupdate?: () => void;
    herdrUpdate?: HerdrUpdateStatus | null;
    onherdrupdate?: () => void;
    codexUpdate?: CodexUpdateStatus | null;
    oncodexupdate?: () => void;
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
    /** Edit a held task: page opens the New Task composer pre-filled from its input. */
    onedithheld?: (task: HeldTask) => void;
    /** Plugin-contributed gear-menu items (verbatim plugin data). */
    pluginItems?: { id: string; label: string; icon?: string; hint?: string }[];
    /** Called when a plugin item is selected from the gear menu. */
    onpluginitem?: (id: string) => void;
    /** Opens the command bar (search-pill click). */
    oncommandbar?: () => void;
    /** Opens Settings → Plugins (the gear menu's "manage" affordance). */
    onmanageplugins?: () => void;
    /** Page-level gate for the Cmd/Ctrl+, chord (e.g. "no overlay open"). */
    settingsChordAllowed?: () => boolean;
  } = $props();

  // tally click: toggle — clicking the active status clears the filter
  const clickStatus = (s: TallyStatus) => onstatusfilter?.(statusFilter === s ? null : s);

  const updateAvailable = $derived(!!update && update.behind > 0);
  // The herdr badge opens the update modal. Show it for a real upgrade OR the two-path sandboxed-
  // idle advisory (#1716) — that's the surface the operator reaches the opt-out downgrade through,
  // even on a supported herdr with no upgrade pending.
  const herdrUpdateAvailable = $derived(
    !!herdrUpdate && (herdrUpdate.updateAvailable || !!herdrUpdate.sandboxIdleRegressed),
  );
  const codexUpdateAvailable = $derived(!!codexUpdate && codexUpdate.updateAvailable);
  // Tallies are DISPLAY: a working-while-blocked session counts as working, not
  // blocked (displayStatus upgrades it). The halt e-stop instead reads the RAW
  // status (`haltable` below): the server's haltAll only reaches agents herdr
  // itself reports working, which the latched-"blocked" session is not.
  const working = $derived(
    sessions.filter((s) => displayStatus(s, workingBlocked) === "running").length,
  );
  const haltable = $derived(sessions.filter((s) => s.status === "running").length);
  // "touch-desktop" = a coarse-pointer device wider than 768px (an unfolded foldable, a
  // tablet) — a VARIABLE-width class, not the fixed ~1000px the old #247/#322 count rule
  // assumed. Right-cluster compaction is therefore measurement-driven for it too, sharing
  // desktop's path below (only `mobile`, which WRAPS, stays out of measurement). The halt
  // e-stop is NOT a bar badge — it folds into the always-present gear menu.
  const mode = $derived(modeOf(mobile, touch));
  const learningsPresent = $derived(learnings > 0 || learningsCurate > 0);
  // Badge shows proposed count when any proposed, else the curate count
  const learningsCount = $derived(learnings > 0 ? learnings : learningsCurate);
  const learningsLabel = $derived(learnings > 0 ? m.learnings_title() : m.learnings_trim_title());
  const chrome = $derived({
    updateAvailable,
    herdrUpdateAvailable,
    codexUpdateAvailable,
    whatsNew,
    // held arrives async via the held:changed WS event; counting it here makes the
    // measure effect's `void badgeCount(chrome)` read re-fire on its arrival.
    held: heldCount,
  });

  // ── Compaction is MEASURED, not count-based (desktop AND touch-desktop) ───────
  // WIDTH varies on both: a ~1366px laptop gives the bar ~1322px usable where even two
  // full-label badges (~1354px) overflow; an unfolded foldable can be ~800px where a lone
  // full-label badge overflows, while a coarse-pointer tablet at ~1366px has ample room.
  // A fixed badge count can't catch either, so for every non-mobile mode we compact only
  // when the bar would ACTUALLY overflow its container, measured at runtime. (Mobile
  // WRAPS to a second row instead — handled by the `mobile` flag, never measured.)
  let hudEl = $state<HTMLElement | null>(null);
  let measuredCompact = $state(false);
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
    measuredCompact = false; // render full so scrollWidth is the full-label width
    requestAnimationFrame(() => {
      measureScheduled = false;
      if (!hudEl || mode === "mobile") {
        measuredCompact = false;
        fullWidth = 0;
        return;
      }
      fullWidth = hudEl.scrollWidth;
      // 1px slack absorbs sub-pixel layout rounding, so a flush-fitting full-label bar
      // (scrollWidth a hair over clientWidth) isn't needlessly compacted.
      measuredCompact = fullWidth > hudEl.clientWidth + 1;
    });
  }

  // Resize path: decide compaction from the CACHED full width vs the current
  // clientWidth — NO reset-to-full, so a continuous window drag doesn't flash
  // full→compact every frame. If the cache is stale (0), fall back to a one-shot
  // full measurement.
  function decideFromCache() {
    if (mode === "mobile" || !hudEl) {
      measuredCompact = false;
      fullWidth = 0; // mobile: clear so re-entry re-measures fresh (matches content effect)
      return;
    }
    if (fullWidth > 0) measuredCompact = fullWidth > hudEl.clientWidth + 1;
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
    // Compact provider rotation changes top-bar content without changing `gauges.length`.
    // Remeasure when the provider set/rotation state changes, and when the active view moves
    // between width classes (e.g. two bars ↔ token total), but not for same-width provider ticks.
    void compactUsageSetSignature;
    void activeCompactUsageWidthClass;
    if (mode === "mobile") {
      measuredCompact = false;
      fullWidth = 0; // mobile: clear the cache so re-entry re-measures fresh
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

  // The measured overflow result drives the flags the markup keys off, for every
  // non-mobile mode (desktop + touch-desktop). The single signal COUPLES them: on a
  // measured overflow the labels AND tallies collapse to icons together — there is
  // intentionally no labels-collapsed-but-tallies-full intermediate (this is the
  // deliberate loss of #322's two-step ladder, kept consistent with desktop). Mobile uses
  // its own wrapping layout (the `mobile` flag), never these.
  const compactBadges = $derived(mode !== "mobile" && measuredCompact);

  const idle = $derived(sessions.filter((s) => displayStatus(s, workingBlocked) === "idle").length);
  const blocked = $derived(
    sessions.filter((s) => displayStatus(s, workingBlocked) === "blocked").length,
  );
  const connText = $derived(
    connected ? m.topbar_conn_tip_connected() : m.topbar_conn_tip_disconnected(),
  );

  // Three-step ladder (usage-gauges.ts): muted at rest, amber 75–90 (warming),
  // red >90 (approaching cap). Red is a documented Four-Light exception — gauge
  // bar-fill/text only (no halo/pip), so blocked pip stays the loudest red on screen.

  const periodLabel = (k: GaugeKey) =>
    k === "5H" ? m.topbar_gauge_period_5h() : m.topbar_gauge_period_weekly();

  // Desktop (fine pointer) shows both windows with hover tooltips. Touch has no
  // hover, so it collapses to the window closest to its cap and exposes the full
  // breakdown — including reset times — through a tap popover instead.
  const gauges = $derived(gaugeList(limits));
  const hotter = $derived(hotterGauge(limits));
  // Per-model weekly passthrough sub-limits (e.g. Fable) — their own bars, never in gaugeList/hotter.
  const perModel = $derived(modelWeekList(limits));
  // api-key auth mode: subscription usage windows carry no data. Fail closed —
  // render an explicit note instead of empty/zero meters.
  const subscriptionOnly = $derived(limits?.subscriptionOnly === true);

  // Paid extra-credit overage. Rendered as a distinct CR element (NOT a gaugeList
  // entry — its window shape carries no credit fields, and a 0%-pct credit gauge
  // must never become the "hotter" collapsed gauge). Null → render nothing.
  const credits = $derived(limits?.credits ?? null);
  const codexUsage = $derived(codexTokenUsage(limits));
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
  // badge). The usage gauges now go red >90 (see gaugeColor); amber is their warming
  // tier above 50. pct is 0 here so gaugeColor(pct) can't drive it — overspend keys
  // off real spend instead. Stale → muted; idle → neutral.
  const creditColor = $derived(
    credits?.stale ? "var(--color-muted)" : overspend ? "var(--color-amber)" : "var(--color-muted)",
  );
  function compactUsageLayoutKey(view: CompactUsageView): string {
    const base = `${view.provider}:${view.mode}:${view.widthClass}`;
    if (view.mode === "limits") {
      return `${base}:${view.gauges.map((g) => g.label).join(",")}`;
    }
    if (view.mode === "model") return `${base}:${view.model.model}`;
    return base;
  }
  const compactUsageViews = $derived(
    compactUsageViewList({
      gauges,
      claudeStale: limits?.stale ?? false,
      perModel,
      credits,
      codexUsage,
    }),
  );
  const rotatingCompactUsageViews = $derived(
    compactUsageViews.filter((view) => view.rotationEligible),
  );
  const rotatingCompactUsageCount = $derived(rotatingCompactUsageViews.length);
  const compactUsageRotating = $derived(rotatingCompactUsageCount >= 2);
  const compactUsageSetSignature = $derived(
    `${compactUsageRotating ? "rot" : "single"}:${compactUsageViews
      .map(compactUsageLayoutKey)
      .join("|")}`,
  );
  let activeCompactUsageIndex = $state(0);
  const activeCompactUsageView = $derived(
    compactUsageRotating
      ? (rotatingCompactUsageViews[activeCompactUsageIndex % rotatingCompactUsageViews.length] ??
          null)
      : (compactUsageViews[0] ?? null),
  );
  const activeCompactUsageWidthClass = $derived(activeCompactUsageView?.widthClass ?? "none");

  $effect(() => {
    const signature = compactUsageSetSignature;
    const count = rotatingCompactUsageCount;
    void signature;
    activeCompactUsageIndex = 0;
    if (count < 2) return;
    const rotate = setInterval(() => {
      activeCompactUsageIndex = (activeCompactUsageIndex + 1) % count;
    }, 120_000);
    return () => clearInterval(rotate);
  });

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

  // Click-toggled usage breakdown popover, shared by desktop (fine pointer) and touch. Opens on
  // click of the inline gauges cluster; dismissed on Esc / outside-click (handlers below) so the
  // REFRESH control inside it stays reachable. `gaugeWrap` anchors the outside-click test.
  let popoverOpen = $state(false);
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
  // Auto-start toggle: when on, the server's 30s sweeper releases held tasks once usage drops
  // below the threshold; when off, they stay queued until started/discarded manually. Loaded
  // from settings when the popover opens so it reflects out-of-band changes (settings API / env
  // override) rather than a possibly-stale value.
  let heldAutoRelease = $state(true);
  let heldAutoReleaseBusy = $state(false);

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

  async function loadHeldAutoRelease() {
    try {
      heldAutoRelease = (await getSettings()).usageHoldAutoRelease;
    } catch {
      // best-effort; leave the last known value
    }
  }

  async function toggleHeldAutoRelease() {
    if (heldAutoReleaseBusy) return;
    heldAutoReleaseBusy = true;
    const next = !heldAutoRelease;
    heldAutoRelease = next; // optimistic
    try {
      const r = await putUsageHoldAutoRelease(next);
      heldAutoRelease = r.usageHoldAutoRelease;
    } catch {
      heldAutoRelease = !next; // revert on failure
    } finally {
      heldAutoReleaseBusy = false;
    }
  }

  function openHeldPop() {
    heldPopOpen = true;
    loadHeld();
    loadHeldAutoRelease();
  }

  function closeHeldPop(returnFocus = false) {
    heldPopOpen = false;
    if (returnFocus) heldBadgeBtn?.focus();
  }

  function toggleHeldPop() {
    if (heldPopOpen) closeHeldPop();
    else openHeldPop();
  }

  // Per-task action error, shown inline in the held popover. A spawn/discard can be
  // refused server-side (sandbox block, name collision, herdr failure, already gone)
  // and the task stays in the list — without feedback the button reads as dead. A
  // toast won't do: the mobile popover is a fullscreen portal at the same z-index as
  // the toast stack, so a bottom toast renders behind it. Inline feedback lives inside
  // the surface and stays visible on both desktop and mobile.
  let heldErrors = $state<Record<string, { kind: "spawn" | "discard"; detail?: string }>>({});

  // Carry the server's real `{error}` cause (agent-name-taken, worktree/create failure,
  // sandbox refusal, …) so the popover can show *why* it failed, not just "try again".
  function heldErrorDetail(e: unknown): string | undefined {
    const msg = e instanceof Error ? e.message.trim() : "";
    return msg ? msg : undefined;
  }

  // In-flight per-task action. A spawn runs server-side worktree creation + agent launch
  // (seconds), so without a pending affordance the button looks inert the whole time and
  // reads as dead — the same "button does nothing" failure #1105 fixed for errors. Track
  // it to disable the row's controls and show a "starting…" label while the request runs.
  let heldPending = $state<Record<string, "spawn" | "discard">>({});

  async function doSpawnHeld(id: string, agentProvider?: AgentProvider) {
    if (heldPending[id]) return;
    delete heldErrors[id];
    heldPending[id] = "spawn";
    try {
      await spawnHeld(id, agentProvider);
      await loadHeld();
    } catch (e) {
      heldErrors[id] = { kind: "spawn", detail: heldErrorDetail(e) };
    } finally {
      delete heldPending[id];
    }
  }

  // Edit a held task: close the popover (the composer is a separate modal that would
  // otherwise sit behind this anchored surface) and hand the task to the page opener.
  function doEditHeld(task: HeldTask) {
    closeHeldPop();
    onedithheld?.(task);
  }

  async function doDiscardHeld(id: string) {
    if (heldPending[id]) return;
    delete heldErrors[id];
    heldPending[id] = "discard";
    try {
      await discardHeld(id);
      await loadHeld();
    } catch (e) {
      heldErrors[id] = { kind: "discard", detail: heldErrorDetail(e) };
    } finally {
      delete heldPending[id];
    }
  }

  // Flip-up + height clamp for held popover — mirrors AutomationPanel's $effect.
  const MIN_HEIGHT_HELD = 120;
  const EDGE_GAP_HELD = 12;
  const ANCHOR_GAP_HELD = 4;
  $effect(() => {
    const el = heldPopEl;
    if (!el) return;
    if (mobile) {
      heldPopFlipUp = false;
      el.style.maxHeight = "";
      return;
    }
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
    // Close the popover when there's nothing left to show. Both desktop and touch drive
    // popoverOpen now, so the only force-close is "no usage windows AND no credits AND no
    // per-model bar" (a non-empty `gauges` implies `hotter`, so this also covers the touch
    // collapse case). Keep `perModel` here or a Fable-only snapshot would force-close its own popover.
    if (!gauges.length && !credits && !codexUsage && !perModel.length) popoverOpen = false;
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
  function onFeedback(kind: FeedbackKind) {
    closeMenu();
    openFeedback(kind);
  }
  // Mobile only: settings-owned diagnostics attention collapses into one dot on
  // the gear, because the Diagnose row lives inside the gear sheet on phones.
  // Herd/session state stays on the tallies and rows instead of duplicating here.
  type GearPipTier = "red" | "yellow" | null;
  const gearPipTier = $derived<GearPipTier>(
    !mobile
      ? null
      : diagnosticsOverall === "error"
        ? "red"
        : diagnosticsOverall === "warning"
          ? "yellow"
          : null,
  );
  // The gear ALWAYS toggles the menu (design handoff 3b/3c): the telemetry popover /
  // sheet now carries the identity header, usage gauge, docs and support rows, so it
  // is valid with an idle herd on every surface.
  function clickGear() {
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
  function chooseUsage() {
    menuOpen = false;
    disarmHalt();
    onusage?.();
  }
  function chooseLearnings() {
    closeMenu();
    onlearnings?.();
  }
  function choosePlugin(id: string) {
    menuOpen = false;
    disarmHalt();
    onpluginitem?.(id);
  }
  function chooseManagePlugins() {
    menuOpen = false;
    disarmHalt();
    onmanageplugins?.();
  }
  // On open, move focus to the first ENABLED row (the halt hero is natively disabled
  // at 0 working, so it is skipped by both this and the arrow roving below).
  const GEAR_ROW_SELECTOR = "[data-gear-row]:not(:disabled)";
  $effect(() => {
    if (menuOpen) menuEl?.querySelector<HTMLElement>(GEAR_ROW_SELECTOR)?.focus();
  });
  // ArrowUp/Down cycle between the enabled rows (roving enhancement — natural Tab
  // order also works, this is a non-modal dialog, not a menu); Escape closes and
  // returns focus to the gear.
  function onMenuKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menuEl?.querySelectorAll<HTMLElement>(GEAR_ROW_SELECTOR) ?? []);
    if (!items.length) return;
    const here = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown" ? (here + 1) % items.length : (here - 1 + items.length) % items.length;
    items[next]?.focus();
  }
  // If the herd goes quiet underneath the gear (agents finished), just drop any armed
  // e-stop state. The menu itself STAYS open on every surface — it now carries the
  // identity header, usage gauge, docs and support rows, so it is always valid; the
  // halt hero simply renders disabled with its chip hidden.
  $effect(() => {
    if (haltable === 0) disarmHalt();
  });
  // Destroy-only cleanup (no tracked reads → runs once): never leak the disarm timer.
  $effect(() => () => clearTimeout(armTimer));

  function dismissOnEscape(e: KeyboardEvent) {
    // Cmd/Ctrl+, opens Settings globally (desktop). Lives here — not +page's
    // onShortcut — because TopBar owns onsettings, giving the action an automated
    // browser-test seam. The guard prop carries +page's overlay gate; Viewport's
    // PTY handler suppresses the same chord so no byte leaks to the terminal.
    if (!mobile && isSettingsChord(e)) {
      if (settingsChordAllowed()) {
        e.preventDefault();
        chooseSettings();
      }
      return;
    }
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
    compact={compactBadges}
    total={sessions.length}
    {working}
    {idle}
    {blocked}
    {statusFilter}
    {onstatusfilter}
    {clickStatus}
  />
  <div class="rightside">
    <TopBarHeldBadge
      {heldCount}
      {mobile}
      {compactBadges}
      {hotter}
      {nowMs}
      {heldPopFlipUp}
      {heldItems}
      {heldLoading}
      {heldErrors}
      {heldPending}
      {heldAutoRelease}
      {heldAutoReleaseBusy}
      {toggleHeldAutoRelease}
      bind:heldPopOpen
      bind:heldBadgeBtn
      bind:heldPopEl
      {toggleHeldPop}
      {closeHeldPop}
      {doSpawnHeld}
      {doDiscardHeld}
      onEditHeld={doEditHeld}
    />
    {#if !mobile}
      <TopBarUsage
        {subscriptionOnly}
        {touch}
        stale={limits?.stale ?? false}
        {gauges}
        {perModel}
        {credits}
        {codexUsage}
        {activeCompactUsageView}
        {compactUsageRotating}
        {overspend}
        {creditFill}
        {creditColor}
        {creditAmount}
        {nowMs}
        {refreshing}
        {refreshError}
        onRefresh={doRefresh}
        {periodLabel}
        onusage={chooseUsage}
        bind:popoverOpen
        bind:gaugeWrap
      />
    {/if}
    <div class="conn tip" data-tip={connText} aria-label={connText}>
      <span class="dot" class:on={connected}>●</span>
    </div>
    {#if !mobile}<TopBarBadges
        {compactBadges}
        {updateAvailable}
        {update}
        {onupdate}
        {herdrUpdateAvailable}
        {herdrUpdate}
        {onherdrupdate}
        {codexUpdateAvailable}
        {codexUpdate}
        {oncodexupdate}
        {whatsNew}
        {onwhatsnew}
        {diagnosticsOverall}
        {ondiagnose}
      />{/if}
    {#if !mobile}
      <TopBarSearch compact={compactBadges} oncommandbar={() => oncommandbar?.()} />
    {/if}
    <!-- The gear always toggles the telemetry menu (popover on desktop, sheet on
         mobile). The gear's dot is settings-owned attention only: diagnostics have a
         standalone desktop pip, and fold into the gear on mobile because the Diagnose
         row lives in that sheet. -->
    <TopBarGear
      {mobile}
      {haltable}
      {gearPipTier}
      {armed}
      {connected}
      bind:menuOpen
      bind:gearWrap
      bind:gearBtn
      bind:menuEl
      {clickGear}
      {clickHalt}
      closeMenu={() => closeMenu()}
      {chooseSettings}
      {chooseUsage}
      {learningsPresent}
      {learnings}
      {learningsCurate}
      {learningsLabel}
      {learningsCount}
      {chooseLearnings}
      {onMenuKey}
      {onFeedback}
      {pluginItems}
      onPluginItem={choosePlugin}
      onManagePlugins={chooseManagePlugins}
      {limits}
      {nowMs}
      {creditFill}
      {creditColor}
      {creditAmount}
      {refreshing}
      {refreshError}
      onRefresh={doRefresh}
      {periodLabel}
    />
  </div>
</div>

{#if menuOpen && mobile}
  <TopBarMobileSheet
    {limits}
    {connected}
    {diagnosticsOverall}
    {updateAvailable}
    {update}
    {herdrUpdateAvailable}
    {codexUpdateAvailable}
    {whatsNew}
    {learningsPresent}
    {learnings}
    {learningsCurate}
    {learningsLabel}
    {learningsCount}
    {haltable}
    {armed}
    {nowMs}
    {creditFill}
    {creditColor}
    {creditAmount}
    {refreshing}
    {refreshError}
    onRefresh={doRefresh}
    {periodLabel}
    {closeMenu}
    {clickHalt}
    {chooseSettings}
    {chooseUsage}
    {ondiagnose}
    {onupdate}
    {onherdrupdate}
    {oncodexupdate}
    {onwhatsnew}
    {onlearnings}
    {onFeedback}
    {pluginItems}
    onPluginItem={choosePlugin}
    onManagePlugins={chooseManagePlugins}
  />
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
  /* learnings-btn, learn-glyph, learn-n, gear-wrap, gear-menu moved to top-bar/TopBarBadges.svelte / TopBarGear.svelte (#855) */
  /* quick, theme-seg, t-opt, contrast-toggle, gear-sheet-portal, menu-scrim, gear-sheet, sheet-* moved to top-bar/TopBarMobileSheet.svelte (#855) */
  /* menu-item, menu-icon, menu-glyph, menu-label, halt-item, menu-sep moved to top-bar/TopBarGear.svelte (#855) */
  .rightside {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  /* gear, gear-pip, health-pip, health-dot moved to top-bar/TopBarGear.svelte / TopBarBadges.svelte (#855) */
  /* whatsnew-badge, whatsnew-dot-btn, wn-pip, health-pip, health-dot, update-badge, learnings-btn moved to top-bar/TopBarBadges.svelte (#855) */
  /* usage-sub-only, gauges-wrap, gauges, gauge, g-label, gauge-wrap, gauge-btn, gauge-pop,
     gauge-pop-desk, gp-window, gp-head, credit-amount moved to top-bar/TopBarUsage.svelte (#855) */
  /* g-bar, g-fill, g-pct, g-bar-wide, gauge-pop-reset, gp-period, sheet-gauge-row.g-bar-wide
     moved to top-bar/TopBarMobileSheet.svelte (#855) */
  /* credit-gauge.* rules moved to top-bar/CreditGauge.svelte (#855) */
  /* credit-detail.* rules moved to top-bar/CreditDetail.svelte (#855) */
  /* update-badge, up-dot, up-n, update-pulse moved to top-bar/TopBarBadges.svelte (#855) */
  .conn {
    color: var(--color-ink-bright);
    display: flex;
    align-items: center;
  }
  /* connection dot: informational, so it stays in the neutral ink ramp — bright
     when connected vs faint when dropped (brightness, not a status hue, carries
     the cue; the tooltip/aria text names the state). */
  .conn .dot {
    color: var(--color-faint);
  }
  .conn .dot.on {
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
  /* Mobile: let the bare connection dot ride inline at the head of the right-side
     cluster (order:-1) — vertically centred with the gauge/gear instead of floating
     off-centre in the corner. */
  .hud.mobile .conn {
    order: -1;
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
  /* Coarse-pointer 44px floor for the secondary icon buttons (.gear/.menu-item,
     .update-badge/.learnings-btn) moved to TopBarGear / TopBarBadges — the
     standalone docs link that owned the last rule here was removed (search field
     replaces it) and TopBarSearch carries its own coarse-pointer floor. */

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
