<script lang="ts">
  import type { Session, GitState } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { issueRef } from "$lib/issue-ref.svelte";
  import { issuePeek } from "$lib/issue-peek.svelte";
  import { anchorPopover } from "$lib/floating-anchor";
  import IssuePeekCard from "./IssuePeekCard.svelte";

  let { session, git = undefined }: { session: Session; git?: GitState } = $props();

  // Read into a local so the message calls below see a non-null number.
  const number = $derived(session.issueNumber);
  const launchIssue = $derived(session.launchMetadata?.issue ?? null);
  // Three paths write the same semantic URL and none is a single source of truth:
  // launch metadata (recorded at spawn, present the moment the card renders), the live
  // GitState (server-derived from the forge web URL, so it also covers rows predating
  // launch metadata), and the Done-list mirror for archived sessions.
  const href = $derived(launchIssue?.url ?? git?.issueUrl ?? session.issueUrl ?? null);

  // No web forge for this repo (local mode) ⇒ nothing to open and nothing to fetch, so
  // the chip stays exactly what it was before: a plain, non-interactive identifier that
  // does NOT sit above the card's `.unit-hit` overlay. Raising a chip that can't act on a
  // click is what would turn it into a dead zone mid-rail — the trade #2249 refused. Here
  // the click HAS a target, which is what re-opens the door.
  const interactive = $derived(href != null);

  const popoverId = $props.id();
  let open = $state(false);
  let anchorEl = $state<HTMLElement | null>(null);
  let popEl = $state<HTMLElement | null>(null);
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  // Whether the gesture that produced the pending click came from a finger. Read off the
  // event rather than a `(pointer: coarse)` media query: a hybrid laptop answers the query
  // for its trackpad and would lose the two-step tap on its own touchscreen.
  let lastPointerTouch = false;

  /** Hover intent. Long enough that sweeping the pointer across a herd opens nothing —
   *  each open costs the server a forge read — short enough that aiming at the chip feels
   *  immediate. (The card's wall-clock popover waits 450ms because its trigger is a
   *  region of the whole card; a chip is a deliberate target.) */
  const OPEN_DELAY_MS = 350;
  /** Grace for the pointer to cross the gap into the panel, as in statusTip. */
  const CLOSE_GRACE_MS = 140;

  const entry = $derived(number != null ? issuePeek.get(session.repoPath, number) : null);

  function openNow() {
    clearTimeout(openTimer);
    openTimer = undefined;
    clearTimeout(closeTimer);
    closeTimer = undefined;
    if (open || number == null) return;
    open = true;
    issuePeek.request(session.repoPath, number);
  }
  function scheduleOpen() {
    clearTimeout(openTimer);
    openTimer = setTimeout(openNow, OPEN_DELAY_MS);
  }
  function closeNow() {
    clearTimeout(openTimer);
    openTimer = undefined;
    clearTimeout(closeTimer);
    closeTimer = undefined;
    open = false;
  }
  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeNow, CLOSE_GRACE_MS);
  }

  // Position the panel under the chip while open. The card clips (`overflow:hidden`) and
  // the swipe slider carries a transform, so only the native popover's top layer gets the
  // panel out intact — same pattern as InfoTip / GlossaryTerm.
  $effect(() => {
    if (!open || !anchorEl || !popEl) return;
    try {
      popEl.showPopover();
    } catch {
      return; // not connected this tick — the effect re-runs once popEl mounts
    }
    return anchorPopover(anchorEl, popEl, 6);
  });

  // Dismiss on Esc, outside pointerdown, scroll and resize. Attachment is deferred one
  // tick so the tap that opened it doesn't immediately close it again.
  $effect(() => {
    if (!open) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") closeNow();
    }
    function onPointerdown(e: PointerEvent) {
      const t = e.target as Node;
      if (anchorEl?.contains(t) || popEl?.contains(t)) return;
      closeNow();
    }
    function onScrollOrResize() {
      closeNow();
    }
    const tid = setTimeout(() => {
      window.addEventListener("keydown", onKeydown);
      window.addEventListener("pointerdown", onPointerdown);
      window.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
      window.addEventListener("resize", onScrollOrResize, { passive: true });
    }, 0);
    return () => {
      clearTimeout(tid);
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointerdown);
      window.removeEventListener("scroll", onScrollOrResize, { capture: true });
      window.removeEventListener("resize", onScrollOrResize);
    };
  });

  $effect(() => () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
  });

  function onPointerenter(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    scheduleOpen();
  }
  function onPointerleave(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    clearTimeout(openTimer);
    openTimer = undefined;
    scheduleClose();
  }
  function onPointerdown(e: PointerEvent) {
    lastPointerTouch = e.pointerType === "touch";
  }
  function onFocus() {
    // Keyboard arrival only: a mouse click also focuses the link, and opening a preview
    // in the tab being left behind is noise.
    if (anchorEl?.matches(":focus-visible")) openNow();
  }
  function onClick(e: MouseEvent) {
    // The row-select overlay is a sibling, not an ancestor, so this is belt-and-braces —
    // but every other raised chip on this card stops propagation, and a future delegated
    // handler must not turn "open my issue" into "open my session".
    e.stopPropagation();
    // Touch has no hover, so the first tap stands in for one: show the preview instead of
    // navigating. The second tap falls through to the link.
    if (lastPointerTouch && !open) {
      e.preventDefault();
      openNow();
    }
  }
