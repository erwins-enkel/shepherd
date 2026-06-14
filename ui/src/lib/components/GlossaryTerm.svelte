<script lang="ts">
  import { anchorPopover } from "$lib/floating-anchor";
  import { m } from "$lib/paraglide/messages";
  import { getLocale } from "$lib/i18n";
  import { glossaryById } from "$lib/glossary";

  let { id, label }: { id: string; label: string } = $props();

  // Stable unique id for aria-describedby wiring — crypto/Math.random-free counter.
  let _counter = 0;
  function nextId() {
    return ++_counter;
  }
  const tooltipId = `gloss-tip-${nextId()}`;

  const term = $derived(glossaryById.get(id));

  let open = $state(false);
  let btnEl = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLElement | null>(null);

  // Detect touch (coarse pointer) — determines open strategy.
  // We check at pointer event time too (pointerType === "touch") for accuracy,
  // but a module-level media query covers the button enter/leave handlers.
  function isCoarse(): boolean {
    return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  }

  // Floating UI: position popover relative to button whenever open + both elements exist.
  $effect(() => {
    if (!open || !btnEl || !popEl) return;

    try {
      popEl.showPopover();
    } catch {
      // Element not ready this tick — effect re-runs once popEl is connected.
      return;
    }

    return anchorPopover(btnEl, popEl, 6);
  });

  // Dismiss on Esc, outside pointerdown, and scroll/resize (capture phase).
  // Listener attach deferred by one tick so the opening tap doesn't immediately
  // close the tooltip (mirrors Coachmark.svelte:85-97).
  $effect(() => {
    if (!open) return;

    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onPointerdown(e: PointerEvent) {
      if (
        popEl &&
        !popEl.contains(e.target as Node) &&
        btnEl &&
        !btnEl.contains(e.target as Node)
      ) {
        close();
      }
    }
    function onScrollOrResize() {
      close();
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

  function openTooltip() {
    open = true;
  }

  function close() {
    open = false;
  }

  // Desktop (fine pointer): hover open/close.
  function onPointerenter(e: PointerEvent) {
    if (e.pointerType === "touch") return; // coarse — handled by click
    openTooltip();
  }
  function onPointerleave(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    close();
  }

  // Desktop: focus open/close.
  function onFocus() {
    if (isCoarse()) return;
    openTooltip();
  }
  function onBlur(e: FocusEvent) {
    if (isCoarse()) return;
    // Don't close if focus moved into the tooltip (e.g. keyboard Tab to the Wikipedia link).
    if (popEl?.contains(e.relatedTarget as Node)) return;
    close();
  }

  // Wikipedia link blur — close only when focus leaves both the popover and the trigger button.
  function onWikiBlur(e: FocusEvent) {
    const target = e.relatedTarget as Node | null;
    if (popEl?.contains(target) || btnEl?.contains(target)) return;
    close();
  }

  // Touch (coarse pointer): tap-toggle.
  function onClick(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    // Only toggle on coarse — fine pointer already handled by hover/focus.
    if (!isCoarse()) return;
    e.stopPropagation();
    if (open) {
      close();
    } else {
      openTooltip();
    }
  }

  // Wikipedia link helpers.
  const wikiLang = $derived(getLocale() === "de" ? "de" : "en");
  const wikiSlug = $derived(term?.wikipedia ? term.wikipedia[wikiLang] : null);
  const wikiHref = $derived(wikiSlug ? `https://${wikiLang}.wikipedia.org/wiki/${wikiSlug}` : null);
</script>

<!--
  If the term is unknown (fail-soft), render the plain label with no tooltip.
-->
{#if !term}
  <span class="gloss-term-plain">{label}</span>
{:else}
  <button
    bind:this={btnEl}
    class="gloss-term"
    type="button"
    aria-describedby={tooltipId}
    onpointerenter={onPointerenter}
    onpointerleave={onPointerleave}
    onfocus={onFocus}
    onblur={(e) => onBlur(e)}
    onclick={onClick}>{label}</button
  >

  <!-- popover="manual": native top-layer, escapes overflow:hidden containers.
       position:fixed + inset:auto + margin:0 so Floating UI's left/top drive placement.
       Non-blocking anchored popover — no scrim (exempt per CLAUDE.md).
       role="dialog" (without aria-modal) for external terms that contain a link;
       role="tooltip" for internal-only terms that contain no interactive children. -->
  <div
    id={tooltipId}
    bind:this={popEl}
    class="gloss-tooltip"
    role={term.kind === "external" ? "dialog" : "tooltip"}
    aria-label={term.kind === "external" ? label : undefined}
    popover="manual"
  >
    <p class="gt-body">{(m as unknown as Record<string, () => string>)[term.bodyKey]()}</p>
    {#if term.kind === "external" && wikiHref}
      <!-- eslint-disable svelte/no-navigation-without-resolve -- external Wikipedia URL -->
      <a
        class="gt-wiki"
        href={wikiHref}
        target="_blank"
        rel="noopener noreferrer"
        onblur={onWikiBlur}
        >{(m as unknown as Record<string, () => string>)["gloss_wikipedia_link"]()}</a
      >
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {/if}
  </div>
{/if}

<style>
  /* Inline trigger — inherits parent text size and color. */
  .gloss-term {
    display: inline;
    padding: 0;
    margin: 0;
    background: transparent;
    border: none;
    font: inherit;
    color: var(--color-ink);
    text-decoration: underline dashed;
    text-decoration-color: var(--color-line-bright);
    text-underline-offset: 3px;
    cursor: help;
    touch-action: manipulation;
  }

  .gloss-term:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
    border-radius: 1px;
  }

  /* Plain-text fallback for unknown term ids. */
  .gloss-term-plain {
    display: inline;
  }

  /* Top-layer popover positioning: fixed + inset:auto + margin:0 lets
     Floating UI drive left/top without fighting browser default centering. */
  [popover].gloss-tooltip {
    position: fixed;
    inset: auto;
    margin: 0;

    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    width: min(260px, 90vw);

    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);

    /* Reset browser popover defaults */
    color: var(--color-ink);
    font: inherit;
  }

  .gt-body {
    margin: 0;
    font-size: var(--fs-base);
    line-height: 1.5;
  }

  .gt-wiki {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    opacity: 0.75;
  }

  .gt-wiki:hover {
    opacity: 1;
  }

  /* Entrance animation. The global blanket in app.css suppresses this with
     animation:none !important under prefers-reduced-motion — no extra rule needed. */
  @keyframes gloss-in {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  [popover].gloss-tooltip:popover-open {
    animation: gloss-in 120ms ease-out;
  }
</style>
