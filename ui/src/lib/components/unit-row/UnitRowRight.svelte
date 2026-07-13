<script lang="ts">
  import type { Session, GitState } from "$lib/types";
  import { elapsed } from "$lib/format";
  import { isMerging } from "../merge-train";
  import { m } from "$lib/paraglide/messages";
  import ResearchBadge from "../ResearchBadge.svelte";
  import PrBadge from "../PrBadge.svelte";
  import CriticBadge from "../CriticBadge.svelte";
  import BuildQueueBadge from "../BuildQueueBadge.svelte";
  import PlanGateBadge from "../PlanGateBadge.svelte";
  import AutopilotBadge from "../AutopilotBadge.svelte";
  import { repoConfig } from "$lib/reviews.svelte";
  import { statusTip } from "$lib/actions/statusTip.svelte";

  let {
    session,
    git,
    nowMs,
    ondecommission,
    previewPort = null,
    previewServeFailed = false,
    onpreview,
    quotaKind = null,
    reviewing,
    openPanelTick = 0,
    stepperTerminal,
    decom,
    coarsePointer,
    pressDecommission,
    previewChoiceOpen = false,
    onpreviewchoice,
    elapsedEl = $bindable(),
  }: {
    session: Session;
    git?: GitState;
    nowMs: number;
    ondecommission?: (id: string) => void;
    previewPort?: number | null;
    previewServeFailed?: boolean;
    onpreview?: (id: string, target?: "inline" | "tab") => void;
    quotaKind?: "rework" | "review" | "error" | "plan" | null;
    reviewing: boolean;
    // monotonic tick bumped by the row's "Answer" hold CTA → opens this session's PlanPanel
    openPanelTick?: number;
    stepperTerminal: boolean;
    decom: "idle" | "armed";
    coarsePointer: boolean;
    pressDecommission: () => void;
    previewChoiceOpen?: boolean;
    onpreviewchoice?: (anchor: HTMLElement) => void;
    elapsedEl?: HTMLSpanElement;
  } = $props();

  let previewWrapEl = $state<HTMLElement | null>(null);
  const previewOpenMode = $derived(repoConfig.previewOpenModeForLoaded(session.repoPath));
  const previewBusy = $derived(previewPort != null && previewOpenMode === null);

  function choosePreview(target: "inline" | "tab") {
    onpreview?.(session.id, target);
  }

  function onPreviewActivate(e: MouseEvent | KeyboardEvent) {
    e.stopPropagation();
    if (previewBusy || previewOpenMode === null) return;
    if (previewOpenMode === "ask") {
      if (previewWrapEl) onpreviewchoice?.(previewWrapEl);
      return;
    }
    choosePreview(previewOpenMode);
  }

  // Per-kind explanatory tooltip for the quota-stall chip.
  const quotaTip = $derived(
    quotaKind === "rework"
      ? m.unitrow_quota_rework_tip()
      : quotaKind === "review"
        ? m.unitrow_quota_review_tip()
        : quotaKind === "error"
          ? m.unitrow_quota_error_tip()
          : m.unitrow_quota_title(),
  );
  const quotaLabel = $derived(
    quotaKind === "rework"
      ? m.unitrow_quota_rework()
      : quotaKind === "review"
        ? m.unitrow_quota_review()
        : quotaKind === "error"
          ? m.unitrow_quota_error()
          : m.unitrow_quota_plan(),
  );
</script>

