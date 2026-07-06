<script lang="ts">
  import { onMount } from "svelte";

  let { placement = "backdrop" }: { placement?: "backdrop" | "sheet" } = $props();

  let reducedMotion = $state(false);

  onMount(() => {
    reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  });

  const actors = [
    {
      id: "tiny-1",
      kind: "sheep light tiny",
      art: "(oo)\n/||\\",
      lane: 17,
      start: 114,
      distance: -132,
      delay: "-0.8s",
      duration: "19s",
    },
    {
      id: "tiny-2",
      kind: "sheep dark tiny reverse",
      art: "(oo)\n/||\\",
      lane: 31,
      start: 104,
      distance: -118,
      delay: "-7s",
      duration: "23s",
    },
    {
      id: "big-1",
      kind: "sheep light big",
      art: "  __\n (oo)___\n (__)   )\\\n   ||--||",
      lane: 48,
      start: 118,
      distance: -136,
      delay: "-3.5s",
      duration: "28s",
    },
    {
      id: "tiny-3",
      kind: "sheep light tiny",
      art: "(oo)\n/||\\",
      lane: 64,
      start: 109,
      distance: -126,
      delay: "-12s",
      duration: "21s",
    },
    {
      id: "big-2",
      kind: "sheep dark big reverse",
      art: "  __\n (oo)___\n (__)   )\\\n   ||--||",
      lane: 74,
      start: 100,
      distance: -120,
      delay: "-15s",
      duration: "31s",
    },
    {
      id: "dog",
      kind: "dog",
      art: "/^..^\\\n  /_\\",
      lane: 57,
      start: 122,
      distance: -146,
      delay: "-5s",
      duration: "13s",
    },
  ];
</script>

<div
  class="flock {placement}"
  class:reduced={reducedMotion}
  data-ascii-flock={placement}
  data-reduced={reducedMotion ? "true" : "false"}
  aria-hidden="true"
>
  {#each actors as actor (actor.id)}
    <pre
      class="actor {actor.kind}"
      style:--lane={`${actor.lane}%`}
      style:--start={`${actor.start}vw`}
      style:--distance={`${actor.distance}vw`}
      style:--delay={actor.delay}
      style:--duration={actor.duration}>{actor.art}</pre>
  {/each}
</div>

<style>
  .flock {
    pointer-events: none;
    overflow: hidden;
    user-select: none;
    contain: paint;
  }
  .flock.backdrop {
    position: absolute;
    inset: 0;
    z-index: 0;
  }
  .flock.sheet {
    display: none;
  }
  .actor {
    position: absolute;
    top: var(--lane);
    left: 0;
    margin: 0;
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    line-height: 1;
    letter-spacing: 0;
    opacity: 0.3;
    white-space: pre;
    text-shadow: 0 0 14px color-mix(in srgb, var(--color-ink-bright) 18%, transparent);
    transform: translate3d(var(--start), 0, 0);
    animation:
      flock-cross var(--duration) linear var(--delay) infinite,
      flock-wiggle 0.68s ease-in-out var(--delay) infinite alternate;
  }
  .actor.big {
    font-size: var(--fs-base);
    opacity: 0.26;
  }
  .actor.dark {
    color: var(--color-slate);
    text-shadow: 0 0 12px color-mix(in srgb, var(--color-slate) 20%, transparent);
  }
  .actor.dog {
    color: var(--color-amber);
    opacity: 0.34;
    animation:
      flock-cross var(--duration) linear var(--delay) infinite,
      dog-loop 1.4s ease-in-out var(--delay) infinite;
  }
  .actor.reverse {
    scale: -1 1;
  }
  .flock.reduced .actor {
    animation: none;
  }
  .flock.reduced .actor:nth-child(1) {
    transform: translate3d(8vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(2) {
    transform: translate3d(27vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(3) {
    transform: translate3d(44vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(4) {
    transform: translate3d(66vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(5) {
    transform: translate3d(78vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(6) {
    transform: translate3d(56vw, 0, 0);
  }

  @keyframes flock-cross {
    from {
      transform: translate3d(var(--start), 0, 0);
    }
    to {
      transform: translate3d(calc(var(--start) + var(--distance)), 0, 0);
    }
  }
  @keyframes flock-wiggle {
    from {
      translate: 0 -1px;
    }
    to {
      translate: 0 2px;
    }
  }
  @keyframes dog-loop {
    0%,
    100% {
      translate: 0 -3px;
    }
    50% {
      translate: 0 4px;
    }
  }

  @media (max-width: 768px) {
    .flock.backdrop {
      display: none;
    }
    .flock.sheet {
      position: sticky;
      top: 0;
      display: block;
      height: 100dvh;
      margin-bottom: -100dvh;
      z-index: 0;
    }
    .actor {
      opacity: 0.18;
    }
    .actor.big {
      opacity: 0.16;
    }
    .actor.dog {
      opacity: 0.22;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .actor {
      animation: none;
    }
  }
</style>
