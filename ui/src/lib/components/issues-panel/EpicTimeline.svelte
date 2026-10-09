<script lang="ts">
  import type { EpicGantt, GanttRow } from "#lib/epic-timing-detail.js";
  import { m } from "#lib/paraglide/messages.js";

  // The epic detail's ZEITLEISTE (#2939): an hour axis, a row per step, the landing and the finish
  // range, with a "now" line. Below a readable width the chart scrolls inside its own box.
  let { gantt }: { gantt: EpicGantt } = $props();

  const pct = (f: number) => `${(f * 100).toFixed(3)}%`;
  /** Status glyphs, so the hue never stands alone. */
  const GLYPH: Record<GanttRow["mark"], string> = {
    ok: "✓",
    run: "◷",
    wait: "·",
    landing: "·",
    finish: "◎",
  };
  /** Keep an edge label inside the track. */
  const edge = (at: number) => (at < 0.08 ? "start" : at > 0.92 ? "end" : "mid");
</script>

<section class="timeline" aria-label={m.epicdetail_section_timeline()}>
  <div class="head">
    <span class="caption">{m.epicdetail_section_timeline()}</span>
    <ul class="legend">
      {#each gantt.legend as l (l.key)}
        <li><span class="swatch sw-{l.key}" aria-hidden="true"></span>{l.label}</li>
      {/each}
    </ul>
  </div>

  <div class="gantt-scroll">
    <div class="gantt">
      <div class="axis" aria-hidden="true">
        {#each gantt.ticks as t (t.at)}
          <span class="tick-label edge-{edge(t.at)}" style:left={pct(t.at)}>{t.label}</span>
        {/each}
      </div>

      <div class="body">
        <div class="overlay" aria-hidden="true">
          {#each gantt.ticks as t (t.at)}
            <span class="grid" style:left={pct(t.at)}></span>
          {/each}
          {#if gantt.pause}
            <span
              class="pause"
              style:left={pct(gantt.pause.from)}
              style:width={pct(gantt.pause.to - gantt.pause.from)}
            ></span>
          {/if}
          {#if gantt.now}
            <span class="now" style:left={pct(gantt.now.at)}></span>
          {/if}
        </div>

        <ol class="rows">
          {#each gantt.rows as r (r.key)}
            <li class="row" data-row={r.key}>
              <span class="label">
                <span class="mark mark-{r.mark}" aria-hidden="true">{GLYPH[r.mark]}</span>
                {#if r.number != null}<span class="num">#{r.number}</span>{/if}
                <span class="title">{r.title}</span>
              </span>
              <span class="track">
                {#each r.bars as b, i (i)}
                  <span
                    class="bar bar-{b.tone}"
                    class:projected={b.projected}
                    style:left={pct(b.from)}
                    style:width={pct(b.to - b.from)}
                    aria-hidden="true"
                  ></span>
                {/each}
                {#if r.band}
                  <span
                    class="band"
                    style:left={pct(r.band.from)}
                    style:width={pct(r.band.to - r.band.from)}
                    aria-hidden="true"
                  ></span>
                  <span class="band-tick" style:left={pct(r.band.at)} aria-hidden="true"></span>
                {/if}
                {#if r.note}
                  <span
                    class="note note-{r.noteTone ?? 'muted'}"
                    style:left={r.noteSide === "after" ? `calc(${pct(r.noteAt)} + 6px)` : undefined}
                    style:right={r.noteSide === "before"
                      ? `calc(${pct(1 - r.noteAt)} + 6px)`
                      : undefined}>{r.note}</span
                  >
                {/if}
              </span>
            </li>
          {/each}
        </ol>
      </div>

      {#if gantt.now}
        <div class="axis now-row" aria-hidden="true">
          <span class="now-label edge-{edge(gantt.now.at)}" style:left={pct(gantt.now.at)}
            >{gantt.now.label}</span
          >
        </div>
      {/if}
    </div>
  </div>
</section>

<style>
  .timeline {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    padding: 8px 10px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }

  .head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px 12px;
  }

  .caption {
    flex: 1 1 auto;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  /* The chart keeps a readable width and scrolls in its own box on a phone, never the page. */
  .gantt-scroll {
    overflow-x: auto;
    overscroll-behavior-x: contain;
  }

  .gantt {
    --label-w: 220px;
    --col-gap: 12px;
    min-width: 600px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    font-variant-numeric: tabular-nums;
  }
  /* Narrow: a slimmer label column, and it stays put while the track scrolls under it. */
  @container (max-width: 560px) {
    .gantt {
      --label-w: 120px;
    }
    .label {
      position: sticky;
      left: 0;
      z-index: 2;
      background: var(--color-panel);
    }
  }

  .axis {
    position: relative;
    height: 1.6em;
    margin-left: calc(var(--label-w) + var(--col-gap));
  }

  .tick-label,
  .now-label {
    position: absolute;
    top: 0;
    white-space: nowrap;
    transform: translateX(-50%);
  }
  .edge-start {
    transform: none;
  }
  .edge-end {
    transform: translateX(-100%);
  }

  .now-label {
    color: var(--status-running);
    font-weight: 600;
  }

  .body {
    position: relative;
  }

  .overlay {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(var(--label-w) + var(--col-gap));
    right: 0;
    pointer-events: none;
  }

  .grid {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: color-mix(in srgb, var(--color-line) 60%, transparent);
  }

  .pause {
    position: absolute;
    top: 0;
    bottom: 0;
    background: repeating-linear-gradient(
      135deg,
      color-mix(in srgb, var(--color-line-bright) 50%, transparent) 0 3px,
      transparent 3px 6px
    );
  }

  .now {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: var(--status-running);
    z-index: 1;
  }

  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    display: grid;
    grid-template-columns: var(--label-w) minmax(0, 1fr);
    column-gap: var(--col-gap);
    align-items: center;
    height: 30px;
    border-top: 1px solid color-mix(in srgb, var(--color-line) 60%, transparent);
  }

  .label {
    display: flex;
    align-self: stretch;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: var(--fs-meta);
  }

  .mark {
    flex: none;
    width: 1ch;
    text-align: center;
  }
  /* CI's hues, as in the hover's step marks: passing green, running amber, landing blue. */
  .mark-ok {
    color: var(--color-green);
  }
  .mark-run {
    color: var(--status-running);
  }
  .mark-finish {
    color: var(--color-blue);
  }

  .num {
    flex: none;
    color: var(--color-blue);
  }

  .title {
    min-width: 0;
    overflow: hidden;
    color: var(--color-ink);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .track {
    position: relative;
    height: 100%;
  }

  .bar,
  .band {
    position: absolute;
    top: 50%;
    height: 10px;
    min-width: 2px;
    margin-top: -5px;
    box-sizing: border-box;
    border-radius: 1px;
  }

  .bar-done {
    background: var(--status-done);
  }
  .bar-run {
    background: var(--status-running);
  }
  .bar-landing {
    background: var(--color-blue);
  }
  /* Not yet happened: an outline in the span's hue. */
  .bar.projected {
    background: transparent;
    border: 1px dashed var(--color-muted);
  }
  .bar-run.projected {
    border-color: var(--status-running);
    background: color-mix(in srgb, var(--status-running) 12%, transparent);
  }
  .bar-landing.projected {
    border-color: var(--color-blue);
  }

  .band {
    background: color-mix(in srgb, var(--color-blue) 16%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-blue) 60%, transparent);
  }

  .band-tick {
    position: absolute;
    top: 50%;
    width: 2px;
    height: 14px;
    margin: -7px 0 0 -1px;
    background: var(--color-blue);
  }

  /* On the panel ground, so it stays readable where it crosses a bar or the pause. */
  .note {
    position: absolute;
    top: 50%;
    padding: 0 3px;
    transform: translateY(-50%);
    background: var(--color-panel);
    white-space: nowrap;
  }
  .note-muted {
    color: var(--color-muted);
  }
  .note-bright {
    color: var(--color-ink-bright);
  }
  .note-run {
    color: var(--status-running);
  }
  .note-warn {
    color: var(--status-warn);
  }

  .swatch {
    display: inline-block;
    width: 12px;
    height: 7px;
    box-sizing: border-box;
  }
  .sw-done {
    background: var(--status-done);
  }
  .sw-run {
    background: var(--status-running);
  }
  .sw-forecast {
    border: 1px dashed var(--color-muted);
  }
  .sw-range {
    background: color-mix(in srgb, var(--color-blue) 16%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-blue) 60%, transparent);
  }
  .sw-landing {
    background: var(--color-blue);
  }
  .sw-pause {
    background: repeating-linear-gradient(
      135deg,
      var(--color-line-bright) 0 2px,
      transparent 2px 4px
    );
  }
</style>