<div class="u-right">
  {#if ondecommission && !coarsePointer}
    <!-- Fine-pointer decommission: hover/focus-revealed ✕ in the top-right
         corner, same two-step arm/confirm as the swipe reveal. A real <button>
         is valid here — .u-right is a sibling of the .unit-hit overlay, not
         nested inside it, and the existing .u-right > button z-index rule
         raises it above the overlay; its click never reaches the row select,
         so no propagation concern. -->
    <button
      class="row-decom"
      class:armed={decom === "armed"}
      type="button"
      onclick={pressDecommission}
      title={decom === "armed"
        ? m.viewport_confirm_decommission()
        : m.viewport_decommission_title()}
      aria-label={decom === "armed"
        ? m.viewport_confirm_decommission()
        : m.viewport_decommission_aria()}
    >
      {decom === "armed" ? "✕?" : "✕"}
    </button>
  {/if}
  {#if previewPort != null}
    <!-- Live preview available (server reports a bound listener). Selecting +
         opening the pane is an action distinct from the row's own select, so
         this is an actionable control; rendered as role=button (not a nested
         <button>, which would be invalid inside the row's own button) with
         stopPropagation so the row's select doesn't also fire. -->
    <span class="preview-wrap" bind:this={previewWrapEl}>
      <span
        class="preview-badge"
        class:preview-badge--degraded={previewServeFailed}
        class:preview-badge--busy={previewBusy}
        role="button"
        tabindex={previewBusy ? -1 : 0}
        aria-busy={previewBusy}
        aria-disabled={previewBusy}
        aria-expanded={previewOpenMode === "ask" ? previewChoiceOpen : undefined}
        title={previewBusy
          ? m.unitrow_preview_loading()
          : previewServeFailed
            ? m.unitrow_preview_badge_degraded()
            : m.unitrow_preview_badge()}
        onclick={onPreviewActivate}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPreviewActivate(e);
          }
        }}>{m.unitrow_preview_badge()}</span
      >
    </span>
  {/if}
  <ResearchBadge {session} tip />
  {#if !stepperTerminal}<PrBadge {git} sessionId={session.id} />{/if}
  <CriticBadge sessionId={session.id} tip prUrl={git?.url} />
  <BuildQueueBadge sessionId={session.id} planPhase={session.planPhase} {git} tip />
  <PlanGateBadge
    {session}
    allowView={false}
    labelOverride={quotaKind === "plan" ? m.unitrow_quota_plan() : null}
    fallbackLabel={quotaKind === "plan" ? m.unitrow_quota_plan() : null}
    fallbackTitle={quotaKind === "plan" ? m.unitrow_quota_title() : null}
    {openPanelTick}
    tip
  />
  {#if quotaKind && quotaKind !== "plan"}
    <span
      class="badge quota-stalled"
      role="img"
      aria-label={quotaLabel}
      use:statusTip={{ text: quotaTip }}>{quotaLabel}</span
    >
  {/if}
  <!-- REVIEWING (in-flight critic) outranks the autopilot badge -->
  {#if !reviewing}<AutopilotBadge
      {session}
      repoAutopilotDefault={repoConfig.isAutopilotEnabled(session.repoPath)}
      tip
    />{/if}
  <!-- Sandbox state: degraded/unconfined are warnings (amber); confined profiles
       are quiet informational badges (slate). Trusted-manual renders nothing. -->
  {#if session.sandboxDegraded}
    <span
      class="badge sandbox-warn"
      role="img"
      aria-label={m.session_sandbox_degraded_label()}
      use:statusTip={{ text: m.session_sandbox_degraded_title() }}
      >{m.session_sandbox_degraded_label()}</span
    >
  {:else if session.sandboxApplied === "autonomous" && session.egressDegraded}
    <span
      class="badge sandbox-warn"
      role="img"
      aria-label={m.session_sandbox_egress_degraded_label()}
      use:statusTip={{ text: m.session_sandbox_egress_degraded_title() }}
      >{m.session_sandbox_egress_degraded_label()}</span
    >
  {:else if session.sandboxApplied === "autonomous"}
    <span
      class="badge sandbox"
      role="img"
      aria-label={m.session_sandbox_autonomous_label()}
      use:statusTip={{ text: m.session_sandbox_autonomous_title() }}
      >{m.session_sandbox_autonomous_label()}</span
    >
  {:else if session.sandboxApplied === "standard"}
    <span
      class="badge sandbox"
      role="img"
      aria-label={m.session_sandbox_standard_label()}
      use:statusTip={{ text: m.session_sandbox_standard_title() }}
      >{m.session_sandbox_standard_label()}</span
    >
  {:else if session.sandboxApplied === "trusted" && session.auto}
    <span
      class="badge sandbox-warn"
      role="img"
      aria-label={m.session_sandbox_unconfined_label()}
      use:statusTip={{ text: m.session_sandbox_unconfined_title() }}
      >{m.session_sandbox_unconfined_label()}</span
    >
  {/if}
  {#if isMerging(session, nowMs)}
    <span
      class="badge merging"
      id="u-status-{session.id}"
      use:statusTip={{ text: m.status_merging_tip() }}>{m.status_merging()}</span
    >
  {:else if session.readyToMerge}
    <span class="badge" id="u-status-{session.id}" use:statusTip={{ text: m.status_ready_tip() }}
      >{m.status_ready_to_merge()}</span
    >
  {/if}
  <span class="elapsed" bind:this={elapsedEl}>{elapsed(session.createdAt, nowMs)}</span>
</div>

<style>
  .u-right {
    grid-area: right;
    text-align: right;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-end;
    flex-shrink: 0;
  }

  /* Raise the interactive badge above the overlay so it's clickable. */
  .u-right > :global(button),
  .u-right > :global([role="button"]) {
    position: relative;
    z-index: 1;
  }

  /* Fine-pointer decommission ✕: opacity (not display) keeps it keyboard-
     focusable while invisible — and the invisible button's reserved in-flow slot
     at the top of every row's .u-right column is deliberate (rows stay aligned,
     the button stays focusable); while invisible it's also click-inert
     (pointer-events: none) so the invisible corner can't be tapped on
     fine-pointer-but-hoverless hardware; revealed on row hover/focus-within
     (hover-capable fine pointers only, so touch layouts never show a ghost
     button) and forced visible while armed — every reveal state restores
     pointer-events. Idle = quiet faint glyph; armed = red ✕? echoing the
     swipe reveal's .decom.armed treatment. */
  .row-decom {
    margin: 0;
    padding: 0 2px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--color-faint);
    font: inherit;
    font-size: var(--fs-meta);
    line-height: 1.3;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.14s ease;
  }
  /* outside the hover/fine gate: a keyboard-focused button must never be
     invisible on fine-pointer-but-hoverless hardware */
  .row-decom:focus-visible {
    opacity: 1;
    pointer-events: auto;
  }
  .row-decom:hover,
  .row-decom:focus-visible {
    color: var(--color-red);
  }
  .row-decom.armed {
    opacity: 1;
    pointer-events: auto;
    background: color-mix(in srgb, var(--color-red) 26%, transparent);
    color: var(--color-red);
    font-weight: 600;
  }

  /* Quiet muted text, not a colored pill — the StatusPip (left) already encodes
     status by color + pulse, so an outlined `--rule`-tinted badge here just
     duplicated that hue (amber for running) and added to the orange wall. */
  .badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
  }

  /* PREVIEW: an actionable, navigational badge — opens the live app pane. Blue is
     the non-reserved informational accent (green = READY, amber = running/critic,
     red = blocked, slate = done are all taken), so it reads as "go look" without
     colliding with any status hue. Outlined + pointer to signal it's clickable. */
  .preview-wrap {
    position: relative;
    z-index: 1;
    display: inline-flex;
    justify-content: flex-end;
  }
  .preview-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-blue);
    border-radius: 2px;
    color: var(--color-blue);
    white-space: nowrap;
    cursor: pointer;
    background: transparent;
  }
  .preview-badge:hover,
  .preview-badge:focus-visible {
    background: color-mix(in srgb, var(--color-blue) 14%, transparent);
  }
  .preview-badge--busy {
    cursor: wait;
    opacity: 0.55;
  }
  /* Degraded: the slot's tailscale serve mapping failed to register — the preview
     still works on loopback but isn't exposed over Tailscale. Amber = attention/
     degraded (not red, which is reserved for a blocked session). */
  .preview-badge--degraded {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .preview-badge--degraded:hover,
  .preview-badge--degraded:focus-visible {
    background: color-mix(in srgb, var(--color-amber) 14%, transparent);
  }

  /* MERGING: the one colored, moving badge — amber + pulse marks the in-flight
     merge train, louder than the quiet muted text badges around it. */
  .badge.merging {
    color: var(--color-amber);
    animation: merge-pulse 1.5s ease-in-out infinite;
  }

  /* SANDBOX (confined): a quiet informational badge — slate reads as "noted, parked"
     (done-state hue), not actionable. Outlined to set it apart from plain text badges. */
  .badge.sandbox {
    padding: 1px 6px;
    border: 1px solid var(--color-slate);
    border-radius: 2px;
    color: var(--color-slate);
  }
  /* SANDBOX (warn): degraded sandbox or an unattended agent running unconfined —
     amber = attention/degraded (NOT red, reserved for a blocked session). */
  .badge.sandbox-warn {
    padding: 1px 6px;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
  }

  /* QUOTA STALLED: session blocked on quota exhaustion — amber attention, same idiom
     as sandbox-warn; needs a human to resume/take over/abandon. */
  .badge.quota-stalled {
    padding: 1px 6px;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    font-weight: 600;
  }

  .elapsed {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.08em;
  }

  @container herd (max-width: 360px) {
    /* badge rail → left-aligned, wrapping horizontal strip on its own row */
    :global(.units:not(.flow)) .u-right {
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-start;
      text-align: left;
      gap: 6px;
    }
    /* Pin the elapsed clock to the card's top-right, aligned with the name row,
       instead of letting it ride along in the own-row badge strip. pointer-events
       is none (MANDATORY, not cosmetic): .elapsed paints above the .unit-hit
       overlay (it's later in the DOM), so without this it would swallow row-select
       clicks in the top-right corner and starve onHitMove's mousemove — breaking
       the TimePopover hover trigger. none passes events through to the overlay
       while getBoundingClientRect() still measures the clock for the bounds test
       + popover anchor. */
    :global(.units:not(.flow)) .elapsed {
      position: absolute;
      top: 11px;
      right: 14px;
      pointer-events: none;
    }
    /* The decommission ✕ is invisible-but-keyboard-focusable (opacity:0 +
       pointer-events:none from the base .row-decom rule, NOT display:none) so it
       stays in the tab order and reveals on hover/focus. Keep it absolute and out
       of flow, parked just below the pinned clock in the right gutter (on the
       prompt's first line) so it clears the clock and doesn't indent the badge
       strip. top: 30px = the clock's top: 11px + ~one clock line-height, dropping
       the ✕ just under the clock onto the prompt's first line. Unlike .u-top, .u-sub
       (the prompt) reserves no right gutter, so a very long prompt's first line can
       run under the ✕ — acceptable: the ✕ is hover-only, tiny, and sits over muted
       secondary text, so it merely paints over (same as the clock-over-name case). */
    :global(.units:not(.flow)) .row-decom {
      position: absolute;
      top: 30px;
      right: 12px;
    }
  }
</style>
