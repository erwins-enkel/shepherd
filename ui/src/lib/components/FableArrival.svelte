<script lang="ts">
  import { onMount } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";

  // One-time "Fable 5 has arrived" celebration. `ontry` opens New Task preset to
  // Fable; `onclose` dismisses (the caller marks it seen so it never reappears).
  let {
    ontry,
    onclose,
  }: {
    ontry: () => void;
    onclose: () => void;
  } = $props();

  // Confetti is decorative + client-only: generating it in onMount avoids an
  // SSR/hydrate mismatch and lets us honor prefers-reduced-motion (no motion →
  // no confetti at all, just the static hero).
  type Confetto = { left: number; delay: number; dur: number; hue: string; size: number };
  let confetti = $state<Confetto[]>([]);
  let reduceMotion = $state(false);

  // Decorative accents only — amber (the celebratory accent), blue, and the two
  // brights. Deliberately NOT green/red, which carry semantic status meaning.
  const HUES = [
    "var(--color-amber)",
    "var(--color-blue)",
    "var(--color-ink-bright)",
    "var(--color-line-bright)",
  ];

  onMount(() => {
    reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduceMotion) return;
    confetti = Array.from({ length: 70 }, () => ({
      left: Math.random() * 100,
      delay: Math.random() * 2,
      dur: 2.6 + Math.random() * 2.4,
      hue: HUES[Math.floor(Math.random() * HUES.length)],
      size: 5 + Math.random() * 6,
    }));
  });

  const enterDur = $derived(reduceMotion ? 0 : 360);
</script>

<div
  class="scrim cele"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
  transition:fade={{ duration: reduceMotion ? 0 : 200 }}
>
  {#if !reduceMotion}
    <div class="confetti" aria-hidden="true">
      {#each confetti as c, i (i)}
        <span
          class="piece"
          style="left:{c.left}%; animation-delay:{c.delay}s; animation-duration:{c.dur}s; background:{c.hue}; width:{c.size}px; height:{c.size}px;"
        ></span>
      {/each}
    </div>
  {/if}

  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.fable_arrival_aria()}
    use:dialog={{ onclose }}
    transition:scale={{ duration: enterDur, start: 0.92, opacity: 0 }}
  >
    <button class="close" onclick={() => onclose()} aria-label={m.common_close()}>✕</button>

    <p class="eyebrow">{m.fable_arrival_eyebrow()}</p>
    <div class="wordmark" class:still={reduceMotion}>
      <span class="brand">Fable 5</span>
    </div>
    <h2 class="headline">{m.fable_arrival_title()}</h2>
    <p class="body">{m.fable_arrival_body()}</p>

    <div class="actions">
      <button class="try" onclick={() => ontry()}>{m.fable_arrival_try()}</button>
      <button class="later" onclick={() => onclose()}>{m.fable_arrival_dismiss()}</button>
    </div>
  </div>
</div>

<style>
  /* Inherits .scrim (dim + blur) from app.css; .cele adds centering + stacking. */
  .cele {
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    overflow: hidden;
  }

  .confetti {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .piece {
    position: absolute;
    top: -8%;
    border-radius: 1px;
    opacity: 0.9;
    animation-name: fable-fall;
    animation-timing-function: linear;
    animation-iteration-count: infinite;
  }
  @keyframes fable-fall {
    0% {
      transform: translateY(-10vh) rotate(0deg);
      opacity: 0;
    }
    10% {
      opacity: 0.95;
    }
    100% {
      transform: translateY(110vh) rotate(540deg);
      opacity: 0;
    }
  }

  .card {
    position: relative;
    width: min(460px, 100%);
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--color-amber) 18%, transparent),
      0 30px 80px -30px var(--color-scrim),
      inset 0 0 60px -40px var(--color-amber);
    padding: 30px 28px 24px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .close {
    position: absolute;
    top: 10px;
    right: 12px;
    background: none;
    border: none;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-lg);
    line-height: 1;
  }
  .close:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }

  .eyebrow {
    margin: 0;
    font-size: var(--fs-meta);
    letter-spacing: 0.24em;
    text-transform: uppercase;
    color: var(--color-amber);
  }

  .wordmark {
    margin: 6px 0 2px;
  }
  .brand {
    font-size: var(--fs-2xl);
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--color-ink-bright);
    text-shadow: 0 0 26px color-mix(in srgb, var(--color-amber) 60%, transparent);
    animation: fable-glow 2.6s ease-in-out infinite;
  }
  @keyframes fable-glow {
    0%,
    100% {
      text-shadow: 0 0 20px color-mix(in srgb, var(--color-amber) 45%, transparent);
    }
    50% {
      text-shadow: 0 0 38px color-mix(in srgb, var(--color-amber) 85%, transparent);
    }
  }
  .wordmark.still .brand {
    animation: none;
  }

  .headline {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: 600;
    color: var(--color-ink-bright);
    line-height: 1.25;
  }
  .body {
    margin: 0;
    max-width: 38ch;
    font-size: var(--fs-base);
    line-height: 1.55;
    color: var(--color-muted);
  }

  .actions {
    margin-top: 14px;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }
  .try {
    background: transparent;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    font-weight: 600;
    padding: 9px 20px;
    cursor: pointer;
    letter-spacing: 0.06em;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
    font-size: var(--fs-base);
  }
  .try:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  .later {
    background: none;
    border: 1px solid var(--color-line);
    color: var(--color-muted);
    padding: 9px 18px;
    cursor: pointer;
    letter-spacing: 0.04em;
    font-size: var(--fs-base);
  }
  .later:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .brand {
      animation: none;
    }
  }
</style>
