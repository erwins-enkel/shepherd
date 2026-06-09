<script lang="ts">
  import type { SessionStatus } from "$lib/types";
  import { STATUS_COLOR, statusLabel } from "$lib/format";
  import { m } from "$lib/paraglide/messages";
  let {
    status,
    ready = false,
    merging = false,
  }: { status: SessionStatus; ready?: boolean; merging?: boolean } = $props();
  // ready overrides status: a green ✓ reads as "parked, actionable-complete".
  // The check (green) is reserved for readyToMerge; a `done`/WAITING session is
  // NOT complete (it's parked for the operator's next steer), so its pip is the
  // quiet idle slate (--status-done === --color-slate), not green.
  // merging takes priority over ready: amber pulse signals in-flight merge train.
  const color = $derived(
    merging ? "var(--color-amber)" : ready ? "var(--color-green)" : STATUS_COLOR[status],
  );
  // done (WAITING) and idle share slate, so hue alone can't separate them.
  // Give done a hollow ring (a parked marker) vs idle's solid dot — a non-color
  // cue on top of the distinct WAITING/IDLE label.
  const hollow = $derived(status === "done");
  // Non-color cue: the pip is otherwise color-only, so carry the status word as
  // an accessible label/tooltip for the dot states.
  const label = $derived(m.statuspip_status_aria({ status: statusLabel(status) }));
</script>

{#if merging}
  <span class="pip pulse" style="--c:{color}" role="img" aria-label={label} title={label}></span>
{:else if ready}
  <span class="pip check" style="--c:{color}" aria-hidden="true">✓</span>
{:else if status === "blocked"}
  <!-- blocked: a filled red alarm badge — loud enough to catch the eye in a long
       list, and the `!` glyph keeps a non-color cue (WCAG 1.4.1) so it never
       reads as just a red dot vs. a green `done` dot for colorblind users -->
  <span class="pip badge" style="--c:{color}" role="img" aria-label={label} title={label}>!</span>
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
  }
  /* done (WAITING): a hollow ring reads as "parked", distinct from idle's solid
     slate dot even though both share the slate hue */
  .pip.hollow {
    background: none;
    box-shadow: inset 0 0 0 1.5px var(--c);
  }
  /* bare glyph (no filled circle) — the mark itself is the signal:
     `ready` → green ✓ */
  .pip.check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    color: var(--c);
    font-size: var(--fs-micro);
    line-height: 1;
    font-weight: 700;
  }
  /* blocked: a filled red badge with a white `!` — a deliberately loud
     "needs you" marker that reads at a glance in a long list, vs. the quiet 9px
     dots. Pulled up 3px (margin-top) so its center lines up with the name's
     first text line: .pip-col's padding-top was tuned for the 9px dot, and the
     taller badge would otherwise sit low. */
  .pip.badge {
    width: 16px;
    height: 16px;
    margin-top: -3px;
    border-radius: 4px;
    /* darken --red ~12% toward black: pure --red (#e5484d dark) under white only
       hits ~3.9:1, just shy of WCAG AA 4.5:1 for the 12px glyph; the deeper red
       clears ~5:1 in both themes and reads as a stronger alarm, not weaker. */
    background: color-mix(in srgb, var(--c) 88%, #000);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* fixed white glyph, NOT a theme token: the badge ground is red in every
       theme, so the text must stay light in light mode too — any --color-ink*
       token inverts to dark there and would tank the contrast. White maximizes
       it (~5:1 on the darkened red above). */
    color: #fff;
    font-size: var(--fs-base);
    line-height: 1;
    font-weight: 800;
  }
  .pulse {
    position: relative;
  }
  /* expanding-fading halo: a same-color translucent disc behind/over the solid
     pip (only solid pips pulse, so the same-hue wash over the dot is invisible),
     scaled + faded on the compositor — no per-frame box-shadow repaints */
  .pulse::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: color-mix(in srgb, var(--c) 70%, transparent);
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: pip-pulse 1.5s ease-out infinite !important;
  }
</style>
