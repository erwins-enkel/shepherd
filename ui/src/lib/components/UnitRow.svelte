<script module lang="ts">
  import { MediaQuery } from "svelte/reactivity";

  // Single-open invariant across every row: the close-fn of the currently open
  // row. Opening another row closes this one first.
  let openRow: (() => void) | null = $state(null);

  // Exactly one row-level decommission affordance per device: primary-coarse
  // pointers get the swipe-to-reveal gesture, primary-fine pointers (incl.
  // touchscreen laptops) the hover ✕ button — never both. `(pointer: coarse)`
  // matches the app's layout gates (+page.svelte `touch`, the reveal CSS's
  // `(hover: hover) and (pointer: fine)`). Module-level so N rows share one
  // matchMedia listener.
  const coarse = new MediaQuery("(pointer: coarse)");
</script>

<script lang="ts">
  import type { Session, GitState, SessionActivity, HoldReason } from "$lib/types";
  import {
    STATUS_COLOR,
    hideStatusBadge,
    autopilotBadgeShown,
    canResume,
    canRelaunch,
  } from "$lib/format";
  import { displayStatus } from "$lib/display-status";
  import { resumeSession } from "$lib/api";
  import CardMenu from "./CardMenu.svelte";
  import { longPress } from "./longpress";
  import { isMerging } from "./merge-train";
  import StatusPip from "./StatusPip.svelte";
  import TimePopover from "./TimePopover.svelte";
  import HeartbeatStrip from "./HeartbeatStrip.svelte";
  import Stepper from "./Stepper.svelte";
  import { reviews } from "$lib/reviews.svelte";
  import { toasts } from "$lib/toasts.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { m } from "$lib/paraglide/messages";
  import { modelLabel } from "$lib/model-label";
  import { onDestroy } from "svelte";
  import UnitRowRight from "./unit-row/UnitRowRight.svelte";
  import { holdLine } from "$lib/hold";
  import {
    REVEAL_PX,
    snapOffset,
    pressDecom,
    swipeGesture,
    type SwipeCallbacks,
    type DecomState,
  } from "./swipe";

  let {
    session,
    selected,
    nowMs,
    onselect,
    git,
    activity,
    previewPort = null,
    previewServeFailed = false,
    onpreview,
    ondecommission,
    onrelaunch,
    onrelaunchElsewhere,
    repoFilter = null,
    onrepofilter,
    workingBlocked = {},
    quotaKind = null,
    hold = undefined,
    onackmanualsteps,
  }: {
    session: Session;
    selected: boolean;
    nowMs: number;
    onselect: (id: string) => void;
    git?: GitState;
    // live per-session signal (heartbeat); undefined until first event
    activity?: SessionActivity;
    // live preview-listener port; non-null surfaces the Preview badge (server-driven, no iframe inference)
    previewPort?: number | null;
    // true when the server's tailscale serve registration failed; surfaces a degraded (amber) badge
    previewServeFailed?: boolean;
    // Preview badge clicked → select this session + open its Viewport preview pane
    onpreview?: (id: string) => void;
    // when provided, the row gains a decommission affordance — coarse pointers get
    // the left-swipe gesture, fine pointers a hover-revealed ✕ button, and the
    // right-click / long-press CardMenu offers it on both
    ondecommission?: (id: string) => void;
    // when provided, the right-click / long-press CardMenu gains a two-step armed
    // Relaunch action (spawns a fresh replacement + decommissions this session)
    onrelaunch?: (id: string) => void;
    // when provided, the CardMenu gains a one-click "Relaunch elsewhere" item that
    // opens the new-task composer pre-filled from this session (cross-repo relaunch)
    onrelaunchElsewhere?: (id: string) => void;
    // active page-level repo filter (full repoPath); drives the icon's pressed state
    repoFilter?: string | null;
    // when provided, clicking the inline repo emoji toggles the repo filter:
    // a path sets it, null clears (same contract as QueueStrip's band toggle)
    onrepofilter?: (repoPath: string | null) => void;
    // working-while-blocked display flags (whole store map); feeds displayStatus only
    workingBlocked?: Record<string, boolean>;
    // quota block kind for this session; non-null surfaces the quota badge
    quotaKind?: "rework" | "review" | "error" | "plan" | null;
    // hold reason for this session; when present renders a muted "why parked" subline
    hold?: HoldReason;
    // when provided, the manual-steps chip gains an "Ack" CTA that clears the auto-merge gate (#1060)
    onackmanualsteps?: (id: string) => void;
  } = $props();

  // Every status-driven DISPLAY branch below reads this, not session.status: a
  // working-while-blocked session gets the full working treatment. Behavioral
  // reads (canResume) stay on the raw status.
  const dStatus = $derived(displayStatus(session, workingBlocked));

  // repo the unit works in — the last path segment of its repoPath (e.g. "community-map")
  const repoName = $derived(session.repoPath.split("/").filter(Boolean).at(-1) ?? session.repoPath);

  // True when an un-acked, non-POST-MERGE manual step holds this session's auto-merge (#1060).
  // POST-MERGE-only steps never gate, so they show the chip but no Ack CTA. Mirrors the server
  // hasBlockingManualSteps predicate (src/automerge-core.ts).
  const hasBlockingManualSteps = $derived(
    session.manualStepsAckedAt == null && session.manualSteps.some((s) => !s.postMerge),
  );
  const repoIcon = $derived(projectIcons.iconFor(session.repoPath));
  const repoFiltered = $derived(repoFilter === session.repoPath);
  function toggleRepoFilter() {
    onrepofilter?.(repoFiltered ? null : session.repoPath);
  }

  const swipe = $derived(!!ondecommission && coarse.current);

  // gesture state
  let offset = $state(0); // px the row is slid left (negative); 0 = closed
  let dragging = $state(false); // finger down + tracking x → suppress snap transition

  // arm/confirm state for the revealed action
  let decom = $state<DecomState>("idle");
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  function disarm() {
    clearTimeout(armTimer);
    decom = "idle";
  }
  function close() {
    offset = 0;
    disarm();
    if (openRow === close) openRow = null;
  }
  function openReveal() {
    if (openRow && openRow !== close) openRow();
    offset = -REVEAL_PX;
    openRow = close;
  }

  const swipeCb: SwipeCallbacks = {
    current: () => offset,
    onOffset: (px) => (offset = px),
    onDragging: (b) => (dragging = b),
    onRelease: () => (snapOffset(offset) === -REVEAL_PX ? openReveal() : close()),
    requestClose: close,
  };

  function pressDecommission() {
    const { state, fire } = pressDecom(decom);
    decom = state;
    if (state === "armed") {
      clearTimeout(armTimer);
      armTimer = setTimeout(disarm, 3000);
    }
    if (fire) {
      clearTimeout(armTimer);
      ondecommission?.(session.id);
      close(); // row will drop from the store; close defensively
    }
  }

  onDestroy(() => {
    clearTimeout(armTimer);
    clearTimeout(tipTimer);
    if (openRow === close) openRow = null;
  });

  const reviewing = $derived(reviews.isReviewing(session.id));
  const autopilotShown = $derived(autopilotBadgeShown(session));
  const hideStatus = $derived(hideStatusBadge(dStatus, reviewing, autopilotShown));

  // A status badge renders for merging / ready / a non-hidden status; only then
  // does #u-status-{id} exist. Build the overlay's aria-describedby so it omits
  // that id when no badge renders (reviewing && done/idle) — no dangling IDREF.
  const describedBy = $derived(
    [
      `u-repo-${session.id}`,
      `u-sub-${session.id}`,
      isMerging(session, nowMs) || session.readyToMerge || !hideStatus
        ? `u-status-${session.id}`
        : null,
    ]
      .filter(Boolean)
      .join(" "),
  );

  // live signals (heartbeat) only make sense while the agent works
  const live = $derived(dStatus === "running");
  // stepper conveys "how close to finishing" across the active lifecycle (not archived)
  const showStepper = $derived(
    dStatus === "running" || dStatus === "blocked" || dStatus === "done",
  );
  // PrBadge's merged/closed state duplicates the Stepper's terminal chip; when
  // that chip renders (same git.state), drop PrBadge so the terminal state shows
  // once (the semantic green/faint chip). Open/draft PRs keep PrBadge as normal.
  const stepperTerminal = $derived(
    showStepper && !session.readyToMerge && (git?.state === "merged" || git?.state === "closed"),
  );

  // Decommission is deferred behind an undo window: while it's open, the row is
  // doomed-but-still-present. Dim it so the operator sees it's on its way out.
  const decommissioning = $derived(toasts.pendingUndo(session.id));

  // Right-click (desktop) / long-press (touch) opens a small action menu on the
  // card. Resume is the headline action for a session parked at a shell;
  // decommission rides along wherever the parent wired it.
  // Deliberately NOT liveness-gated (no claudeAlive arg, unlike the Viewport
  // header): the menu only opens on an explicit gesture, so it doesn't add bar
  // noise — and it stays the force-resume escape hatch should the /proc sweep
  // ever misreport a session as alive.
  const resumable = $derived(canResume(session));
  // Relaunch is offered only for an in-flight task (see canRelaunch) AND only when the
  // parent wired a handler — never on a concluded/merged record, where it would spawn a
  // duplicate and tear down the finished row.
  const relaunchable = $derived(!!onrelaunch && canRelaunch(session, git, nowMs));
  // Relaunch-elsewhere reuses the same eligibility as Relaunch, just routed to the
  // cross-repo composer instead of the in-place two-step arm.
  const relaunchElsewhereAble = $derived(!!onrelaunchElsewhere && canRelaunch(session, git, nowMs));
  let hitEl = $state<HTMLButtonElement>();
  let elapsedEl = $state<HTMLSpanElement>();
  let menu = $state<{ x: number; y: number; opener: HTMLElement } | null>(null);
  // Returns whether a menu actually opened (so the long-press can decide whether to
  // swallow the trailing tap). No-ops when nothing to offer or one is already open.
  function openMenuAt(x: number, y: number): boolean {
    if (menu || (!resumable && !ondecommission && !relaunchable && !relaunchElsewhereAble))
      return false;
    menu = { x, y, opener: hitEl! };
    return true;
  }
  function onContextMenu(e: MouseEvent) {
    if (!resumable && !ondecommission && !relaunchable && !relaunchElsewhereAble) return; // nothing to offer → leave native menu
    e.preventDefault();
    openMenuAt(e.clientX, e.clientY);
  }
  async function resumeFromMenu() {
    menu = null;
    onselect(session.id); // focus it so the rebuilt terminal lands in view
    try {
      await resumeSession(session.id, true);
    } catch {
      toasts.info(m.cardmenu_resume_failed({ name: session.name }));
    }
  }
  function decommissionFromMenu() {
    menu = null;
    ondecommission?.(session.id);
  }
  function relaunchFromMenu() {
    menu = null;
    onrelaunch?.(session.id);
  }
  function relaunchElsewhereFromMenu() {
    menu = null;
    onrelaunchElsewhere?.(session.id);
  }

  // Time-breakdown popover: the .unit-hit overlay is the row's only click/
  // keyboard surface, but its mouse trigger is bounds-gated to the wall-clock
  // (.elapsed) — onHitMove latches when the cursor enters/leaves the clock's
  // rect, arming the 450ms hover-intent once on enter (not on every move) so
  // sweeping the cursor across the list doesn't cascade popovers. Keyboard focus
  // on the card still reveals it immediately; the popover anchors to the clock.
  // The clock rect is measured once on card-enter and cached so the per-move
  // bounds test never reads layout; bounded staleness is fine (the clock barely
  // shifts during a hover, the popover anchors off a fresh read in tipShow, and
  // it closes on scroll/resize).
  let tipRect = $state<DOMRect | null>(null);
  let tipTimer: ReturnType<typeof setTimeout> | undefined;
  let overClock = false; // pointer currently within the cached clock bounds
  let clockRect: DOMRect | null = null; // wall-clock bounds, cached on card-enter
  function tipShow(delay = 450) {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => (tipRect = elapsedEl?.getBoundingClientRect() ?? null), delay);
  }
  function tipHide() {
    clearTimeout(tipTimer);
    tipRect = null;
    overClock = false;
  }
  function onHitEnter() {
    clockRect = elapsedEl?.getBoundingClientRect() ?? null;
  }
  function onHitMove(e: MouseEvent) {
    const r = clockRect;
    const inside =
      !!r &&
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom;
    if (inside === overClock) return;
    overClock = inside;
    if (inside) tipShow();
    else tipHide();
  }
