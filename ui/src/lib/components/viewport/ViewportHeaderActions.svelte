<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import RedrawMenu from "$lib/components/RedrawMenu.svelte";

  let {
    compact,
    renaming,
    tab,
    headerCollapsed,
    foldRegionId,
    toggleFold,
    redrawOpen = $bindable(),
    ended,
    parked,
    resuming,
    resumable,
    resumeSession,
    prReady,
    armed,
    decommission,
    renameNote,
    onnudge,
    onreattach,
    onfullscreen,
    onresume,
    fontSize,
    fontAtMin,
    fontAtMax,
    onfontstep,
  }: {
    compact: boolean;
    renaming: boolean;
    tab: string;
    headerCollapsed: boolean;
    foldRegionId: string;
    toggleFold: () => void;
    redrawOpen: boolean;
    ended: boolean;
    parked: boolean;
    resuming: boolean;
    resumable: boolean;
    resumeSession: (full?: boolean) => void;
    prReady: boolean;
    armed: boolean;
    decommission: () => void;
    renameNote: string | null;
    onnudge: () => void;
    onreattach: () => void;
    onfullscreen: () => void;
    onresume: () => void;
    // experimental terminal font-size stepper (forwarded to RedrawMenu)
    fontSize: number;
    fontAtMin: boolean;
    fontAtMax: boolean;
    onfontstep: (delta: number) => void;
  } = $props();

  // redraw button ref is used only here — local. Its unmount drops the anchor,
  // closing an open menu (see the {#if redrawOpen && redrawBtnEl} guard below).
  let redrawBtnEl = $state<HTMLButtonElement>();
</script>

<!-- trailing controls: on compact/phone they group + wrap together as a
     right-aligned cluster so the close button never orphans to its own row -->
<!-- while the rename editor is open on mobile the trailing cluster yields the row
     entirely (display:none) so the decom ✕ can't sit beside the rename-cancel ✕ -->
<div
  class="vp-actions"
  class:mobile={compact}
  style:display={compact && renaming ? "none" : undefined}