</script>

{#if number != null && issueRef.shown}
  {#if interactive}
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
    <a
      bind:this={anchorEl}
      class="issue-badge interactive"
      href={href ?? undefined}
      target="_blank"
      rel="noopener"
      aria-label={m.issuebadge_open_label({ number })}
      aria-describedby={popoverId}
      onpointerenter={onPointerenter}
      onpointerleave={onPointerleave}
      onpointerdown={onPointerdown}
      onfocus={onFocus}
      onblur={closeNow}
      onclick={onClick}>#{number}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  {:else}
    <span
      class="issue-badge"
      role="img"
      aria-label={m.issuebadge_label({ number })}
      title={m.issuebadge_title({ number })}>#{number}</span
    >
  {/if}

  <!-- popover="manual": native top layer, so the panel escapes the card's clipping and the
       swipe slider's transform. Content mounts only while open, so closed previews leave no
       stray text in the DOM for queries or assistive tech to trip over. -->
  <div
    bind:this={popEl}
    id={popoverId}
    class="issue-peek"
    role="tooltip"
    popover="manual"
    onpointerenter={(e) => {
      if (e.pointerType !== "touch") clearTimeout(closeTimer);
    }}
    onpointerleave={(e) => {
      if (e.pointerType !== "touch") scheduleClose();
    }}
  >
    {#if open}
      <IssuePeekCard {number} fallbackTitle={launchIssue?.title ?? null} {entry} />
    {/if}
  </div>
{/if}

<style>
  /* Quiet identifier chip, deliberately the same recipe as the open-PR badge it sits beside
     (--color-line border, --color-muted ink, no hue): issue and PR are the two forge
     references a card carries, and they should read as one pair. Accent hues stay reserved
     for state that wants acting on. No `text-transform`: the value is a bare number, so
     there is no casing to normalise. */
  .issue-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    white-space: nowrap;
    font-weight: 600;
  }

  /* Clickable variant: raised above the card's full-area `.unit-hit` overlay so hover and
     click reach the chip. Deliberately NO new hue — the chip stays as quiet at rest as it
     was; only the cursor and a one-step lift on hover/focus say it can be opened. */
  .issue-badge.interactive {
    position: relative;
    z-index: 1;
    display: inline-block;
    text-decoration: none;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  .issue-badge.interactive:hover,
  .issue-badge.interactive:focus-visible {
    color: var(--color-ink-bright);
    border-color: var(--color-faint);
  }
  .issue-badge.interactive:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
  }

  /* Top-layer popover positioning: fixed + inset:auto + margin:0 so Floating UI drives
     left/top without fighting the browser's default centering. Panel chrome matches the
     backlog's issue preview (IssueDetailsPopover) — one issue-preview look, two triggers. */
  [popover].issue-peek {
    position: fixed;
    inset: auto;
    margin: 0;
    width: min(360px, calc(100vw - 16px));
    padding: 10px 12px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    box-shadow: var(--shadow-popover);
    color: var(--color-ink);
    font: inherit;
  }
  /* The global prefers-reduced-motion blanket in app.css suppresses this. */
  @keyframes peek-in {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  [popover].issue-peek:popover-open {
    animation: peek-in 120ms ease-out;
  }
</style>
