<script lang="ts">
  import { formatAgo } from "$lib/format";
  import { bucketStrip } from "$lib/heartbeat";
  import { anchorPopover } from "$lib/floating-anchor";
  import { m } from "$lib/paraglide/messages";
  import type { SessionActivity } from "$lib/types";

  let {
    activity,
    nowMs,
    onactivate,
  }: {
    activity?: SessionActivity;
    nowMs: number;
    // Activating the strip (click / Enter / Space) selects the row — same action as
    // the card's primary .unit-hit button. Raising the strip above .unit-hit to catch
    // hover would otherwise leave a dead click zone; forwarding the click keeps
    // "click anywhere on the card selects it" intact. Optional so the component stays
    // usable standalone (tests / stories).
    onactivate?: () => void;
  } = $props();

  // Bucket against nowMs (not the server's push time) so the strip ages/drains live.
  const cells = $derived(bucketStrip(activity?.recentTs ?? [], activity?.recentErrTs ?? [], nowMs));

  // Recency phrasing; "starting" before the first beat. Reused as the tail of the
  // accessible name (not shown in the legend — TimePopover already carries recency).
  const label = $derived(
    activity && activity.lastActivityTs > 0
      ? m.activity_active({ ago: formatAgo(nowMs - activity.lastActivityTs) })
      : m.activity_starting(),
  );
  // The strip activates (selects the session), so its accessible name discloses that
  // — mirrors the Stepper's openLabel so a keyboard/SR user isn't told only the
  // recency and left guessing that the control opens the session.
  const openLabel = $derived(`${m.stepper_open_hint()} · ${label}`);

  // --- Encoding legend (native top-layer popover; desktop hover/focus only) ---
  // Same recipe as the Stepper stage legend: native popover="manual" placed with
  // Floating UI so it escapes the card's overflow clipping.
  const popId = $props.id();
  let open = $state(false);
  let stripEl = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLElement | null>(null);

  const isCoarse = () =>
    typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

  // Fine pointer: hover opens. Touch pointerenter is skipped so a tap just selects
  // the row (no tap-toggle) rather than popping a desktop tooltip.
  function onEnter(e: PointerEvent) {
    if (e.pointerType !== "touch") open = true;
  }
  // Focus opens on fine pointers only (a touch tap also focuses the button).
  function onOpen() {
    if (!isCoarse()) open = true;
  }
  function onClose() {
    open = false;
  }

  // Position the popover above the strip whenever open + both elements exist.
  $effect(() => {
    if (!open || !stripEl || !popEl) return;
    try {
      popEl.showPopover();
    } catch {
      return; // not connected this tick — effect re-runs once popEl mounts
    }
    return anchorPopover(stripEl, popEl, 6, "top");
  });

  // Dismiss on Esc, outside pointerdown, and scroll/resize (mirrors Stepper/InfoTip).
  $effect(() => {
    if (!open) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") open = false;
    }
    function onPointerdown(e: PointerEvent) {
      if (
        popEl &&
        !popEl.contains(e.target as Node) &&
        stripEl &&
        !stripEl.contains(e.target as Node)
      ) {
        open = false;
      }
    }
    function onScrollOrResize() {
      open = false;
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointerdown", onPointerdown);
    window.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
    window.addEventListener("resize", onScrollOrResize, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointerdown);
      window.removeEventListener("scroll", onScrollOrResize, { capture: true });
      window.removeEventListener("resize", onScrollOrResize);
    };
  });
</script>

<!-- A real <button> (not a role=img span): hover/focus reveals the legend,
     click/Enter/Space selects the row. Raised above the .unit-hit overlay so it
     actually receives the pointer/focus. -->
<button
  type="button"
  class="strip"
  aria-label={openLabel}
  aria-describedby={popId}
  bind:this={stripEl}
  onpointerenter={onEnter}
  onpointerleave={onClose}
  onfocus={onOpen}
  onblur={onClose}
  onclick={() => onactivate?.()}
