<script lang="ts">
  import { steers } from "$lib/steers.svelte";
  import { replySession } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { fitLabels } from "$lib/fit-labels";
  import { m } from "$lib/paraglide/messages";

  let { focusedId, onbroadcast }: { focusedId: string; onbroadcast: () => void } = $props();

  // Only steer-bar-scoped entries render here; issue-scoped ones live on backlog rows.
  const chips = $derived(steers.list.filter((s) => s.inSteerBar));

  // One-time coachmark: the steer chips are tap-to-send and the leading ⌁ broadcast chip
  // broadcasts to many sessions — neither affordance is obvious on first sight.
  // Show a single muted hint until the operator dismisses it, then never again
  // (localStorage). SSR-safe: stays hidden until mount reads the flag.
  const COACH_KEY = "shepherd:steer-coach-seen";
  let showCoach = $state(false);
  $effect(() => {
    try {
      if (localStorage.getItem(COACH_KEY) !== "1") showCoach = true;
    } catch {
      // private mode / blocked storage: skip the hint rather than nag every load
    }
  });
  function dismissCoach() {
    showCoach = false;
    try {
      localStorage.setItem(COACH_KEY, "1");
    } catch {
      // ignore: best-effort persistence
    }
  }

  // Tap-vs-drag: the bar scrolls horizontally (overflow-x), so a finger that
  // lands on a chip and drags to scroll must NOT fire it. Arm on pointerdown,
  // disarm once the pointer moves past a small slop (it's a scroll) or when the
  // browser takes the gesture over for scrolling (pointercancel), and only act
  // on a clean tap at pointerup. preventDefault on the *up* — not the down —
  // suppresses the synthetic click so the chip never blurs the terminal (which
  // would dismiss the mobile soft keyboard), while leaving native horizontal
  // scrolling intact.
  const TAP_SLOP = 10;
  let armedId: number | null = null;
  let startX = 0;
  let startY = 0;

  function down(e: PointerEvent) {
    armedId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
  }
  function move(e: PointerEvent) {
    if (armedId !== e.pointerId) return;
    if (Math.abs(e.clientX - startX) > TAP_SLOP || Math.abs(e.clientY - startY) > TAP_SLOP) {
      armedId = null;
    }
  }
  function cancel(e: PointerEvent) {
    if (armedId === e.pointerId) armedId = null;
  }
  function tap(e: PointerEvent, action: () => void) {
    if (armedId !== e.pointerId) return;
    armedId = null;
    e.preventDefault();
    action();
  }

  // Steering is the product's core risky action: a failed send must not vanish.
  // Route the failure through a persistent toast (duration: null, stays until
  // retried or closed) with an inline Retry (retry re-runs send(), so a repeated
  // failure re-toasts), announced assertively (alert) so a screen-reader
  // operator hears it promptly. Keyed per focused agent so repeated failures
  // collapse into one toast (Retry targets the latest) instead of stacking.
  // Replaces a self-clearing flash easily missed.
  function send(text: string) {
    replySession(focusedId, text).catch(() => {
      toasts.info(m.steerbar_send_failed(), {
        duration: null,
        alert: true,
        key: `steer-fail:${focusedId}`,
        action: { label: m.common_retry(), run: () => send(text) },
      });
    });
  }
</script>

{#if showCoach}
  <div class="coach" data-swipe-ignore>
    <span class="coach-text">{m.steerbar_coach_hint()}</span>
    <!-- No aria-label: the visible "Got it" text is the accessible name, so it
         stays voice-control addressable (WCAG 2.5.3 label-in-name). -->
    <button type="button" class="coach-dismiss" onclick={dismissCoach}
      >{m.steerbar_coach_dismiss()}</button
    >
  </div>
{/if}
<!-- fitLabels toggles `compact` when the full labels overflow: chips that carry an
     emoji collapse to emoji-only (label stays in title/aria); the rest keep their
     label and the bar's horizontal scroll remains the final fallback. -->
<div
  class="steer-bar"
  role="toolbar"
  aria-label={m.steerbar_toolbar_aria()}
  data-swipe-ignore
  use:fitLabels
>
  <button
    type="button"
    class="chip bc"
    onpointerdown={down}
    onpointermove={move}
    onpointercancel={cancel}
    onpointerup={(e) => tap(e, onbroadcast)}
    title={m.steerbar_broadcast_aria()}
    aria-label={m.steerbar_broadcast_aria()}
    >⌁<span class="bc-label">{m.steerbar_broadcast()}</span></button
  >
  {#each chips as s (s.id)}
    <button
      type="button"
      class="chip"
      class:has-emoji={!!s.emoji}
      title={s.text}
      aria-label={m.steerbar_send_aria({ label: s.label })}
      onpointerdown={down}
      onpointermove={move}
      onpointercancel={cancel}
      onpointerup={(e) => tap(e, () => send(s.text))}
      >{#if s.emoji}<span class="chip-emoji" aria-hidden="true">{s.emoji}</span>{/if}<span
        class="chip-label">{s.label}</span
      ></button
    >
  {/each}
</div>

<style>
  .steer-bar {
    display: flex;
    gap: 4px;
    padding: 6px 10px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    overflow-x: auto;
    white-space: nowrap;
    min-width: 0;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .steer-bar::-webkit-scrollbar {
    display: none;
  }
  .chip {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 14px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .chip:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .chip.bc {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .bc-label {
    margin-left: 6px;
  }
  .chip-emoji + .chip-label {
    margin-left: 6px;
  }
  /* compact (set by fitLabels on overflow): emoji-carrying chips shed their label —
     the emoji is the identifier; label-only chips are untouched. The broadcast chip
     joins in, matching its existing mobile collapse. */
  .steer-bar:global(.compact) .chip.has-emoji .chip-label,
  .steer-bar:global(.compact) .bc-label {
    display: none;
  }
  .steer-bar:global(.compact) .chip.has-emoji,
  .steer-bar:global(.compact) .chip.bc {
    min-width: 44px;
    padding: 0;
  }
  /* on mobile the broadcast chip collapses to just its ⌁ icon to reclaim
     space; matches the ControlBar Esc key's box model (min-width 44px, no
     horizontal padding) so the collapsed chip and Esc render an identical width.
     Esc additionally sits inside a 3px-padded group "well", nudging its box that
     far right of the bar edge — match it with an equal left margin so the two
     left edges line up, not just the widths.
     The steer row also mirrors the ControlBar's *grouping*: ⌁ plays Esc's part
     (own box, frozen left) and the steer chips play the Tab/nav groups. To line
     the first steer chip up under the Tab key, the ⌁→first-chip channel must
     equal the Esc→Tab channel (3px Esc-well + 6px ctrl-row gap + 3px Tab-well =
     12px). The flex `gap` already gives 4px, so add the remaining 8px here. */
  @media (max-width: 768px) {
    .chip.bc {
      min-width: 44px;
      padding: 0;
      margin-left: 3px;
      margin-right: 8px;
    }
    .bc-label {
      display: none;
    }
  }
  /* one-time steer hint: flat, square, hairline-bordered, muted ink — sits
     directly above the steer row, no shadow or glow at rest */
  .coach {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    line-height: 1.35;
  }
  .coach-text {
    flex: 1 1 auto;
    min-width: 0;
    /* full instructional sentence, not chrome — body size, not the 11px label rung */
    font-size: var(--fs-base);
  }
  .coach-dismiss {
    flex: 0 0 auto;
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    cursor: pointer;
    touch-action: manipulation;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .coach-dismiss:hover {
    background: var(--color-hover);
  }
  .coach-dismiss:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
</style>