>
  {#if compact}
    {#if renameNote}<span class="rename-note">{renameNote}</span>{/if}
    <!-- mobile space-saver: folds the tabs + PR rail + build queue away so the
         terminal claims the freed height. State persists across sessions. -->
    <button
      class="vp-fold icon-btn compact"
      type="button"
      aria-expanded={!headerCollapsed}
      aria-controls={foldRegionId}
      aria-label={headerCollapsed ? m.viewport_unfold_aria() : m.viewport_fold_aria()}
      title={headerCollapsed ? m.viewport_unfold_aria() : m.viewport_fold_aria()}
      onclick={toggleFold}
    >
      <!-- chevron points the way the secondary chrome moves, per the user's
           explicit "Pfeil nach unten" request: ▾ while expanded (tap to fold it
           down/away), ▴ once folded (tap to bring it back up). This intentionally
           inverts the desktop git-toggle's disclosure caret, which is a separate
           control that never co-renders with this one. -->
      <span aria-hidden="true">{headerCollapsed ? "▴" : "▾"}</span>
    </button>
  {/if}
  <!-- squished-history repair variants under field test (see redrawNudge etc.
       above) — a quiet icon-only wrench toggle opening an anchored popover with the four
       candidates. The losing variants get removed after testing. Terminal-tab
       only: every variant acts on the terminal, so the control can't issue a
       silent nudge/fullscreen against a hidden mount from another tab (the
       button unmounting also drops redrawBtnEl, which closes an open menu). -->
  {#if tab === "term"}
    <button
      class="vp-redraw icon-btn"
      class:compact
      bind:this={redrawBtnEl}
      type="button"
      aria-haspopup="menu"
      aria-expanded={redrawOpen}
      onclick={() => (redrawOpen = !redrawOpen)}
      title={m.viewport_redraw_title()}
      aria-label={m.viewport_redraw_title()}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        ><path
          d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6Z"
        /></svg
      >
    </button>
    {#if redrawOpen && redrawBtnEl}
      <RedrawMenu
        anchor={redrawBtnEl}
        live={!ended && !parked}
        {resuming}
        {onnudge}
        {onreattach}
        {onfullscreen}
        {onresume}
        {fontSize}
        {fontAtMin}
        {fontAtMax}
        {onfontstep}
        onclose={() => (redrawOpen = false)}
      />
    {/if}
  {/if}
  {#if resumable}
    <!-- bring the agent back when the session is parked (idle/done) — e.g. the
         provider exited to a shell after a herdr restart. Forces a fresh resume. -->
    <button
      class="vp-resume"
      class:icon-btn={compact}
      class:compact
      type="button"
      onclick={() => resumeSession(true)}
      disabled={resuming}
      title={m.viewport_resume_title()}
      aria-label={m.viewport_resume_title()}
    >
      <svg
        class:spin={resuming}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        ><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></svg
      >
      {#if !compact}<span>{m.cardmenu_resume_short()}</span>{/if}
    </button>
  {/if}
  {#if prReady}
    <!-- earned prominence: once a PR exists the work is delivered, so the
         decommission nudge surfaces inline (green, arms red on click) — one
         obvious click+confirm away. Before that, desktop shows the quiet
         icon-only ✕ below; compact shows the same icon-only ✕ in the git strip. -->
    <button
      class="decom"
      class:armed
      class:ready={!armed}
      class:icon-btn={compact}
      class:compact
      type="button"
      onclick={decommission}
      title={armed ? m.viewport_confirm_decommission() : m.viewport_decommission_ready_title()}
      aria-label={armed ? m.viewport_confirm_decommission() : m.viewport_decommission_ready_aria()}
    >
      {#if compact}
        <!-- armed = destructive confirm: the square fills solid red (no glyph
             swap). Never ✓ — that glyph means READY/actionable-complete in the HUD. -->
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"><path d="M18 6 6 18" /><path d="M6 6l12 12" /></svg
        >
      {:else}
        {armed ? m.viewport_confirm_decommission() : m.viewport_decommission()}
      {/if}
    </button>
  {:else if !compact}
    <!-- no PR yet → desktop still keeps decommission one click away, but quiet:
         a faint icon-only ✕ (the green nudge is earned by delivering a PR).
         Compact layouts show the same icon-only ✕ in the git strip instead.
         Same armed treatment as above: the square fills solid red (no glyph
         swap). Never ✓ — that glyph means READY/actionable-complete. -->
    <button
      class="decom quiet icon-btn"
      class:armed
      type="button"
      onclick={decommission}
      title={armed ? m.viewport_confirm_decommission() : m.viewport_decommission_title()}
      aria-label={armed ? m.viewport_confirm_decommission() : m.viewport_decommission_aria()}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"><path d="M18 6 6 18" /><path d="M6 6l12 12" /></svg
      >
    </button>
  {/if}
</div>

<style>
  /* desktop: transparent to layout — resume + the decom control (quiet ✕ or
     ready nudge) flow inline.
     compact/phone override (.vp-actions.mobile) turns this into a
     real flex cluster so the trailing controls wrap together. */
  .vp-actions {
    display: contents;
  }

  /* mobile fold toggle: now an .icon-btn.compact — ghost/sizing/hover from recipe.
     Keep only the Unicode-chevron legibility bits the recipe doesn't provide. */
  .vp-fold {
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    line-height: 1;
  }

  .decom {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-faint);
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s,
      background 0.12s;
  }
  /* text-pill-only declarations — not applied when icon-btn form is used */
  .decom:not(.icon-btn) {
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 7px;
  }
  /* Resume: the primary action of a parked session, so it stays on the identity
     row (not in the strip). Quiet neutral (not destructive, not "ready-complete"
     → no green/red), brightening to ink on hover. */
  /* redraw-variants toggle: now an .icon-btn; only the open-state highlight
     is kept here (hover is handled by the global recipe). */
  .vp-redraw[aria-expanded="true"] {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
  }

  .vp-resume {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-ink);
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  /* text-pill-only declarations — not applied when compact icon-btn form is used */
  .vp-resume:not(.icon-btn) {
    gap: 5px;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 2px 7px;
  }
  /* desktop labeled form sizes its SVG text-scaled (beside the uppercase label);
     the compact icon-only form has no label and sizes via the global
     .icon-btn svg (18px) instead. Without this the labeled SVG has no sizing
     rule and falls back to the replaced-element default (~300×150). */
  .vp-resume:not(.icon-btn) svg {
    width: var(--fs-base);
    height: var(--fs-base);
    display: block;
  }
  .vp-resume:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
  }
  .vp-resume:disabled {
    cursor: default;
    opacity: 0.6;
  }

  /* PR delivered → the work is done. The decommission control graduates from its
     quiet form (faint inline ✕ on desktop, strip button on compact) into a bright,
     gently pulsing green call-to-action on the identity row so wrapping up the
     session reads as the obvious next step. Hover/armed below still override it
     red (destructive confirm). */
  .decom.ready {
    color: var(--color-green);
    border-color: color-mix(in srgb, var(--color-green) 40%, transparent);
    background: color-mix(in srgb, var(--color-green) 10%, transparent);
    animation: decom-ready-pulse 2.4s ease-in-out infinite;
  }

  @keyframes decom-ready-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-green) 30%, transparent);
    }
    50% {
      box-shadow: 0 0 6px 1px color-mix(in srgb, var(--color-green) 35%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .decom.ready {
      animation: none;
    }
  }

  .decom:hover {
    color: var(--color-red);
    border-color: color-mix(in srgb, var(--color-red) 45%, transparent);
  }

  /* hovering the ready button means the operator is about to act on it — drop the
     green pulse so the red destructive-confirm affordance reads cleanly */
  .decom.ready:hover {
    background: transparent;
    animation: none;
    box-shadow: none;
  }

  .decom.armed {
    color: var(--color-red);
    border-color: var(--color-red);
    background: color-mix(in srgb, var(--color-red) 12%, transparent);
  }

  /* Icon-only armed decom: no "?" adornment (the square has no room for it); the
     armed/destructive-confirm state reads as a solid red fill instead. Scoped to
     .icon-btn so the labeled "confirm ✕" text form keeps its faint-red treatment. */
  .decom.icon-btn.armed {
    background: var(--color-red);
    border-color: var(--color-red);
    /* knockout ✕ in the surface color — clears WCAG ≥3:1 non-text contrast on the
       red fill in all four themes (ink-bright fails the high-contrast themes). */
    color: var(--color-bg);
  }

  /* quiet variant: pre-PR desktop inline ✕. Now an .icon-btn — sizing/padding
     handled by the global recipe. Color/hover/armed states still apply above. */

  /* post-rename note sits in the trailing cluster on compact/phone. */
  .rename-note {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22ch;
  }

  /* group the trailing controls (rename ✎ + close ✕) into one cluster that
     wraps as a unit and stays right-aligned — margin-left:auto pins it to the
     right edge of whichever row it lands on, so the close button can no longer
     orphan to the left of its own line when the identity row gets crowded */
  .vp-actions.mobile {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-left: auto;
    flex-shrink: 0;
  }
  /* the fold toggle is likewise a bare chevron — at --fs-base it reads as a
     dot, so it gets the same icon-size bump (hit area stays ≥44px above) */
  .vp-actions.mobile .vp-fold {
    font-size: var(--fs-xl);
    line-height: 1;
  }
</style>
