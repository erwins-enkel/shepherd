<script lang="ts">
  import type { Session, GitState } from "#lib/types.js";
  import { elapsed } from "#lib/format.js";
  import { isMerging } from "../merge-train";
  import { m } from "#lib/paraglide/messages.js";
  import CliBadge from "../CliBadge.svelte";
  import ResearchBadge from "../ResearchBadge.svelte";
  import TerminalBadge from "../TerminalBadge.svelte";
  import IssueBadge from "../IssueBadge.svelte";
  import PrBadge from "../PrBadge.svelte";
  import CriticBadge from "../CriticBadge.svelte";
  import BuildQueueBadge from "../BuildQueueBadge.svelte";
  import PlanGateBadge from "../PlanGateBadge.svelte";
  import AutopilotBadge from "../AutopilotBadge.svelte";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { checksCleared } from "#lib/checks-cleared.js";

  let {
    session,
    selected,
    onselect,
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
    showCli = true,
    queueStepLive = false,
    elapsedEl = $bindable(),
  }: {
    session: Session;
    selected: boolean;
    onselect: (id: string) => void;
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
    /** Render the CLI chip. False when every session on display runs the same CLI — see
     *  providersMixed. Defaults to true for rows rendered outside a list. */
    showCli?: boolean;
    /** The activity line is showing the build queue's live "Step N/M" — the queue segment
     *  steps aside so the card says it once. */
    queueStepLive?: boolean;
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

  const idleOpenCleared = $derived(
    git?.state === "open" &&
      checksCleared(git.checks, git.noCi) &&
      session.status !== "running" &&
      session.status !== "blocked" &&
      !reviewing,
  );
  const changesRequested = $derived(idleOpenCleared && !!git?.reviewBlock);
  const branchProtectionBlocked = $derived(
    idleOpenCleared && !git?.reviewBlock && git?.mergeStateStatus === "blocked",
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
  <!-- D4 (docs/design/mobile-herd): on a coarse pointer every badge below that has a click of its
       own is a READ-ONLY readout. Six ~15px tap targets stacked in one card cannot meet iOS HIG
       44x44 (several miss even the hard WCAG 2.5.8 floor of 24x24), and inflating them would push
       the card past 200px — the opposite of what the mobile list needs. Each action stays
       reachable: the card tap opens the detail screen, where GitRail / PlanGateBadge /
       BuildQueuePanel / the preview tab carry the same controls at a conformant size, and the
       issue chip's own href is reachable from the session's issue link there. -->
  <div class="u-badges">
    {#if previewPort != null}
      <!-- Live preview available (server reports a bound listener). Selecting +
           opening the pane is an action distinct from the row's own select, so
           this is an actionable control; rendered as role=button (not a nested
           <button>, which would be invalid inside the row's own button) with
           stopPropagation so the row's select doesn't also fire. -->
      <span class="preview-wrap" bind:this={previewWrapEl}>
        {#if coarsePointer}
          <!-- D4: touch — a read-only marker. The preview opens from the detail screen's
               preview tab, which the card tap already reaches. -->
          <span
            class="preview-badge preview-badge--readonly"
            class:preview-badge--degraded={previewServeFailed}
            role="img"
            aria-label={previewServeFailed
              ? m.unitrow_preview_badge_degraded()
              : m.unitrow_preview_badge()}
            use:statusTip={{
              text: previewServeFailed
                ? m.unitrow_preview_badge_degraded()
                : m.unitrow_preview_badge(),
            }}>{m.unitrow_preview_badge()}</span
          >
        {:else}
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
        {/if}
      </span>
    {/if}
    {#if showCli}<CliBadge {session} />{/if}
    <ResearchBadge {session} tip />
    <TerminalBadge {session} tip />
    <!-- Issue before PR: the backlog issue is what the session was spawned for, the PR is
         what came out of it — reading them left-to-right follows that order. `git` carries
         the forge-derived issue URL, which is what the chip opens on rows whose launch
         metadata predates the field. -->
    <IssueBadge {session} {git} interactive={!coarsePointer} />
    {#if !stepperTerminal}<PrBadge {git} sessionId={session.id} interactive={!coarsePointer} />{/if}
    <CriticBadge sessionId={session.id} tip interactive={!coarsePointer} prUrl={git?.url} />
    <BuildQueueBadge
      sessionId={session.id}
      planPhase={session.planPhase}
      {git}
      {selected}
      {onselect}
      tip
      interactive={!coarsePointer}
      hideWhenStepLive={queueStepLive}
    />
    <PlanGateBadge
      {session}
      allowView={false}
      labelOverride={quotaKind === "plan" ? m.unitrow_quota_plan() : null}
      fallbackLabel={quotaKind === "plan" ? m.unitrow_quota_plan() : null}
      fallbackTitle={quotaKind === "plan" ? m.unitrow_quota_title() : null}
      {openPanelTick}
      tip
      interactive={!coarsePointer}
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
    {#if changesRequested}
      <span
        class="badge attention"
        id="u-status-{session.id}"
        use:statusTip={{
          text: m.unitrow_changes_requested_title({
            reviewer: git?.reviewBlock?.reviewer ?? m.unitrow_unknown_reviewer(),
          }),
        }}
        >{m.unitrow_changes_requested({
          reviewer: git?.reviewBlock?.reviewer ?? m.unitrow_unknown_reviewer(),
        })}</span
      >
    {:else if branchProtectionBlocked}
      <span
        class="badge attention"
        id="u-status-{session.id}"
        use:statusTip={{ text: m.unitrow_merge_blocked_title() }}>{m.unitrow_merge_blocked()}</span
      >
    {:else if isMerging(session, nowMs)}
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
  </div>
  <span class="elapsed" bind:this={elapsedEl}>{elapsed(session.createdAt, nowMs)}</span>
</div>

<style>
  /* The badge strip: one full-width row beneath the name+prompt, set off by a hairline rule
     like an instrument readout. Segments carry no box of their own — a hairline divider
     separates them, and only the text (or a lead glyph) carries a hue, so a busy card no
     longer reads as a wall of amber outlines. */
  .u-right {
    grid-area: right;
    min-width: 0;
    margin-top: 2px;
    padding-top: 5px;
    border-top: 1px solid var(--color-line);
  }
  /* No segment rendered → no rule. (Only the chrome goes: the pinned clock and ✕ live in
     .u-right too, so the box itself must stay.) */
  .u-right:not(
    :has(
      .u-badges
        > :global(
          :is(
            .cli-badge,
            .research-badge,
            .terminal-badge,
            .issue-badge,
            .pr-badge,
            .csf-badge,
            .critic-badge,
            .queue-badge,
            .pg-badge,
            .ap-paused,
            .ap-complete,
            .ap-unavailable,
            .badge,
            .preview-wrap
          )
        )
    )
  ) {
    margin-top: 0;
    padding-top: 0;
    border-top: 0;
  }
  /* Every segment carries a leading divider + gutter; the strip pulls itself left by exactly
     that width and clips horizontally, so the divider of whichever segment starts a line
     (the first, or one that wrapped) falls outside and only the dividers BETWEEN segments
     show. `clip` (not `hidden`) keeps the y-axis visible — focus rings stay whole — and the
     badges' popovers live in the native top layer, out of the clip's reach. */
  .u-badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    row-gap: 4px;
    min-width: 0;
    margin-left: -10px;
    overflow-x: clip;
    line-height: 1.5;
  }
  .u-right
    .u-badges
    > :global(
      :is(
        .cli-badge,
        .research-badge,
        .terminal-badge,
        .issue-badge,
        .pr-badge,
        .csf-badge,
        .critic-badge,
        .queue-badge,
        .pg-badge,
        .ap-paused,
        .ap-complete,
        .ap-unavailable,
        .badge,
        .preview-wrap
      )
    ) {
    padding: 0 9px;
    border: 0;
    border-left: 1px solid var(--color-line);
    border-radius: 0;
    background: transparent;
    font-size: var(--fs-micro);
    line-height: inherit;
  }
  /* Interactive segments: with no box to fill, hover underlines and focus draws an outline
     around the text instead of the old inset ring. */
  .u-right .u-badges > :global(:is(button, a, [role="button"])):hover {
    background: transparent;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .u-right .u-badges > :global(:is(button, a, [role="button"])):focus-visible {
    box-shadow: none;
    outline: 1px solid var(--color-amber);
    outline-offset: 1px;
  }

  /* Raise the interactive badge above the overlay so it's clickable. A DESCENDANT selector, not
     a child one: the badges sit inside .u-badges (so the touch cap can apply to them without
     catching the clock), and a `>` here would leave every one of them under .unit-hit, where the
     row overlay swallows their clicks. */
  .u-right :global(button),
  .u-right :global([role="button"]) {
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
  .attention {
    color: var(--color-amber);
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
  /* D4 read-only twin: same chrome, no pointer affordance. */
  .preview-badge--readonly {
    cursor: default;
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

  /* SANDBOX (confined): a quiet informational segment — slate reads as "noted, parked"
     (done-state hue), not actionable. */
  .badge.sandbox {
    color: var(--color-slate);
  }
  /* SANDBOX (warn) + QUOTA STALLED: degraded sandbox, an unattended agent running unconfined, or
     a quota stall. The label stays muted and an amber ⚠ glyph carries the warning (amber =
     attention/degraded, NOT red, reserved for a blocked session) — a standing condition, not
     a call to act, so it must not shout like the states that need a human now. */
  .badge.sandbox-warn,
  .badge.quota-stalled {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .badge.sandbox-warn::before,
  .badge.quota-stalled::before {
    content: "⚠";
    color: var(--color-amber);
    letter-spacing: 0;
  }

  /* The clock is pinned to the card's top-right, aligned with the name row (.u-top reserves
     the gutter). pointer-events is none (MANDATORY, not cosmetic): .elapsed paints above the
     .unit-hit overlay (it's later in the DOM), so without this it would swallow row-select
     clicks in the top-right corner and starve onHitMove's mousemove — breaking the
     TimePopover hover trigger. none passes events through to the overlay while
     getBoundingClientRect() still measures the clock for the bounds test + popover anchor. */
  .elapsed {
    position: absolute;
    top: 11px;
    right: 14px;
    pointer-events: none;
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.08em;
  }
  /* The decommission ✕ is invisible-but-keyboard-focusable (opacity:0 + pointer-events:none
     from the base .row-decom rule, NOT display:none) so it stays in the tab order and reveals
     on hover/focus. Absolute and out of flow, parked just below the pinned clock in the right
     gutter (on the prompt's first line). The prompt reserves no right gutter, so a very long
     first line can run under the ✕ — acceptable: it is hover-only, tiny, and sits over muted
     secondary text. The child combinator is load-bearing: it lifts the rule above the
     `.u-right :global(button)` raise (position: relative), which would otherwise win and drop
     the ✕ back into flow as a blank line above the strip. */
  .u-right > .row-decom {
    position: absolute;
    top: 30px;
    right: 12px;
  }

  /* Phone list: a de-boxed RAIL beside the content, not a strip beneath it (see UnitRow's
     .units.flow grid) — the one-line prompt leaves the rail's height free there. Same segments,
     stacked right-aligned: no rule, no dividers, no clip. The clock rides at the foot of the
     rail and drops to the micro rung — the type scale's documented floor for "the tightest
     metadata"; it is a readout, never a tap target. */
  :global(.units.flow) .u-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    margin-top: 0;
    padding-top: 0;
    border-top: 0;
    text-align: right;
  }
  :global(.units.flow) .u-badges {
    flex-direction: column;
    align-items: flex-end;
    row-gap: 2px;
    margin-left: 0;
    overflow-x: visible;
  }
  :global(.units.flow) .u-right .u-badges > :global(*) {
    padding: 0;
    border-left: 0;
  }
  :global(.units.flow) .elapsed {
    position: static;
  }
  /* back in the rail's flow, but still relative: the raise rule's z-index must keep the ✕
     above the .unit-hit overlay, or a click on it would select the row instead */
  :global(.units.flow) .u-right > .row-decom {
    position: relative;
    top: auto;
    right: auto;
  }
  :global(.units.flow) .elapsed {
    font-size: var(--fs-micro);
  }
</style>
