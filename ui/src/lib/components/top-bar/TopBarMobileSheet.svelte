<script lang="ts">
  import type { GaugeKey } from "../usage-gauges";
  import type { UpdateStatus, DiagnosticState, UsageLimits } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { theme, type ThemePref } from "$lib/theme.svelte";
  import ThemeIcon from "$lib/components/ThemeIcon.svelte";
  import GearMenuUsage from "./GearMenuUsage.svelte";
  import { REPO_URL, DOCS_URL, version } from "$lib/build-info";
  import type { FeedbackKind } from "$lib/feedback-link";
  import { fly } from "svelte/transition";
  import { dialog } from "$lib/a11yDialog";
  import { portal } from "$lib/portal";

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

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  let {
    limits,
    connected,
    diagnosticsOverall,
    updateAvailable,
    update,
    herdrUpdateAvailable,
    codexUpdateAvailable,
    whatsNew,
    learningsPresent,
    learnings,
    learningsCurate,
    learningsLabel,
    learningsCount,
    haltable,
    armed,
    nowMs,
    creditFill,
    creditColor,
    creditAmount,
    refreshing,
    refreshError,
    onRefresh,
    periodLabel,
    closeMenu,
    clickHalt,
    chooseSettings,
    chooseUsage,
    ondiagnose,
    onupdate,
    onherdrupdate,
    oncodexupdate,
    onwhatsnew,
    onlearnings,
    onFeedback,
    pluginItems = [],
    onPluginItem,
    onManagePlugins,
  }: {
    limits: UsageLimits | null;
    connected: boolean;
    diagnosticsOverall: DiagnosticState;
    updateAvailable: boolean;
    update: UpdateStatus | null;
    herdrUpdateAvailable: boolean;
    codexUpdateAvailable: boolean;
    whatsNew: boolean;
    learningsPresent: boolean;
    learnings: number;
    learningsCurate: number;
    learningsLabel: string;
    learningsCount: number;
    haltable: number;
    armed: boolean;
    nowMs: number;
    creditFill: number;
    creditColor: string;
    creditAmount: string;
    refreshing: boolean;
    refreshError: boolean;
    onRefresh: () => void;
    periodLabel: (k: GaugeKey) => string;
    closeMenu: () => void;
    clickHalt: () => void;
    chooseSettings: () => void;
    chooseUsage: () => void;
    ondiagnose: (() => void) | undefined;
    onupdate: (() => void) | undefined;
    onherdrupdate: (() => void) | undefined;
    oncodexupdate: (() => void) | undefined;
    onwhatsnew: (() => void) | undefined;
    onlearnings: (() => void) | undefined;
    onFeedback: (kind: FeedbackKind) => void;
    pluginItems?: { id: string; label: string; icon?: string; hint?: string }[];
    onPluginItem?: (id: string) => void;
    onManagePlugins?: () => void;
  } = $props();

  // ── Swipe-down dismiss ─────────────────────────────────────────────────────
  // Armed ONLY by a pointerdown on the grab-handle row (touch-action:none there),
  // so sheet content scrolling never conflicts. setPointerCapture keeps a drag
  // that wanders off the handle tracking; other pointer ids are ignored. The drag
  // offset is the ONLY inline transform the sheet carries — inert until the fly
  // intro ends (Svelte drops the transition's inline transform at introend), and
  // the empty-string binding restores the stylesheet baseline after release.
  // Close iff dy > 64px at release (displacement-only — deterministic); shorter
  // drags and pointercancel/lostpointercapture settle back via the `settling`
  // transition class. One shared reset path covers up/cancel/lost-capture.
  const SWIPE_CLOSE_PX = 64;
  let dragPointer: number | null = null;
  let dragStartY = 0;
  let dragY = $state(0);
  let settling = $state(false);
  let introDone = $state(false);

  function onHandleDown(e: PointerEvent) {
    if (!introDone || dragPointer !== null) return;
    dragPointer = e.pointerId;
    dragStartY = e.clientY;
    settling = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onHandleMove(e: PointerEvent) {
    if (e.pointerId !== dragPointer) return;
    dragY = Math.max(0, e.clientY - dragStartY);
  }
  function onHandleUp(e: PointerEvent) {
    if (e.pointerId !== dragPointer) return;
    finishDrag(dragY > SWIPE_CLOSE_PX);
  }
  function onHandleCancel(e: PointerEvent) {
    if (e.pointerId !== dragPointer) return;
    finishDrag(false);
  }
  function finishDrag(close: boolean) {
    dragPointer = null;
    if (close) {
      dragY = 0;
      closeMenu();
      return;
    }
    if (dragY > 0) settling = true;
    dragY = 0;
  }
</script>

<!-- Blur backdrop behind the opened mobile bottom sheet, so the panel reads as the focus
     and the herd recedes. Rendered outside .gear-wrap so outside-click detection fires on it.
     onclick also wires close explicitly to complement the window-level handler.
     The portal wrapper re-parents both children to <body> so position:fixed resolves
     against the viewport, not the will-change:transform chrome header. The wrapper itself
     is display:contents with no transform/filter/will-change so it establishes no
     containing block of its own. -->
<div class="gear-sheet-portal" use:portal>
  <div class="menu-scrim scrim" aria-hidden="true" onclick={() => closeMenu()}></div>
  <!-- Rising telemetry sheet (design handoff 3c): 12px top radius (reserved for rising
       sheets), no shadow — the scrim provides the separation. role=dialog + use:dialog
       gives focus-trap + Esc→closeMenu + focus-restore. Children are plain buttons/links,
       NOT role="menuitem" (that role is invalid inside a dialog). -->
  <div
    class="gear-sheet"
    class:settling
    role="dialog"
    aria-modal="true"
    aria-label={m.topbar_sheet_title()}
    use:dialog={{ onclose: closeMenu }}
    style:transform={dragY > 0 ? `translateY(${dragY}px)` : ""}
    ontransitionend={() => (settling = false)}
    onintroend={() => (introDone = true)}
    transition:fly={{ y: 520, duration: reduceMotion ? 0 : 180, opacity: 1 }}
  >
    <!-- Grab handle: the swipe-down arm zone. Purely gestural sugar (scrim tap, Esc
         and the ✕ all dismiss too), so it stays presentational for AT. -->
    <div
      class="sheet-handle-row"
      role="presentation"
      onpointerdown={onHandleDown}
      onpointermove={onHandleMove}
      onpointerup={onHandleUp}
      onpointercancel={onHandleCancel}
      onlostpointercapture={onHandleCancel}
    >
      <div class="sheet-handle"></div>
    </div>

    <!-- Identity header: brand + version + neutral connection readout (+ explicit ✕
         for AT users; scrim tap / Esc / swipe stay the primary dismissals). -->
    <div class="ident">
      <span class="ident-brand">SHEPHERD</span>
      <span class="ident-conn">
        v{version} · <span class="ident-dot" class:on={connected} aria-hidden="true">●</span>
        {connected ? m.gearmenu_conn_live() : m.gearmenu_conn_offline()}
      </span>
      <button
        type="button"
        class="sheet-close"
        onclick={() => closeMenu()}
        aria-label={m.common_close()}>✕</button
      >
    </div>

    <!-- Hero action: halt herd (52px tier). Disabled + chip-less at 0 working. -->
    <button
      class="hero"
      class:armed
      type="button"
      disabled={haltable === 0}
      onclick={clickHalt}
      aria-label={haltable === 0
        ? m.gearmenu_halt_herd()
        : armed
          ? m.halt_arm_aria({ count: haltable })
          : m.halt_all_aria({ count: haltable })}
    >
      <span class="hero-glyph" aria-hidden="true">■</span>
      <span>{armed ? m.halt_arm({ count: haltable }) : m.gearmenu_halt_herd()}</span>
      {#if haltable > 0}
        <span class="chip">{m.gearmenu_working_chip({ count: haltable })}</span>
      {/if}
    </button>

    <!-- Live token-usage gauge; "all ▾" discloses the full per-window breakdown. -->
    <GearMenuUsage
      mobile
      {limits}
      {nowMs}
      {creditFill}
      {creditColor}
      {creditAmount}
      {refreshing}
      {refreshError}
      {onRefresh}
      {periodLabel}
      onOpenUsage={() => {
        chooseUsage();
        closeMenu();
      }}
    />

    <!-- Attention rows (conditional): diagnostics / updates / What's-New keep their
         amber-alert accents, grouped between the gauge and the workspace rows. -->
    {#if diagnosticsOverall !== "ok" || updateAvailable || herdrUpdateAvailable || codexUpdateAvailable || whatsNew}
      <div class="grp">
        {#if diagnosticsOverall !== "ok"}
          <button
            type="button"
            class="row"
            class:alert={diagnosticsOverall === "error"}
            onclick={() => {
              closeMenu();
              ondiagnose?.();
            }}
            aria-label={m.diagnostics_pip_label()}
          >
            <span class="glyph" aria-hidden="true"
              >{diagnosticsOverall === "error" ? "✕" : "⚠"}</span
            >
            <span>{m.diagnostics_pip_label()}</span>
          </button>
        {/if}
        {#if updateAvailable}
          <button
            type="button"
            class="row update"
            onclick={() => {
              closeMenu();
              onupdate?.();
            }}
            aria-label={m.topbar_update_badge()}
          >
            <svg
              class="glyph glyph-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
            </svg>
            <span>{m.topbar_update_badge()} · {update!.behind}</span>
          </button>
        {/if}
        {#if herdrUpdateAvailable}
          <button
            type="button"
            class="row update"
            onclick={() => {
              closeMenu();
              onherdrupdate?.();
            }}
            aria-label={m.topbar_herdr_update_badge()}
          >
            <svg
              class="glyph glyph-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
            <span>{m.topbar_herdr_update_badge()}</span>
          </button>
        {/if}
        {#if codexUpdateAvailable}
          <button
            type="button"
            class="row update"
            onclick={() => {
              closeMenu();
              oncodexupdate?.();
            }}
            aria-label={m.topbar_codex_update_badge()}
          >
            <svg
              class="glyph glyph-svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m6 15 6-6 6 6" />
              <path d="m6 9 6-6 6 6" />
            </svg>
            <span>{m.topbar_codex_update_badge()}</span>
          </button>
        {/if}
        {#if whatsNew}
          <button
            type="button"
            class="row"
            onclick={() => {
              closeMenu();
              onwhatsnew?.();
            }}
            aria-label={m.whatsnew_topbar_aria()}
          >
            <span class="glyph" aria-hidden="true">●</span>
            <span>{m.whatsnew_open()}</span>
          </button>
        {/if}
      </div>
    {/if}

    <!-- Workspace rows -->
    <div class="grp">
      {#if learningsPresent}
        <button
          type="button"
          class="row"
          onclick={() => {
            closeMenu();
            onlearnings?.();
          }}
          aria-label={learnings > 0
            ? m.learnings_open_aria({ count: learnings })
            : m.learnings_open_curate_aria({ count: learningsCurate })}
        >
          <span class="glyph" aria-hidden="true">✦</span>
          <span>{learningsLabel}</span>
          <span class="row-meta">{learningsCount}</span>
        </button>
      {/if}
      <button type="button" class="row" onclick={chooseSettings}>
        <span class="glyph" aria-hidden="true">⚙</span>
        <span>{m.settings_title()}</span>
      </button>
      <!-- Hosted documentation site — distinct from the GitHub repo link below. -->
      <a
        class="row"
        href={DOCS_URL}
        target="_blank"
        rel="external noreferrer noopener"
        onclick={() => closeMenu()}
      >
        <span class="glyph" aria-hidden="true">↗</span>
        <span>{m.topbar_docs()}</span>
      </a>
      <a
        class="row"
        href={REPO_URL}
        target="_blank"
        rel="external noreferrer noopener"
        onclick={() => closeMenu()}
      >
        <span class="glyph" aria-hidden="true">↗</span>
        <span>{m.topbar_menu_docs()}</span>
      </a>
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
    </div>

    <!-- Plugins group: dynamic — verbatim plugin-authored labels/icons/hints (not i18n). -->
    {#if pluginItems.length > 0}
      <div class="grp plugins">
        <div class="grp-head">
          <span class="grp-label">{m.gearmenu_plugins_label()} · {pluginItems.length}</span>
          <button
            class="grp-action"
            type="button"
            aria-haspopup="dialog"
            onclick={() => {
              closeMenu();
              onManagePlugins?.();
            }}
          >
            {m.gearmenu_plugins_manage()} ▾
          </button>
        </div>
        {#each pluginItems as item (item.id)}
          <button
            type="button"
            class="row"
            onclick={() => {
              closeMenu();
              onPluginItem?.(item.id);
            }}
          >
            <span class="glyph" aria-hidden="true">{item.icon ?? "⌁"}</span>
            <span>{item.label}</span>
            {#if item.hint && item.hint !== item.label}
              <span class="row-meta faint">{item.hint}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}

    <!-- Support group, demoted onto the darker head ground (44px tier). -->
    <div class="grp support">
      <div class="grp-head">
        <span class="grp-label">{m.gearmenu_support_label()}</span>
      </div>
      <button type="button" class="row support-row" onclick={() => onFeedback("bug")}>
        <span class="glyph" aria-hidden="true">⚠</span>
        <span>{m.feedback_dialog_title_bug()}</span>
      </button>
      <button type="button" class="row support-row" onclick={() => onFeedback("feature")}>
        <span class="glyph" aria-hidden="true">✧</span>
        <span>{m.feedback_dialog_title_feature()}</span>
      </button>
      <button type="button" class="row support-row" onclick={() => onFeedback("feedback")}>
        <span class="glyph" aria-hidden="true">↵</span>
        <span>{m.feedback_dialog_title_feedback()}</span>
      </button>
    </div>
  </div>
</div>

<style>
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

  /* Rising sheet: full-width, bright top hairline, 12px top radius (reserved for
     rising sheets), opaque panel chrome — the .scrim behind it dims+blurs the herd.
     No shadow: the scrim already separates it. */
  .gear-sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    background: var(--color-panel);
    border-top: 1px solid var(--color-line-bright);
    border-radius: 12px 12px 0 0;
    display: flex;
    flex-direction: column;
    padding-bottom: env(safe-area-inset-bottom, 0px);
    max-height: 90dvh;
    overflow-y: auto;
  }
  /* Settle-back after a released (non-closing) drag. */
  .gear-sheet.settling {
    transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.3, 1);
  }
  .sheet-handle-row {
    display: flex;
    justify-content: center;
    padding: 10px 0 2px;
    touch-action: none;
    cursor: grab;
    flex-shrink: 0;
  }
  .sheet-handle {
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--color-line-bright);
  }
  .ident {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 20px 10px;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .ident-brand {
    font-size: var(--fs-meta);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .ident-conn {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  /* Connectivity stays in the neutral ink ramp: brightness, not a status hue. */
  .ident-dot {
    color: var(--color-faint);
  }
  .ident-dot.on {
    color: var(--color-ink-bright);
  }
  .sheet-close {
    background: none;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    min-width: 44px;
    min-height: 44px;
    margin: -10px -12px -10px 0;
    font-size: var(--fs-lg);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  /* Hero action: 52px tier, 16px text, amber e-stop glyph + WORKING chip. */
  .hero {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 52px;
    padding: 0 20px;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--color-line);
    font: inherit;
    font-size: var(--fs-lg);
    color: var(--color-ink-bright);
    text-align: left;
    cursor: pointer;
    flex-shrink: 0;
  }
  .hero-glyph {
    width: 20px;
    text-align: center;
    color: var(--color-amber);
    flex-shrink: 0;
  }
  .hero:disabled {
    color: var(--color-muted);
    cursor: default;
    opacity: 0.4;
  }
  .hero:disabled .hero-glyph {
    color: var(--color-muted);
  }
  .chip {
    margin-left: auto;
    border: 1px solid color-mix(in srgb, var(--color-amber) 62%, var(--color-line));
    color: var(--color-amber);
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 2px;
    font-variant-numeric: tabular-nums;
  }
  .hero.armed {
    background: color-mix(in srgb, var(--color-red) 22%, transparent);
    color: var(--color-red);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: var(--fs-base);
  }
  .hero.armed .hero-glyph,
  .hero.armed .chip {
    color: var(--color-red);
    border-color: var(--color-red);
  }
  .grp {
    padding: 4px 0;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .grp-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 20px 0;
  }
  .grp-label {
    font-size: var(--fs-meta);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .grp-action {
    margin-left: auto;
    background: transparent;
    border: 0;
    padding: 8px 4px;
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--color-faint);
    cursor: pointer;
  }
  /* Rows: 48px workspace/plugin tier, 16px text, 20px glyph column, flat states. */
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 48px;
    padding: 0 20px;
    background: transparent;
    border: 0;
    font: inherit;
    font-size: var(--fs-lg);
    color: var(--color-ink);
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    text-decoration: none;
    box-sizing: border-box;
  }
  .glyph {
    width: 20px;
    text-align: center;
    color: var(--color-muted);
    flex-shrink: 0;
  }
  .glyph-svg {
    height: var(--fs-lg);
    display: block;
  }
  .row-meta {
    margin-left: auto;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  .row-meta.faint {
    color: var(--color-faint);
  }
  .row:hover {
    background: var(--color-hover);
  }
  .row:focus-visible,
  .hero:focus-visible,
  .grp-action:focus-visible,
  .sheet-close:focus-visible {
    outline: none;
    background: var(--color-hover);
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
  }
  .row.alert {
    color: var(--color-amber);
  }
  .row.alert .glyph {
    color: var(--color-amber);
  }
  /* Update rows: amber accent (same semantic hue as the inline update badge). */
  .row.update {
    color: var(--color-amber);
  }
  .row.update .glyph {
    color: var(--color-amber);
  }
  /* Support group: demoted onto the head ground, 44px tier, quieter text size. */
  .grp.support {
    background: var(--color-head);
    border-bottom: 0;
    padding: 4px 0 10px;
  }
  .row.support-row {
    min-height: 44px;
    font-size: var(--fs-base);
  }
  /* Quick appearance row: dark/light segment + high-contrast toggle, mirroring the
     desktop ActionBar but sized up for touch (44px tap targets). */
  .quick {
    display: flex;
    align-items: stretch;
    gap: 8px;
    padding: 6px 20px 4px;
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
</style>
