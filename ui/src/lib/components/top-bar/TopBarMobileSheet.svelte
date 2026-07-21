<script lang="ts">
  import type { GaugeKey } from "../usage-gauges";
  import type { UpdateStatus, DiagnosticState, UsageLimits } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { theme, type ThemePref } from "$lib/theme.svelte";
  import ThemeIcon from "$lib/components/ThemeIcon.svelte";
  import GearMenuUsage from "./GearMenuUsage.svelte";
  import GearIdent from "./GearIdent.svelte";
  import GearHaltHero from "./GearHaltHero.svelte";
  import GearGroupHead from "./GearGroupHead.svelte";
  import GearRow from "./GearRow.svelte";
  import { REPO_URL, DOCS_URL } from "$lib/build-info";
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

  function closeAnd(action: (() => void) | undefined): () => void {
    return () => {
      closeMenu();
      action?.();
    };
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

    <!-- Identity header (+ explicit ✕ for AT users; scrim tap / Esc / swipe stay the
         primary dismissals). -->
    <div class="ident-wrap">
      <GearIdent mobile {connected}>
        <button
          type="button"
          class="sheet-close"
          onclick={() => closeMenu()}
          aria-label={m.common_close()}>✕</button
        >
      </GearIdent>
    </div>

    <GearHaltHero mobile {haltable} {armed} onclick={clickHalt} />

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
      onOpenUsage={closeAnd(chooseUsage)}
    />

    <!-- Attention rows (conditional): diagnostics / updates / What's-New keep their
         amber-alert accents, grouped between the gauge and the workspace rows. -->
    {#if diagnosticsOverall !== "ok" || updateAvailable || herdrUpdateAvailable || codexUpdateAvailable || whatsNew}
      <div class="grp">
        {#if diagnosticsOverall !== "ok"}
          <GearRow
            mobile
            warm={diagnosticsOverall === "error"}
            glyph={diagnosticsOverall === "error" ? "✕" : "⚠"}
            label={m.diagnostics_pip_label()}
            onclick={closeAnd(ondiagnose)}
          />
        {/if}
        {#if updateAvailable}
          <GearRow
            mobile
            warm
            label={`${m.topbar_update_badge()} · ${update!.behind}`}
            onclick={closeAnd(onupdate)}
          >
            {#snippet glyphIcon()}
              <svg
                class="glyph-svg"
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
            {/snippet}
          </GearRow>
        {/if}
        {#if herdrUpdateAvailable}
          <GearRow
            mobile
            warm
            label={m.topbar_herdr_update_badge()}
            onclick={closeAnd(onherdrupdate)}
          >
            {#snippet glyphIcon()}
              <svg
                class="glyph-svg"
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
            {/snippet}
          </GearRow>
        {/if}
        {#if codexUpdateAvailable}
          <GearRow
            mobile
            warm
            label={m.topbar_codex_update_badge()}
            onclick={closeAnd(oncodexupdate)}
          >
            {#snippet glyphIcon()}
              <svg
                class="glyph-svg"
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
            {/snippet}
          </GearRow>
        {/if}
        {#if whatsNew}
          <GearRow
            mobile
            glyph="●"
            label={m.whatsnew_open()}
            ariaLabel={m.whatsnew_topbar_aria()}
            onclick={closeAnd(onwhatsnew)}
          />
        {/if}
      </div>
    {/if}

    <!-- Workspace rows -->
    <div class="grp">
      {#if learningsPresent}
        <GearRow
          mobile
          glyph="✦"
          label={learningsLabel}
          meta={String(learningsCount)}
          ariaLabel={learnings > 0
            ? m.learnings_open_aria({ count: learnings })
            : m.learnings_open_curate_aria({ count: learningsCurate })}
          onclick={closeAnd(onlearnings)}
        />
      {/if}
      <GearRow mobile glyph="⚙" label={m.settings_title()} onclick={chooseSettings} />
      <!-- Hosted documentation site — distinct from the GitHub repo link below. -->
      <GearRow
        mobile
        glyph="↗"
        label={m.topbar_docs()}
        href={DOCS_URL}
        onclick={() => closeMenu()}
      />
      <GearRow
        mobile
        glyph="↗"
        label={m.topbar_menu_docs()}
        href={REPO_URL}
        onclick={() => closeMenu()}
      />
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
      <div class="grp">
        <GearGroupHead
          mobile
          label={`${m.gearmenu_plugins_label()} · ${pluginItems.length}`}
          action={m.gearmenu_plugins_manage()}
          onAction={closeAnd(onManagePlugins)}
        />
        {#each pluginItems as item (item.id)}
          <GearRow
            mobile
            glyph={item.icon ?? "⌁"}
            label={item.label}
            meta={item.hint && item.hint !== item.label ? item.hint : ""}
            metaFaint
            onclick={closeAnd(() => onPluginItem?.(item.id))}
          />
        {/each}
      </div>
    {/if}

    <!-- Support group, demoted onto the darker head ground (44px tier). -->
    <div class="grp support">
      <GearGroupHead mobile label={m.gearmenu_support_label()} />
      <GearRow
        mobile
        support
        glyph="⚠"
        label={m.feedback_dialog_title_bug()}
        onclick={() => onFeedback("bug")}
      />
      <GearRow
        mobile
        support
        glyph="✧"
        label={m.feedback_dialog_title_feature()}
        onclick={() => onFeedback("feature")}
      />
      <GearRow
        mobile
        support
        glyph="↵"
        label={m.feedback_dialog_title_feedback()}
        onclick={() => onFeedback("feedback")}
      />
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
  .ident-wrap {
    flex-shrink: 0;
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
  .sheet-close:focus-visible {
    outline: none;
    background: var(--color-hover);
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
  }
  .grp {
    padding: 4px 0;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .grp.support {
    background: var(--color-head);
    border-bottom: 0;
    padding: 4px 0 10px;
  }
  /* SVG glyphs in attention rows: sized here (snippet content carries this
     component's scope, not GearRow's), aligned to the 20px glyph column. */
  .glyph-svg {
    width: 20px;
    height: var(--fs-lg);
    flex-shrink: 0;
    display: block;
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