>
  {#each cells as cell, i (i)}
    <span
      class="cell"
      class:err={cell.error}
      class:now={cell.now}
      data-level={cell.level}
      aria-hidden="true"
    ></span>
  {/each}
</button>
<!-- role=tooltip so aria-describedby surfaces the legend to screen readers.
     popover=manual: native top-layer, escapes the card's overflow:hidden. A <span>
     (phrasing) so it stays valid wherever the strip is embedded; every child is a span. -->
<span id={popId} bind:this={popEl} class="legend" role="tooltip" popover="manual">
  <span class="lg-intro">{m.heartbeat_pop_intro()}</span>
  <span class="lg-row">
    <span class="sw"><span class="cell" data-level="4" aria-hidden="true"></span></span>
    <span class="lg-text">
      <span class="lg-label">{m.heartbeat_legend_active_label()}</span>
      <span class="lg-desc">{m.heartbeat_legend_active_desc()}</span>
    </span>
  </span>
  <span class="lg-row">
    <span class="sw idle"><span class="cell" data-level="0" aria-hidden="true"></span></span>
    <span class="lg-text">
      <span class="lg-label">{m.heartbeat_legend_idle_label()}</span>
      <span class="lg-desc">{m.heartbeat_legend_idle_desc()}</span>
    </span>
  </span>
  <span class="lg-row">
    <span class="sw"><span class="cell err" aria-hidden="true"></span></span>
    <span class="lg-text">
      <span class="lg-label">{m.heartbeat_legend_error_label()}</span>
      <span class="lg-desc">{m.heartbeat_legend_error_desc()}</span>
    </span>
  </span>
</span>

<style>
  /* 24 equal cells; amber (--status-running) for live/recent signal (level ≥ 2
     and .now); low-activity cells (level 0–1) render neutral faint ink so idle
     strips read grey, not orange — amber is reserved for genuine "alive" signal.
     No motion — StatusPip already pulses (matches prior Heartbeat.svelte decision).

     Now a <button>: button reset (mirrors the Stepper's .stepper) plus the raise
     above .unit-hit (z-index:1) so hover/focus land on the strip. Deliberately NO
     ::before hit-halo: the strip is already a full-width, 12px-tall target, and it
     sits one 3px-gap row below .hold-cta (downward halo) and above the Stepper
     (upward halo) — a vertical bleed would poach their hit zones. */
  .strip {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: stretch;
    gap: 1px;
    width: 132px;
    max-width: 40vw;
    height: 12px;
    flex: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: help;
  }
  .strip:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
    border-radius: 2px;
  }
  .cell {
    flex: 1 1 0;
    border-radius: 1px;
    background: currentColor;
    /* faint neutral track by default; live cells (level ≥ 2 / now) re-set amber below */
    color: var(--color-faint);
    opacity: 0.12; /* level 0 = faint empty track */
  }
  .cell[data-level="1"] {
    color: var(--color-faint);
    opacity: 0.35;
  }
  /* level ≥ 2 is genuine activity — restore amber over the faint base so the
     live signal still glows while the empty track + trickle stay grey. */
  .cell[data-level="2"] {
    color: var(--status-running);
    opacity: 0.6;
  }
  .cell[data-level="3"] {
    color: var(--status-running);
    opacity: 0.82;
  }
  .cell[data-level="4"] {
    color: var(--status-running);
    opacity: 1;
  }
  .cell.now {
    color: var(--status-running);
    opacity: 1;
  }
  /* an errored slice (always level ≥ 1) renders red instead of amber. A
     non-color cue rides alongside the hue (WCAG 1.4.1): the cell is rendered
     as a shorter bottom-anchored stub (~55% of full height), so an error reads
     as a "dropped" bar with a gap along the top edge of the strip. This
     silhouette difference remains perceptible even at ~1.7px cell width
     (collapsed strip in UnitRow) because it is an edge/outline difference, not
     an interior detail, and it does not collide with the opacity-based recency
     encoding (every normal cell is full height regardless of level). */
  .cell.err {
    color: var(--color-red);
    opacity: 0.85;
    align-self: flex-end;
    height: 55%;
  }

  /* Top-layer legend positioning: fixed + inset:auto + margin:0 lets Floating UI
     drive left/top without fighting browser default centering. Mirrors the
     Stepper stage-legend recipe. */
  [popover].legend {
    position: fixed;
    inset: auto;
    margin: 0;
    z-index: 30;
    width: min(300px, 92vw);
    gap: 6px;
    padding: 6px 8px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: var(--shadow-popover);
    font-size: var(--fs-meta);
    line-height: 1.4;
    text-align: left;
  }
  [popover].legend:popover-open {
    display: flex;
    flex-direction: column;
  }
  .lg-intro {
    color: var(--color-muted);
  }
  .lg-row {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: start;
    gap: 8px;
  }
  .lg-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .lg-label {
    color: var(--color-ink);
  }
  .lg-desc {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    line-height: 1.35;
  }
  /* Legend swatch: reconstruct the strip's flex/height context around a single
     .cell so .cell.err (align-self:flex-end; height:55%) shows its stub and the
     faint idle cell renders exactly as on the strip — no separate swatch styling
     that could drift from the real encoding. Nudged down to align with the label. */
  .sw {
    display: inline-flex;
    align-items: stretch;
    height: 12px;
    width: 14px;
    margin-top: 2px;
    flex: none;
  }
  /* The idle cell is intentionally near-invisible (opacity 0.12); give its swatch a
     hairline track so "Idle" is still legible as an empty slot in the legend. */
  .sw.idle {
    box-shadow: inset 0 0 0 1px var(--color-line);
    border-radius: 1px;
  }
</style>
