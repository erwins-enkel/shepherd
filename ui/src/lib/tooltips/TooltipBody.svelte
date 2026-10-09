<script lang="ts">
  import type { TooltipContent } from "./content";

  // `wide`: a roomy panel (e.g. the session status panel) — sections flow into columns where
  // the width allows and stack again on a narrow viewport.
  let { content, wide = false }: { content: TooltipContent; wide?: boolean } = $props();

  const MARK = { ok: "✓", run: "◷", fail: "✕", warn: "!", idle: "·" } as const;

  const pct = (f: number) => `${Math.max(0, Math.min(1, f)) * 100}%`;
  // Keep the now label inside the strip: anchor it left near the start, right near the end.
  const nowShift = (at: number) => (at < 0.15 ? "0" : at > 0.85 ? "-100%" : "-50%");
  const cells = (m: { value: number; max: number }) =>
    Array.from({ length: m.max }, (_, k) => k < m.value);
</script>

<!-- Phrasing elements keep this valid inside GlossaryTerm's inline disclosure,
     including when its trigger sits inside a paragraph. Never render raw HTML. -->
<span class={wide ? "tooltip-body wide" : "tooltip-body"}>
  {#if typeof content === "string"}
    {content}
  {:else}
    <strong class="tooltip-title">{content.title}</strong>
    <span class="tooltip-summary">{content.summary}</span>
    {#if content.timeline}
      {@const strip = content.timeline}
      <span class="tooltip-timeline">
        <span class="tl-edges"><span>{strip.start}</span><span>{strip.end}</span></span>
        <span class="tl-strip" aria-hidden="true">
          {#each strip.segments as seg, i (i)}
            <span
              class="tl-seg tl-{seg.tone}"
              class:tl-projected={seg.projected}
              style:left={pct(seg.from)}
              style:width={pct(seg.to - seg.from)}
            ></span>
          {/each}
          {#if strip.now}<span class="tl-now" style:left={pct(strip.now.at)}></span>{/if}
        </span>
        {#if strip.now}
          <span class="tl-now-row">
            <span
              class="tl-now-label"
              style:left={pct(strip.now.at)}
              style:transform="translateX({nowShift(strip.now.at)})">{strip.now.label}</span
            >
          </span>
        {/if}
        <span class="tl-legend">
          {#each strip.legend as entry, i (i)}
            <span class="tl-key"
              ><span
                class="tl-swatch tl-{entry.tone}"
                class:tl-projected={entry.projected}
                aria-hidden="true"
              ></span>{entry.label}</span
            >
          {/each}
        </span>
      </span>
    {/if}
    <span class="tooltip-sections">
      {#each content.sections as section, index (index)}
        <span class="tooltip-section" class:full={section.full}>
          <strong class="tooltip-label">{section.label}</strong>
          {#if section.text}<span>{section.text}</span>{/if}
          {#if section.rows?.length}
            <span class="tooltip-rows">
              {#each section.rows as row, r (r)}
                <span class="tooltip-row tone-{row.tone ?? 'idle'}">
                  <span class="tooltip-mark" aria-hidden="true">{MARK[row.tone ?? "idle"]}</span>
                  <span class="tooltip-row-text">{row.text}</span>
                  {#if row.meter}
                    <span class="tooltip-meter" aria-hidden="true">
                      {#each cells(row.meter) as on, k (k)}
                        <span class="tooltip-meter-cell" class:on></span>
                      {/each}
                    </span>
                  {/if}
                  {#if row.aside}<span class="tooltip-aside">{row.aside}</span>{/if}
                </span>
              {/each}
            </span>
          {/if}
          {#if section.note}<span class="tooltip-note">{section.note}</span>{/if}
        </span>
      {/each}
    </span>
    {#if content.footer?.length}
      <span class="tooltip-footer">
        {#each content.footer as line, i (i)}<span>{line}</span>{/each}
      </span>
    {/if}
  {/if}
</span>

<style>
  .tooltip-body {
    display: block;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    font-weight: 400;
    line-height: 1.55;
    text-align: left;
    text-transform: none;
    letter-spacing: normal;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .tooltip-title {
    display: block;
    margin-bottom: 6px;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
    line-height: 1.35;
  }

  .tooltip-summary {
    display: block;
  }

  .tooltip-sections {
    display: grid;
    gap: 10px;
    margin-top: 12px;
  }

  .tooltip-sections:empty {
    display: none;
  }

  .tooltip-section,
  .tooltip-label {
    display: block;
  }

  .tooltip-label {
    margin-bottom: 2px;
    color: var(--color-ink-bright);
    font-weight: 600;
  }

  .wide .tooltip-sections {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr));
    column-gap: 20px;
  }

  .wide .tooltip-section.full {
    grid-column: 1 / -1;
  }

  .tooltip-note {
    display: block;
    margin-top: 4px;
    color: var(--color-muted);
  }

  .tooltip-footer {
    display: grid;
    gap: 2px;
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid var(--color-line);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }

  /* Timeline strip: spans laid out over time. The edge, now and legend labels carry the
     meaning; the hues (CI's own: slate done, amber running, blue landing) reinforce it. */
  .tooltip-timeline {
    display: block;
    margin-top: 10px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }

  .tl-edges {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }

  .tl-strip {
    position: relative;
    display: block;
    height: 10px;
    margin: 4px 0 3px;
  }

  .tl-seg {
    position: absolute;
    top: 0;
    bottom: 0;
    min-width: 2px;
    box-sizing: border-box;
    border-radius: 1px;
  }

  .tl-done {
    background: var(--status-done);
  }
  .tl-run {
    background: var(--status-running);
  }
  .tl-landing {
    background: var(--color-blue);
  }
  .tl-pause {
    background: repeating-linear-gradient(
      135deg,
      var(--color-line-bright) 0 3px,
      transparent 3px 6px
    );
  }
  .tl-unknown {
    border: 1px dotted var(--color-line-bright);
  }
  /* Not yet happened: an outline in the span's hue, no fill. */
  .tl-projected {
    background: transparent;
    border: 1px dashed var(--status-done);
  }
  .tl-run.tl-projected {
    border-color: var(--status-running);
    background: color-mix(in srgb, var(--status-running) 12%, transparent);
  }
  .tl-landing.tl-projected {
    border-color: var(--color-blue);
  }

  .tl-now {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 2px;
    margin-left: -1px;
    background: var(--status-running);
  }

  .tl-now-row {
    position: relative;
    display: block;
    height: 1.5em;
  }

  .tl-now-label {
    position: absolute;
    top: 0;
    white-space: nowrap;
    color: var(--status-running);
    font-weight: 600;
  }

  .tl-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 14px;
    margin-top: 2px;
  }

  .tl-swatch {
    display: inline-block;
    width: 10px;
    height: 6px;
    margin-right: 5px;
    box-sizing: border-box;
    vertical-align: middle;
  }

  .tooltip-rows {
    display: grid;
    gap: 2px;
    margin-top: 2px;
  }

  .tooltip-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }

  .tooltip-mark {
    flex: none;
    width: 1ch;
    text-align: center;
    color: var(--color-muted);
  }

  /* Status marks follow CI's own hues (Stepper's ci-* segments): passing green, running amber,
     red failing, caution warn. The glyph differs per tone too, so hue never stands alone. */
  .tone-ok .tooltip-mark {
    color: var(--color-green);
  }
  .tone-run .tooltip-mark {
    color: var(--status-running);
  }
  .tone-fail .tooltip-mark {
    color: var(--color-red);
  }
  .tone-warn .tooltip-mark {
    color: var(--status-warn);
  }

  .tooltip-row-text {
    min-width: 0;
  }

  .tooltip-aside {
    margin-left: auto;
    flex: none;
    padding-left: 8px;
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }

  .tooltip-meter {
    display: inline-flex;
    flex: none;
    align-self: center;
    gap: 2px;
    margin-left: auto;
    padding-left: 8px;
  }
  .tooltip-meter + .tooltip-aside {
    margin-left: 0;
  }
  .tooltip-meter-cell {
    width: 10px;
    height: 4px;
    background: var(--color-line-bright);
  }
  .tooltip-meter-cell.on {
    background: var(--status-running);
  }
</style>