</script>

{#snippet row()}
  <div
    class="unit"
    class:sel={selected}
    class:has-activity={live}
    class:decommissioning
    data-unit-id={session.id}
    style="--rule:{session.readyToMerge ? 'var(--color-green)' : STATUS_COLOR[dStatus]}"
  >
    <!-- no native title here (was repoPath): the TimePopover carries the repo
         path as its first line, and a native tooltip would double up with it -->
    <button
      bind:this={hitEl}
      class="unit-hit"
      type="button"
      aria-label={m.unit_open_aria({ name: session.name })}
      aria-describedby={describedBy}
      onclick={() => {
        tipHide();
        onselect(session.id);
      }}
      oncontextmenu={(e) => {
        tipHide();
        onContextMenu(e);
      }}
      onmouseenter={onHitEnter}
      onmousemove={onHitMove}
      onmouseleave={tipHide}
      onfocus={() => {
        if (hitEl?.matches(":focus-visible")) tipShow(0);
      }}
      onblur={tipHide}
      onkeydown={(e) => {
        if (e.key === "Escape" && tipRect) tipHide();
      }}
      use:longPress={{ onTrigger: openMenuAt }}
    ></button>
    <div class="pip-col">
      <StatusPip
        status={dStatus}
        ready={session.readyToMerge}
        merging={isMerging(session, nowMs)}
      />
    </div>

    <div class="u-main">
      <div class="u-top">
        {#if repoIcon && onrepofilter}
          <!-- The emoji doubles as the repo-filter toggle: hover names the repo,
               click narrows the herd to it, click again clears. role=button (not a
               nested <button> — the row overlay is a sibling button) raised above
               the .unit-hit overlay like the preview badge, with stopPropagation so
               the row's own select doesn't also fire. -->
          <span
            class="name-icon actionable"
            role="button"
            tabindex="0"
            title={repoName}
            aria-pressed={repoFiltered}
            aria-label={repoFiltered
              ? m.unitrow_repo_filter_clear_aria({ repo: repoName })
              : m.unitrow_repo_filter_aria({ repo: repoName })}
            onclick={(e) => {
              e.stopPropagation();
              toggleRepoFilter();
            }}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                toggleRepoFilter();
              }
            }}>{repoIcon}</span
          >
        {:else if repoIcon}
          <!-- no title here: the .unit-hit overlay covers this span, so its own
               tooltip could never surface — the overlay's repoPath title serves
               the hover instead -->
          <span class="name-icon" aria-hidden="true">{repoIcon}</span>
        {/if}
        <span class="name">{session.name}</span>
      </div>
      <!-- A configured project emoji identifies the repo on its own, so it moves
           in front of the name and the repo line is dropped to save a row — but
           stays sr-only so the aria-describedby chain keeps announcing the repo.
           repoPath tooltip lives on .unit-hit (overlay covers this area), so it
           still surfaces on row hover either way. -->
      {#if repoIcon}
        <span class="sr-only" id="u-repo-{session.id}">{repoName}</span>
      {:else}
        <div class="u-repo" id="u-repo-{session.id}">
          <span class="repo-glyph" aria-hidden="true">▣</span>{repoName}
        </div>
      {/if}
      <div class="u-sub" id="u-sub-{session.id}">
        {session.prompt}
        {#if dStatus === "running"}
          <span class="car" aria-hidden="true">▏</span>
        {/if}
      </div>
      {#if hold}
        <div class="u-hold">{holdLine(hold)}</div>
      {/if}
    </div>

    <UnitRowRight
      {session}
      {git}
      {nowMs}
      {ondecommission}
      {previewPort}
      {previewServeFailed}
      {onpreview}
      {quotaKind}
      {reviewing}
      {hideStatus}
      {stepperTerminal}
      {decom}
      {dStatus}
      coarsePointer={coarse.current}
      {pressDecommission}
      bind:elapsedEl
    />

    {#if live}
      <div class="u-activity">
        <HeartbeatStrip {activity} {nowMs} />
      </div>
    {/if}

    <span class="meta">
      <span class="meta-text"
        ><span class="desig">{session.desig}</span> · {session.model
          ? modelLabel(session.model)
          : m.newtask_model_default()}</span
      >
      {#if session.manualSteps.length > 0}
        <span
          class="chip-manual-steps"
          title={m.unitrow_manual_steps({ count: session.manualSteps.length })}
        >
          {m.unitrow_manual_steps({ count: session.manualSteps.length })}
        </span>
        {#if hasBlockingManualSteps && onackmanualsteps}
          <button
            type="button"
            class="manual-steps-ack"
            title={m.unitrow_ack_manual_steps()}
            onclick={(e) => {
              e.stopPropagation();
              onackmanualsteps?.(session.id);
            }}
          >
            {m.unitrow_ack_manual_steps()}
          </button>
        {/if}
      {/if}
      {#if showStepper && !session.readyToMerge}
        <span class="meta-stepper">
          <Stepper
            sessionId={session.id}
            {git}
            readyToMerge={session.readyToMerge}
            planPhase={session.planPhase}
          />
        </span>
      {/if}
    </span>
  </div>
{/snippet}

{#if swipe}
  <div class="swipe-wrap" style="--reveal:{REVEAL_PX}px">
    <div class="reveal" aria-hidden={offset === 0}>
      <button
        class="decom"
        class:armed={decom === "armed"}
        type="button"
        tabindex={offset === 0 ? -1 : 0}
        onclick={pressDecommission}
        title={m.viewport_decommission_title()}
        aria-label={m.viewport_decommission_aria()}
      >
        {decom === "armed" ? m.viewport_confirm_decommission() : m.viewport_decommission()}
      </button>
    </div>
    <div
      class="slider"
      class:dragging
      style="transform:translateX({offset}px)"
      use:swipeGesture={swipeCb}
    >
      {@render row()}
    </div>
  </div>
{:else}
  {@render row()}
{/if}

{#if menu}
  <CardMenu
    x={menu.x}
    y={menu.y}
    {resumable}
    opener={menu.opener}
    onresume={resumeFromMenu}
    onrelaunch={relaunchable ? relaunchFromMenu : undefined}
    onrelaunchElsewhere={relaunchElsewhereAble ? relaunchElsewhereFromMenu : undefined}
    ondecommission={ondecommission ? decommissionFromMenu : undefined}
    onclose={() => (menu = null)}
  />
{/if}

{#if tipRect && !menu}
  <TimePopover {session} {git} {activity} {nowMs} anchorRect={tipRect} onclose={tipHide} />
{/if}

<style>
  .unit {
    position: relative;
    display: grid;
    grid-template-columns: 16px 1fr auto;
    /* meta (desig · session) drops to a full-width footer row so it no longer
       fights the name for horizontal space — on a compact sidebar the right
       rail used to win and crush the name to an ellipsis stub */
    grid-template-areas:
      "pip main right"
      "pip meta meta";
    column-gap: 12px;
    row-gap: 3px;
    align-items: start;
    padding: 11px 13px 11px 14px;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    width: 100%;
    transition: opacity 0.18s ease;
  }

  /* Live rows insert a dedicated full-width `act` track between main and meta so
     the heartbeat spans main+right (identical width on every card, independent of
     the badge column). Non-live rows keep the 2-row template above — no extra
     track / row-gap. */
  .unit.has-activity {
    grid-template-areas:
      "pip main  right"
      "pip act   act"
      "pip meta  meta";
  }

  /* deferred decommission: row is doomed but still listed during the undo
     window — fade it so it visibly recedes; restored instantly on UNDO */
  .unit.decommissioning {
    opacity: 0.4;
  }

  /* Transparent overlay that IS the row's click/keyboard target — keeps the
     card a <div> so the interactive PlanGate badge can sit as a sibling instead
     of an (invalid) nested <button>. */
  .unit-hit {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    border-radius: inherit;
    font: inherit;
    color: inherit;
    /* a long-press opens the card menu — suppress iOS's text/callout gesture so it
       doesn't fight ours (the row has no selectable text anyway) */
    -webkit-touch-callout: none;
    user-select: none;
  }
  .unit-hit:focus-visible {
    outline: 1.5px solid var(--color-line-bright);
    outline-offset: -1.5px;
  }

  :global(.unit + .unit),
  :global(.swipe-wrap + .swipe-wrap) {
    margin-top: 2px;
  }

  /* swipe-to-decommission (coarse pointer): the row slides left over a
     destructive action revealed behind it. */
  .swipe-wrap {
    position: relative;
    overflow: hidden;
    border-radius: 2px;
  }

  .reveal {
    position: absolute;
    inset: 0 0 0 auto;
    width: var(--reveal); /* set from REVEAL_PX (swipe.ts) — single source of truth */
    display: flex;
    align-items: stretch;
    justify-content: stretch;
    background: color-mix(in srgb, var(--color-red) 16%, var(--color-panel));
  }

  .reveal .decom {
    flex: 1;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--color-red);
    font-family: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    line-height: 1.3;
    text-transform: uppercase;
    cursor: pointer;
    padding: 6px;
  }
  .reveal .decom.armed {
    background: color-mix(in srgb, var(--color-red) 26%, transparent);
    color: var(--color-ink-bright);
    font-weight: 600;
  }

  .slider {
    position: relative;
    background: var(--color-panel);
    /* vertical pans scroll the list natively; horizontal pans are ours */
    touch-action: pan-y;
    transition: transform 0.18s ease;
    will-change: transform;
  }
  .slider.dragging {
    transition: none;
  }

  .unit::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 1px;
    background: var(--rule, var(--color-faint));
    pointer-events: none;
  }

  .unit:hover {
    border-color: var(--color-line);
    background: var(--color-hover);
  }

  .unit.sel {
    border-color: var(--color-line-bright);
    background:
      radial-gradient(
        120% 140% at 0% 50%,
        color-mix(in srgb, var(--rule) 12%, transparent),
        transparent 70%
      ),
      var(--color-sel);
  }

  /* bracket corners on selected */
  .unit.sel::after {
    content: "";
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
    border-left: 0;
    border-top: 0;
    pointer-events: none;
  }

  .pip-col {
    grid-area: pip;
    display: flex;
    align-items: flex-start;
    padding-top: 5px;
  }

  .u-main {
    grid-area: main;
    min-width: 0;
  }

  .u-top {
    display: flex;
    align-items: baseline;
    gap: 0;
    min-width: 0;
  }

  /* configured project emoji standing in for the repo line */
  .name-icon {
    flex: none;
    margin-right: 6px;
    font-size: var(--fs-base);
  }
  /* interactive variant: the emoji toggles the repo filter — raised above the
     .unit-hit overlay (same pattern as the preview badge) so it's hover/clickable */
  .name-icon.actionable {
    position: relative;
    z-index: 1;
    cursor: pointer;
    padding: 0 3px;
    margin-left: -3px;
    border-radius: 2px;
  }
  .name-icon.actionable:hover {
    background: var(--color-hover);
  }
  .name-icon.actionable:focus-visible {
    outline: 1.5px solid var(--color-line-bright);
    outline-offset: 0;
  }
  /* Visually hidden but available to screen readers (matches GitRail.svelte) */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .name {
    color: var(--color-ink-bright);
    font-weight: 500;
    letter-spacing: 0.04em;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .u-repo {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 3px;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    letter-spacing: 0.04em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    max-width: 34ch;
  }
  .repo-glyph {
    /* Renders on every icon-less row regardless of status — amber here was the
       biggest remaining contributor to the "orange wall". Muted: it's a repo
       marker, not a state signal. */
    color: var(--color-muted);
    font-size: var(--fs-micro);
    flex-shrink: 0;
  }

  .u-sub {
    color: var(--color-muted);
    margin-top: 3px;
    font-size: var(--fs-base);
    line-height: 1.35;
    /* wrap to a 2nd line — fills the vertical space the right column
       (badge / elapsed / meta) already occupies, then ellipsis */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    max-width: 34ch;
  }

  /* Muted one-liner explaining why this session is parked / held.
     Shown only when a hold reason is present (server-set); mirrors the
     `.u-repo` density — same muted color and meta-size font, single line. */
  .u-hold {
    margin-top: 3px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.3;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    max-width: 34ch;
  }

  /* Live activity sub-line: the heartbeat strip. Quiet, single-line — the
     priority signal for a working row without adding a colored badge. */
  .u-activity {
    grid-area: act;
    display: flex;
    align-items: center;
    gap: 0;
    min-width: 0;
    /* stays on the meta rung: this is a dense single-line telemetry row (the
       heartbeat strip), not instructional prose — at --fs-base the act line
       grows taller and crowds the rail's row rhythm */
    font-size: var(--fs-meta);
    line-height: 1.3;
    color: var(--color-muted);
  }
  /* The heartbeat claims the whole activity line on every device. Scoped under
     .u-activity so the strip override can't leak to a future global .strip; kept
     before the narrow @container block so that block's 64px override still wins. */
  .u-activity :global(.strip) {
    flex: 1 1 auto;
    width: auto;
    max-width: none;
  }

  .car {
    color: var(--color-amber);
    /* functional in-progress motion — exempt from the reduced-motion blanket (app.css) */
    animation: blink 1.1s steps(1) infinite !important;
  }

  /* Cross-boundary hover reveal for the ✕ button inside UnitRowRight. The
     .row-decom lives in a child component so we use :global() to reach it. */
  @media (hover: hover) and (pointer: fine) {
    .unit:hover :global(.row-decom),
    .unit:focus-within :global(.row-decom) {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .meta {
    grid-area: meta;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .meta-text {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* amber "N manual steps" chip (#1059) — modeled on the epic .chip-migrations recipe; amber
     (--status-warn) reads as caution-pending, never the actionable-complete green. */
  .chip-manual-steps {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    padding: 1px 6px;
    border: 1px solid var(--status-warn);
    border-radius: 2px;
    color: var(--status-warn);
    background: color-mix(in oklab, var(--status-warn) 12%, transparent);
  }
  /* "Ack" CTA beside the manual-steps chip — warn-toned, micro, clears the auto-merge gate (#1060) */
  .manual-steps-ack {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--status-warn);
    border-radius: 2px;
    color: var(--status-warn);
    background: transparent;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s,
      background 0.12s;
  }
  .manual-steps-ack:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
    background: color-mix(in oklab, var(--status-warn) 12%, transparent);
  }
  .manual-steps-ack:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* thin stage stepper on the quietest row — pushed to the right edge */
  .meta-stepper {
    margin-left: auto;
    flex: none;
    display: inline-flex;
    align-items: center;
  }
  /* the task designation is metadata, not the human marker — demoted to the
     quietest spot, the bottom-right meta line, next to the session's model */
  .meta .desig {
    color: var(--color-faint);
    letter-spacing: 0.1em;
  }

  @media (max-width: 768px) {
    .unit {
      min-height: 44px;
    }
  }

  /* Touch devices at any width (landscape foldables, tablets) get the same
     44px row floor — the width-based rule above misses coarse pointers > 768px. */
  @media (pointer: coarse) {
    .unit {
      min-height: 44px;
    }
  }

  /* Compact sidebar (touch foldables, narrow picker): the meta footer already
     frees the name from the right rail; here we trade the 2nd prompt line for
     density so more agents stay visible without the card growing taller. */
  @container herd (max-width: 300px) {
    .unit {
      column-gap: 9px;
    }
    .u-sub {
      -webkit-line-clamp: 1;
      line-clamp: 1;
    }
    /* keep the heartbeat (tiny), drop the stepper so a narrow sidebar row stays
       dense and doesn't balloon */
    .meta-stepper {
      display: none;
    }
    /* the strip IS the heartbeat here — keep it, just narrower. Scoped under
       .u-activity so the override can't leak to a future global .strip. flex:none
       overrides the full-width grow above so the narrow strip stays at 64px. */
    .u-activity :global(.strip) {
      flex: none;
      width: 64px;
    }
  }

  /* Desktop Herd sidebar (never the mobile .units.flow list): drop the badge/
     status rail to its own full-width row beneath the name+prompt so a wide
     badge (e.g. the critic chip) can't crush the name to an ellipsis stub. The
     sidebar is always ≤360px (routes/+page.svelte .grid minmax(244,288)/(300,
     360)), so this is the sidebar's standing layout; the container query is a
     future-proof guard against any hypothetical wide non-flow herd. Scoped to
     :not(.flow) so the wider mobile flow list is genuinely untouched (no
     360-vs-375 cliff). */
  @container herd (max-width: 360px) {
    :global(.units:not(.flow)) .unit {
      grid-template-columns: 16px 1fr;
      grid-template-areas:
        "pip main"
        "pip right"
        "pip meta";
    }
    :global(.units:not(.flow)) .unit.has-activity {
      grid-template-areas:
        "pip main"
        "pip act"
        "pip right"
        "pip meta";
    }
    /* Reserve room on the name row so a long name ellipsizes BEFORE the clock
       rather than sliding under it (the clock still paints over the name —
       pointer-events stops event capture, not painting). 72px clears realistic
       elapsed() widths incl. the multi-day forms "29d 23h" / "100d 23h" (8
       tabular chars) + the right offset. elapsed() has no day cap, so a
       pathological 1000d+ run (9+ chars) would still overflow — accepted: such a
       session is unreachable in practice and it degrades gracefully (the name
       just paints under the clock, same tradeoff as everywhere else here). */
    :global(.units:not(.flow)) .u-top {
      padding-right: 72px;
    }
  }
</style>
