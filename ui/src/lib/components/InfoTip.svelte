<script lang="ts">
  import { getContext } from "svelte";
  import { anchorPopover } from "$lib/floating-anchor";
  import { infoTips, INFO_TIPS_FORCE } from "$lib/info-tips.svelte";

  // A small circular "i" affordance that reveals an explanation in a floating
  // tooltip — opens above the icon on hover/focus (fine pointer) and tap-toggles
  // on touch (coarse pointer). Reuses the native-popover + Floating UI pattern
  // from GlossaryTerm so the explanation escapes overflow-clipped containers and
  // never reserves vertical space inline (the point: keep dense forms compact,
  // especially on phones). Text-only content — no interactive children — so it is
  // a non-blocking role="tooltip" and warrants no scrim (exempt per CLAUDE.md).
  //
  // `prominent` bumps the resting glyph one step brighter (muted → ink) for hosts where
  // the icon must actively invite discovery — e.g. the Herd stage headers, where a
  // newcomer needs to notice the affordance. Default off: every existing site is unchanged.
  let {
    text,
    label,
    prominent = false,
  }: { text: string; label: string; prominent?: boolean } = $props();

  // Operator opt-out (Settings → Device). The /design-system catalogue forces specimens to
  // render regardless, so the component reference never lies about what a component looks like.
  const forced = getContext<boolean>(INFO_TIPS_FORCE) ?? false;
  const suppressed = $derived(infoTips.hidden && !forced);

  // SSR-stable, per-instance id for the aria-describedby wiring.
  const tooltipId = $props.id();

  let open = $state(false);
  let btnEl = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLElement | null>(null);

  function isCoarse(): boolean {
    return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  }

  // Position the popover above the button whenever open + both elements exist.
  $effect(() => {
    if (!open || !btnEl || !popEl) return;
    try {
      popEl.showPopover();
    } catch {
      return; // not connected this tick — effect re-runs once popEl mounts
    }
    return anchorPopover(btnEl, popEl, 6, "top");
  });

  // Dismiss on Esc, outside pointerdown, and scroll/resize. Listener attach is
  // deferred one tick so the opening tap doesn't immediately close it.
  $effect(() => {
    if (!open) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") open = false;
    }
    function onPointerdown(e: PointerEvent) {
      if (
        popEl &&
        !popEl.contains(e.target as Node) &&
        btnEl &&
        !btnEl.contains(e.target as Node)
      ) {
        open = false;
      }
    }
    function onScrollOrResize() {
      open = false;
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

  // Desktop (fine pointer): hover/focus open, immediate close on leave/blur — the
  // tooltip carries no interactive children, so no hover-bridge grace is needed.
  function onPointerenter(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    open = true;
  }
  function onPointerleave(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    open = false;
  }
  function onFocus() {
    if (isCoarse()) return;
    open = true;
  }
  function onBlur() {
    if (isCoarse()) return;
    open = false;
  }

  // Touch (coarse pointer): tap-toggle. Stop propagation so a tap on the icon
  // inside a <label> doesn't also toggle the checkbox the label wraps.
  function onClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!isCoarse()) return;
    open = !open;
  }
</script>

{#if !suppressed}
  <button
    bind:this={btnEl}
    class={["info", { open, prominent }]}
    type="button"
    aria-label={label}
    aria-describedby={tooltipId}
    onpointerenter={onPointerenter}
    onpointerleave={onPointerleave}
    onfocus={onFocus}
    onblur={onBlur}
    onclick={onClick}
  >
    <span aria-hidden="true">i</span>
  </button>

  <!-- popover="manual": native top-layer, escapes overflow:hidden containers.
       position:fixed + inset:auto + margin:0 so Floating UI's left/top drive placement. -->
  <div id={tooltipId} bind:this={popEl} class="info-tooltip" role="tooltip" popover="manual">
    {text}
  </div>
{/if}

<style>
  /* Clickable "ⓘ" — matches the AutomationPanel `.info` affordance. */
  .info {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    padding: 0;
    border: 1px solid var(--color-line);
    border-radius: 50%;
    background: transparent;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    font-style: italic;
    line-height: 1;
    cursor: help;
    touch-action: manipulation;
    /* The "i" glyph and tooltip prose must render verbatim even when a host header
       applies uppercase / letter-spacing (e.g. the Herd's `.micro` group headers) —
       otherwise the lowercase "i" would render as "I", diverging from every other site. */
    text-transform: none;
    letter-spacing: normal;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  /* Discovery-forward resting state (opt-in): brighter glyph + border so the affordance
     reads as intentional, without the loudness of the hover state. */
  .info.prominent {
    color: var(--color-ink);
    border-color: var(--color-faint);
  }
  .info:hover,
  .info.open {
    color: var(--color-ink-bright);
    border-color: var(--color-faint);
  }
  .info:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
  }

  /* Top-layer popover positioning: fixed + inset:auto + margin:0 lets Floating UI
     drive left/top without fighting browser default centering. */
  [popover].info-tooltip {
    position: fixed;
    inset: auto;
    margin: 0;
    width: min(260px, 90vw);
    padding: 8px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: var(--shadow-popover);
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    line-height: 1.5;
    /* Prose, not chrome: neutralize any inherited uppercase/tracking from the host
       (e.g. a `.micro` header) so the explanation reads as a normal sentence. */
    text-transform: none;
    letter-spacing: normal;
  }

  /* Entrance animation. The global blanket in app.css suppresses this under
     prefers-reduced-motion via animation:none !important — no extra rule needed. */
  @keyframes info-in {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  [popover].info-tooltip:popover-open {
    animation: info-in 120ms ease-out;
  }
</style>
