<script lang="ts">
  import type { SessionStatus } from "$lib/types";
  import { STATUS_COLOR, statusLabel } from "$lib/format";
  import { m } from "$lib/paraglide/messages";
  import { statusTip } from "$lib/actions/statusTip.svelte";
  let {
    status,
    ready = false,
    merging = false,
    tip = false,
  }: { status: SessionStatus; ready?: boolean; merging?: boolean; tip?: boolean } = $props();
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
  // In `tip` mode the tooltip text follows the visual override precedence
  // (merging > ready > status) so it matches the pip's colour rather than
  // blindly echoing the underlying status word.
  const tipText = $derived(merging ? m.status_merging_tip() : ready ? m.status_ready_tip() : label);
  const tipParam = $derived(tip ? { text: tipText } : null);
</script>

{#if merging}
  <span
    class="pip pulse"
    style="--c:{color}"
    role="img"
    aria-label={tip ? tipText : label}
    title={tip ? undefined : label}
    use:statusTip={tipParam}
  ></span>
{:else if ready}
  <!-- ready ✓: aria-hidden by default (the READY badge carries the label); in tip
       mode it becomes a labelled, tooltipped chip so its meaning is reachable. -->
  <span
    class="pip check"
    style="--c:{color}"
    aria-hidden={tip ? undefined : true}
    role={tip ? "img" : undefined}
    aria-label={tip ? tipText : undefined}
    use:statusTip={tipParam}>✓</span
  >
{:else if status === "blocked"}
  <!-- blocked: a filled red alarm badge — loud enough to catch the eye in a long
       list, and the `!` glyph keeps a non-color cue (WCAG 1.4.1) so it never
       reads as just a red dot vs. a green `done` dot for colorblind users -->
  <span
    class="pip badge"
    style="--c:{color}"
    role="img"
    aria-label={tip ? tipText : label}
    title={tip ? undefined : label}
    use:statusTip={tipParam}>!</span
  >
{:else}
  <span
    class="pip"
    class:pulse={status === "running"}
    class:hollow
    style="--c:{color}"
    role="img"
    aria-label={tip ? tipText : label}
    title={tip ? undefined : label}
    use:statusTip={tipParam}
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
     slate dot even though both share the slate hue. 2px stroke — at 9px a thinner
     ring is sub-perceptual next to the solid dot. */
  .pip.hollow {
    background: none;
    box-shadow: inset 0 0 0 2px var(--c);
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
    /* the scaled halo must never intercept clicks meant for neighbors (the
       box-shadow it replaced was hit-transparent) */
    pointer-events: none;
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: pip-pulse 1.5s ease-out infinite !important;
  }
</style>
