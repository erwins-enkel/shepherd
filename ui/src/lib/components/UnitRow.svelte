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
  import type { Session, GitState, SessionActivity } from "$lib/types";
  import {
    elapsed,
    STATUS_COLOR,
    statusLabel,
    hideStatusBadge,
    autopilotBadgeShown,
    canResume,
  } from "$lib/format";
  import { displayStatus } from "$lib/display-status";
  import { resumeSession } from "$lib/api";
  import CardMenu from "./CardMenu.svelte";
  import { longPress } from "./longpress";
  import { isMerging } from "./merge-train";
  import StatusPip from "./StatusPip.svelte";
  import PrBadge from "./PrBadge.svelte";
  import TimePopover from "./TimePopover.svelte";
  import CriticBadge from "./CriticBadge.svelte";
  import HeartbeatStrip from "./HeartbeatStrip.svelte";
  import Stepper from "./Stepper.svelte";
  import { reviews } from "$lib/reviews.svelte";
  import { toasts } from "$lib/toasts.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { m } from "$lib/paraglide/messages";
  import AutopilotBadge from "./AutopilotBadge.svelte";
  import PlanGateBadge from "./PlanGateBadge.svelte";
  import { onDestroy } from "svelte";
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
    repoFilter = null,
    onrepofilter,
    workingBlocked = {},
  }: {
    session: Session;
    selected: boolean;
    nowMs: number;
    onselect: (id: string) => void;
    git?: GitState;
    // live per-session signal (heartbeat + current tool summary); undefined until first event
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
    // active page-level repo filter (full repoPath); drives the icon's pressed state
    repoFilter?: string | null;
    // when provided, clicking the inline repo emoji toggles the repo filter:
    // a path sets it, null clears (same contract as QueueStrip's band toggle)
    onrepofilter?: (repoPath: string | null) => void;
    // working-while-blocked display flags (whole store map); feeds displayStatus only
    workingBlocked?: Record<string, boolean>;
  } = $props();

  // Every status-driven DISPLAY branch below reads this, not session.status: a
  // working-while-blocked session gets the full working treatment. Behavioral
  // reads (canResume) stay on the raw status.
  const dStatus = $derived(displayStatus(session, workingBlocked));

  // repo the unit works in — the last path segment of its repoPath (e.g. "community-map")
  const repoName = $derived(session.repoPath.split("/").filter(Boolean).at(-1) ?? session.repoPath);
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

  // live signals (heartbeat + current tool) only make sense while the agent works
  const live = $derived(dStatus === "running");
  // verbatim tool summary — NOT translated; shown as a quiet line when present
  const summary = $derived(activity?.summary?.trim() || null);
  // stepper conveys "how close to finishing" across the active lifecycle (not archived)
  const showStepper = $derived(
    dStatus === "running" || dStatus === "blocked" || dStatus === "done",
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
  let hitEl = $state<HTMLButtonElement>();
  let elapsedEl = $state<HTMLSpanElement>();
  let menu = $state<{ x: number; y: number; opener: HTMLElement } | null>(null);
  // Returns whether a menu actually opened (so the long-press can decide whether to
  // swallow the trailing tap). No-ops when nothing to offer or one is already open.
  function openMenuAt(x: number, y: number): boolean {
    if (menu || (!resumable && !ondecommission)) return false;
    menu = { x, y, opener: hitEl! };
    return true;
  }
  function onContextMenu(e: MouseEvent) {
    if (!resumable && !ondecommission) return; // nothing to offer → leave native menu
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
            class:filtered={repoFiltered}
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
    </div>

    <div class="u-right">
      {#if ondecommission && !coarse.current}
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
        <span
          class="preview-badge"
          class:preview-badge--degraded={previewServeFailed}
          role="button"
          tabindex="0"
          title={previewServeFailed
            ? m.unitrow_preview_badge_degraded()
            : m.unitrow_preview_badge()}
          onclick={(e) => {
            e.stopPropagation();
            onpreview?.(session.id);
          }}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onpreview?.(session.id);
            }
          }}>{m.unitrow_preview_badge()}</span
        >
      {/if}
      <PrBadge {git} />
      <CriticBadge sessionId={session.id} />
      <PlanGateBadge {session} />
      <!-- REVIEWING (in-flight critic) outranks the autopilot badge -->
      {#if !reviewing}<AutopilotBadge {session} />{/if}
      {#if isMerging(session, nowMs)}
        <span class="badge merging" id="u-status-{session.id}">{m.status_merging()}</span>
      {:else if session.readyToMerge}
        <span class="badge" id="u-status-{session.id}">{m.status_ready_to_merge()}</span>
      {:else if !hideStatus}
        <span class="badge" id="u-status-{session.id}">{statusLabel(dStatus)}</span>
      {/if}
      <span class="elapsed" bind:this={elapsedEl}>{elapsed(session.createdAt, nowMs)}</span>
    </div>

    {#if live}
      <div class="u-activity">
        <HeartbeatStrip {activity} {nowMs} />
        {#if summary}
          <span class="act-sep" aria-hidden="true">·</span>
          <span class="act-sum">{summary}</span>
        {/if}
      </div>
    {/if}

    <span class="meta">
      <span class="meta-text"
        ><span class="desig">{session.desig}</span> · {session.model ??
          m.newtask_model_default()}</span
      >
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

  /* Raise the interactive badge above the overlay so it's clickable. */
  .u-right > :global(button),
  .u-right > :global([role="button"]) {
    position: relative;
    z-index: 1;
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
  /* active filter: a quiet amber underline marks the icon as the engaged toggle
     (matches the .fbtn active accent in the herd head) without adding a new hue */
  .name-icon.actionable.filtered {
    box-shadow: 0 1px 0 0 var(--color-amber);
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

  /* Live activity sub-line: heartbeat + verbatim current-tool summary. Quiet,
     single-line, ellipsized — the priority signal for a working row without
     adding a colored badge. */
  .u-activity {
    grid-area: act;
    display: flex;
    align-items: center;
    gap: 0;
    min-width: 0;
    /* stays on the meta rung: this is a dense single-line telemetry row (heartbeat
       strip + verbatim tool snippet on hover), not instructional prose — at
       --fs-base the act line grows taller and crowds the rail's row rhythm */
    font-size: var(--fs-meta);
    line-height: 1.3;
    color: var(--color-muted);
  }
  /* The heartbeat is the priority glance signal, so on EVERY device it claims
     the whole activity line by default and the verbatim current-tool summary is
     hidden. Touch ends here: full-width strip, no command (there's no hover to
     tuck a snippet behind). Hover devices get the command back as an inline
     reveal (see @media below). Scoped under .u-activity so the strip override
     can't leak to a future global .strip; kept before the narrow @container
     block so that block's 64px override still wins. */
  .u-activity :global(.strip) {
    flex: 1 1 auto;
    width: auto;
    max-width: none;
  }
  .act-sep {
    color: var(--color-faint);
    flex: none;
    display: none;
  }
  .act-sum {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    display: none;
  }

  /* Hover/pointer devices: bring the demoted command back as a hover/focus
     reveal — it expands inline while the strip yields width to it (flex), so the
     line never grows taller. */
  @media (hover: hover) {
    .act-sum {
      display: inline;
      max-width: 0;
      opacity: 0;
      transition:
        max-width 0.18s ease,
        opacity 0.14s ease;
    }
    .unit:hover .act-sep,
    .unit:focus-within .act-sep {
      display: inline;
      margin: 0 5px;
    }
    .unit:hover .act-sum,
    .unit:focus-within .act-sum {
      max-width: 34ch;
      opacity: 1;
    }
  }

  .car {
    color: var(--color-amber);
    /* functional in-progress motion — exempt from the reduced-motion blanket (app.css) */
    animation: blink 1.1s steps(1) infinite !important;
  }

  .u-right {
    grid-area: right;
    text-align: right;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-end;
    flex-shrink: 0;
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
  @media (hover: hover) and (pointer: fine) {
    .unit:hover .row-decom,
    .unit:focus-within .row-decom {
      opacity: 1;
      pointer-events: auto;
    }
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

  .elapsed {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.08em;
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
    /* keep the heartbeat (tiny), drop the verbatim summary + separator and the
       stepper so a narrow sidebar row stays dense and doesn't balloon */
    .act-sum,
    .act-sep,
    .meta-stepper {
      display: none;
    }
    /* the hover-reveal block above un-hides the separator on :hover/:focus with
       higher specificity (0,3,0 > 0,1,0); re-suppress it here (same specificity,
       later in source → wins) so a hovered narrow row doesn't show a dangling
       "·" with no summary after it. */
    .unit:hover .act-sep,
    .unit:focus-within .act-sep {
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
</style>
