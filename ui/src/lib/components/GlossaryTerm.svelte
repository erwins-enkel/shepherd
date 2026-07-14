<script lang="ts">
  import { getContext } from "svelte";
  import { anchorPopover } from "$lib/floating-anchor";
  import { m } from "$lib/paraglide/messages";
  import { getLocale } from "$lib/i18n";
  import { glossaryById } from "$lib/glossary";
  import { infoTips, INFO_TIPS_FORCE } from "$lib/info-tips.svelte";

  let { id, label }: { id: string; label: string } = $props();

  // The /design-system catalogue forces specimens to render regardless of the preference.
  const forced = getContext<boolean>(INFO_TIPS_FORCE) ?? false;
  // When the operator hides info tips, a term degrades to the same plain-label output the
  // unknown-term fail-soft path already produces: the word stays in the sentence, but the
  // trigger button, dashed underline and tooltip are gone. For an `external` term that
  // also removes its Wikipedia link — an accepted consequence of "remove the affordance
  // entirely" (keeping underlines alive only for external terms would be incoherent).
  const suppressed = $derived(infoTips.hidden && !forced);

  // Unique, SSR-stable id for aria-describedby wiring — Svelte's per-instance id
  // (a module counter would collide across instances and risk hydration mismatch).
  const tooltipId = $props.id();

  const term = $derived(glossaryById.get(id));

  // Definition body text, resolved from the term's message key. Computed here (not in
  // the shared snippet) so the snippet never has to narrow the possibly-undefined term.
  const bodyText = $derived(
    term ? (m as unknown as Record<string, () => string>)[term.bodyKey]() : "",
  );

  let open = $state(false);
  // Presentation is chosen per interaction at open time: mouse-hover → "floating"
  // (transient anchored popover), activation (click / tap / Enter / Space) → "inline"
  // (in-flow disclosure that pushes content down, never obscures). Bare focus opens
  // nothing. Per-interaction (not per-device) so detection can't misfire.
  let presentation = $state<"floating" | "inline">("floating");
  let btnEl = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLElement | null>(null);
  let inlineEl = $state<HTMLElement | null>(null);

  // Floating UI: position popover relative to button whenever open + both elements exist.
  $effect(() => {
    if (presentation !== "floating" || !open || !btnEl || !popEl) return;

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
      // Test whichever panel is currently mounted (floating div XOR inline span),
      // not a stale popEl — otherwise an outside tap in inline mode never closes.
      const panel = popEl ?? inlineEl;
      if (
        panel &&
        !panel.contains(e.target as Node) &&
        btnEl &&
        !btnEl.contains(e.target as Node)
      ) {
        close();
      }
    }
    function onScrollOrResize() {
      close();
    }

    // Scroll/resize re-home the anchored popover by closing it — only relevant to the
    // floating panel. The inline panel scrolls with content, so closing on scroll would
    // be hostile; skip those listeners for it.
    const floating = presentation === "floating";
    const tid = setTimeout(() => {
      window.addEventListener("keydown", onKeydown);
      window.addEventListener("pointerdown", onPointerdown);
      if (floating) {
        window.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
        window.addEventListener("resize", onScrollOrResize, { passive: true });
      }
    }, 0);

    return () => {
      clearTimeout(tid);
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointerdown);
      if (floating) {
        window.removeEventListener("scroll", onScrollOrResize, { capture: true });
        window.removeEventListener("resize", onScrollOrResize);
      }
    };
  });

  // Hover-bridge grace delay: pointer-leave schedules a close rather than closing
  // immediately, so the mouse can travel the gap from the trigger to the tooltip
  // (e.g. to click the Wikipedia link) without it vanishing mid-traverse.
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelScheduledClose() {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function scheduleClose() {
    cancelScheduledClose();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      open = false;
    }, 120);
  }

  // Clear any pending close timer on unmount.
  $effect(() => () => cancelScheduledClose());

  function openTooltip() {
    cancelScheduledClose();
    open = true;
  }

  function close() {
    cancelScheduledClose();
    open = false;
  }

  // Hover (non-touch): open floating tooltip. Don't override a pinned inline.
  function onPointerenter(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    if (open && presentation === "inline") return;
    presentation = "floating";
    openTooltip();
  }
  function onPointerleave(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    if (presentation !== "floating") return;
    scheduleClose();
  }

  // Keep the tooltip open while the mouse is over it, so its link stays clickable.
  function onTipPointerenter(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    cancelScheduledClose();
  }
  function onTipPointerleave(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    scheduleClose();
  }

  // Click / keyboard Enter / Space / touch tap → inline push-down.
  // A native <button> fires click for Enter (keydown) and Space (keyup) automatically.
  function onClick(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    e.stopPropagation();
    if (open && presentation === "inline") {
      close();
    } else {
      presentation = "inline";
      openTooltip();
    }
  }

  // Wikipedia link helpers.
  const wikiLang = $derived(getLocale() === "de" ? "de" : "en");
  const wikiSlug = $derived(term?.wikipedia ? term.wikipedia[wikiLang] : null);
  const wikiHref = $derived(wikiSlug ? `https://${wikiLang}.wikipedia.org/wiki/${wikiSlug}` : null);
