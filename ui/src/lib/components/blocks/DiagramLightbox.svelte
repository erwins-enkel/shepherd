<script lang="ts">
  // Near-fullscreen inspector for a rendered diagram SVG. Opens fit-to-screen
  // (scaled UP for small diagrams so they fill the table, fit-to-width with
  // scroll for large ones), then zoom + drag-to-pan to read fine labels.
  // The SVG arrives already rendered + themed from MermaidBlock; this component
  // only sizes and frames it. Blocking modal → scrim+blur, focus trap, Esc.
  import { dialog } from "$lib/a11yDialog";
  import { portal } from "$lib/portal";
  import { m } from "$lib/paraglide/messages";

  let { svg, title, onclose }: { svg: string; title?: string; onclose: () => void } = $props();

  let stage = $state<HTMLDivElement>();
  // Natural diagram dimensions, read from the SVG's viewBox once mounted.
  let natW = $state(0);
  let natH = $state(0);
  let scale = $state(1);

  const MIN = 0.1;
  const MAX = 8;
  const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));

  // Scale that makes the whole diagram fit the stage with a little breathing room.
  // No upper cap → a tiny graph scales up to fill the inspector (the point of "see it bigger").
  function fitScale() {
    if (!stage || !natW || !natH) return 1;
    const pad = 48;
    const w = Math.max(1, stage.clientWidth - pad);
    const h = Math.max(1, stage.clientHeight - pad);
    return clamp(Math.min(w / natW, h / natH));
  }

  function measure() {
    const el = stage?.querySelector("svg");
    if (!el) return;
    const vb = el.viewBox?.baseVal;
    const rect = el.getBoundingClientRect();
    natW = vb && vb.width ? vb.width : rect.width || 1;
    natH = vb && vb.height ? vb.height : rect.height || 1;
    // Hand sizing to our canvas wrapper: drop Mermaid's own width cap and let the
    // SVG fill the (scaled) canvas, preserving aspect ratio via its viewBox.
    el.style.maxWidth = "none";
    el.style.width = "100%";
    el.style.height = "100%";
    scale = fitScale();
  }

  // Re-measure whenever the SVG markup changes (also covers the initial mount).
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    svg;
    measure();
  });

  function zoom(factor: number) {
    scale = clamp(scale * factor);
  }
  function fit() {
    scale = fitScale();
  }

  function onResize() {
    fit();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoom(1.25);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoom(0.8);
    } else if (e.key === "0") {
      e.preventDefault();
      fit();
    }
  }

  // Drag-to-pan: grab the canvas and scroll the stage. Native scrollbars still work.
  let dragging = $state(false);
  let startX = 0;
  let startY = 0;
  let startL = 0;
  let startT = 0;
  function onPointerDown(e: PointerEvent) {
    if (!stage) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startL = stage.scrollLeft;
    startT = stage.scrollTop;
    stage.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging || !stage) return;
    stage.scrollLeft = startL - (e.clientX - startX);
    stage.scrollTop = startT - (e.clientY - startY);
  }
  function onPointerUp(e: PointerEvent) {
    if (!stage) return;
    dragging = false;
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  }
</script>

<svelte:window onresize={onResize} onkeydown={onKeydown} />

<div
  class="scrim lb"
  role="presentation"
  use:portal
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="frame bracket"
    role="dialog"
    aria-modal="true"
    aria-label={title || m.diagram_lightbox_title()}
    use:dialog={{ onclose }}
  >
    <header class="lb-head">
      <span class="lb-title" title={title || m.diagram_lightbox_title()}
        >{title || m.diagram_lightbox_title()}</span
      >
      <div class="lb-tools">
        <button
          type="button"
          class="step"
          onclick={() => zoom(0.8)}
          aria-label={m.diagram_zoom_out()}>−</button
        >
        <button type="button" class="pct" onclick={fit} aria-label={m.diagram_zoom_fit()}
          >{Math.round(scale * 100)}%</button
        >
        <button
          type="button"
          class="step"
          onclick={() => zoom(1.25)}
          aria-label={m.diagram_zoom_in()}>+</button
        >
        <button type="button" class="close" onclick={onclose} aria-label={m.common_close()}
          >✕</button
        >
      </div>
    </header>

    <!-- role=application: a custom pan/zoom canvas. Drag-to-pan layers on top of
         native scroll; keyboard users get fit + zoom, which always frames the
         whole diagram. -->
    <div
      class="stage"
      class:dragging
      role="application"
      aria-label={title || m.diagram_lightbox_title()}
      bind:this={stage}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
    >
      <div class="canvas" style:width="{natW * scale}px" style:height="{natH * scale}px">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- mermaid securityLevel:"strict" output, already sanitized upstream -->
        {@html svg}
      </div>
    </div>
  </div>
</div>

<style>
  .lb {
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }
  .frame {
    position: relative;
    width: 96vw;
    height: 92vh;
    display: flex;
    flex-direction: column;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  /* corner brackets — the same draftsman frame the plan card wears */
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 12px;
    height: 12px;
    border: 1px solid var(--color-line-bright);
    z-index: 2;
  }
  .bracket::before {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: -1px;
    right: -1px;
    border-left: 0;
    border-top: 0;
  }
  .lb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .lb-title {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lb-tools {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .step,
  .pct,
  .close {
    min-width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    cursor: pointer;
  }
  /* the percentage doubles as the fit-to-screen control — monospace so the
     digits don't jitter the toolbar width as the value changes */
  .pct {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 0 10px;
    color: var(--color-muted);
  }
  .step {
    font-size: var(--fs-xl);
    line-height: 1;
  }
  .step:hover,
  .pct:hover,
  .close:hover {
    background: var(--color-hover);
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
  }
  .step:focus-visible,
  .pct:focus-visible,
  .close:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* the diagram floats on the app canvas, not the panel chrome — reads as a
     blueprint on a light table rather than UI inside a box */
  .stage {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--color-bg);
    display: flex;
    cursor: grab;
    overscroll-behavior: contain;
  }
  .stage.dragging {
    cursor: grabbing;
  }
  /* margin:auto centers when the diagram is smaller than the stage AND keeps the
     overflow fully scrollable when it's larger (flex centering alone would clip
     the top-left out of reach). */
  .canvas {
    margin: auto;
    flex-shrink: 0;
  }
  .canvas :global(svg) {
    display: block;
  }
  @media (max-width: 768px) {
    .frame {
      width: 100vw;
      height: 100dvh;
      border: 0;
    }
    .bracket::before,
    .bracket::after {
      display: none;
    }
  }
</style>
