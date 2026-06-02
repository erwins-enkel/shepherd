<script lang="ts">
  import type { SessionStatus } from "$lib/types";
  import { STATUS_COLOR, statusLabel } from "$lib/format";
  import { m } from "$lib/paraglide/messages";
  let { status, ready = false }: { status: SessionStatus; ready?: boolean } = $props();
  // ready overrides status: a green ✓ reads as "parked, actionable-complete".
  // The check (green) is reserved for readyToMerge; a `done`/WAITING session is
  // NOT complete (it's parked for the operator's next steer), so its pip is the
  // quiet idle slate (--status-done === --color-slate), not green.
  const color = $derived(ready ? "var(--color-green)" : STATUS_COLOR[status]);
  // done (WAITING) and idle share slate, so hue alone can't separate them.
  // Give done a hollow ring (a parked marker) vs idle's solid dot — a non-color
  // cue on top of the distinct WAITING/IDLE label.
  const hollow = $derived(status === "done");
  // Non-color cue: the pip is otherwise color-only, so carry the status word as
  // an accessible label/tooltip for the dot states.
  const label = $derived(m.statuspip_status_aria({ status: statusLabel(status) }));
</script>

{#if ready}
  <span class="pip check" style="--c:{color}" aria-hidden="true">✓</span>
{:else if status === "blocked"}
  <!-- blocked: a bare red alarm mark (non-color cue, WCAG 1.4.1) so it never
       reads as just a red dot vs. a green `done` dot for colorblind users -->
  <span class="pip glyph" style="--c:{color}" role="img" aria-label={label} title={label}>!</span>
{:else}
  <span
    class="pip"
    class:pulse={status === "running"}
    class:hollow
    style="--c:{color}"
    role="img"
    aria-label={label}
    title={label}
  ></span>
{/if}

<style>
  .pip {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--c);
    display: inline-block;
    box-shadow: 0 0 0 0 var(--c);
  }
  /* done (WAITING): a hollow ring reads as "parked", distinct from idle's solid
     slate dot even though both share the slate hue */
  .pip.hollow {
    background: none;
    box-shadow: inset 0 0 0 1.5px var(--c);
  }
  /* bare glyph (no filled circle) — the mark itself is the signal:
     `ready` → green ✓, `blocked` → red ! alarm mark */
  .pip.check,
  .pip.glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    box-shadow: none;
    color: var(--c);
    font-size: 10px;
    line-height: 1;
    font-weight: 700;
  }
  .pulse {
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: pip-pulse 1.5s ease-out infinite !important;
  }
</style>