</script>

<!--
  If the term is unknown (fail-soft) — or the operator hid info tips — render the plain
  label with no tooltip.
-->
{#if !term || suppressed}
  <span class="gloss-term-plain">{label}</span>
{:else}
  <button
    bind:this={btnEl}
    class="gloss-term"
    type="button"
    aria-describedby={presentation === "floating" ? tooltipId : undefined}
    aria-expanded={presentation === "inline" ? open : undefined}
    aria-controls={presentation === "inline" && open ? tooltipId : undefined}
    onpointerenter={onPointerenter}
    onpointerleave={onPointerleave}
    onclick={onClick}>{label}</button
  >

  <!-- Shared definition body, rendered by both presentation branches below.
       .gt-body is a <span> (display:block), never a <p>: the inline branch lives inside
       a heading <p>, where a nested <p> start tag would auto-close the heading. -->
  {#snippet defBody()}
    <span class="gt-body">{bodyText}</span>
    {#if term?.kind === "external" && wikiHref}
      <!-- eslint-disable svelte/no-navigation-without-resolve -- external Wikipedia URL -->
      <a class="gt-wiki" href={wikiHref} target="_blank" rel="noopener noreferrer"
        >{(m as unknown as Record<string, () => string>)["gloss_wikipedia_link"]()}</a
      >
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {/if}
  {/snippet}

  {#if presentation === "floating"}
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
      onpointerenter={onTipPointerenter}
      onpointerleave={onTipPointerleave}
    >
      {@render defBody()}
    </div>
  {:else if open}
    <!-- Touch disclosure: an in-flow block that pushes content down instead of floating
         over it. A <span> (block via .gloss-inline) so it stays valid inside a heading <p>.
         role="dialog" for external terms (contain a link), role="note" for internal. -->
    <span
      id={tooltipId}
      bind:this={inlineEl}
      class="gloss-inline"
      role={term.kind === "external" ? "dialog" : "note"}
      aria-label={term.kind === "external" ? label : undefined}
    >
      {@render defBody()}
    </span>
  {/if}
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
    box-shadow: var(--shadow-popover);

    /* Reset browser popover defaults */
    color: var(--color-ink);
    font: inherit;
  }

  /* A closed manual popover must not render. The base rule's display:flex would
     otherwise override the UA closed-popover display:none, leaving the definition
     visibly pinned at its last anchored (or in-flow) position — the "auto-opens /
     won't-close" tooltip obscuring content. Sibling InfoTip avoids this by setting
     no base display at all; this guard restores the same closed-state behavior. */
  [popover].gloss-tooltip:not(:popover-open) {
    display: none;
  }

  .gt-body {
    display: block;
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 400;
    line-height: 1.5;
    /* Read as prose even when the marker sits on a section heading, whose
       uppercase / letter-spacing would otherwise be inherited into the definition
       (DOM inheritance reaches the popover's top-layer body too). */
    text-transform: none;
    letter-spacing: normal;
  }

  .gt-wiki {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    opacity: 0.75;
  }

  .gt-wiki:hover {
    opacity: 1;
  }

  /* Touch disclosure: in-flow block beneath the term (pushes content down rather than
     floating over it). Mirrors the floating tooltip's surface; the prose typography
     resets live on .gt-body so both presentations read as body text even when the
     marker sits on a section heading. */
  .gloss-inline {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 6px 0 2px;
    padding: 8px 10px;
    width: min(260px, 100%);

    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;

    color: var(--color-ink);
    font: inherit;
    text-align: left;

    animation: gloss-inline-in 120ms ease-out;
  }

  /* Suppressed by the global reduced-motion blanket in app.css. */
  @keyframes gloss-inline-in {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
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
