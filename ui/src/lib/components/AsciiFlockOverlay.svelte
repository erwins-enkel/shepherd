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
      art: "  __\n (oo)\n /||\\",
      lane: 34,
      start: 112,
      distance: -146,
      delay: "-1.2s",
      duration: "13s",
    },
    {
      id: "tiny-2",
      kind: "sheep dark tiny reverse",
      art: "  ##\n (oo)\n /||\\",
      lane: 82,
      start: 97,
      distance: -132,
      delay: "-7.5s",
      duration: "15s",
    },
    {
      id: "big-1",
      kind: "sheep light big",
      art: "  .-.\n (o o)___\n (___)   )\\\n  ||  ||",
      lane: 112,
      start: 120,
      distance: -154,
      delay: "-4s",
      duration: "19s",
    },
    {
      id: "tiny-3",
      kind: "sheep light tiny",
      art: "  __\n (oo)\n /||\\",
      lane: 156,
      start: 88,
      distance: -122,
      delay: "-10s",
      duration: "14s",
    },
    {
      id: "big-2",
      kind: "sheep dark big reverse",
      art: "  ###\n (o o)___\n (___)   )\\\n  ||  ||",
      lane: 28,
      start: 72,
      distance: -108,
      delay: "-12s",
      duration: "21s",
    },
    {
      id: "tiny-4",
      kind: "sheep light tiny reverse",
      art: "  __\n (oo)\n /||\\",
      lane: 118,
      start: 55,
      distance: -96,
      delay: "-6s",
      duration: "16s",
    },
    {
      id: "tiny-5",
      kind: "sheep dark tiny",
      art: "  ##\n (oo)\n /||\\",
      lane: 178,
      start: 118,
      distance: -150,
      delay: "-14s",
      duration: "17s",
    },
    {
      id: "tiny-6",
      kind: "sheep light tiny",
      art: "  __\n (oo)\n /||\\",
      lane: 68,
      start: 36,
      distance: -72,
      delay: "-8s",
      duration: "12s",
    },
    {
      id: "tiny-7",
      kind: "sheep light tiny reverse",
      art: "  __\n (oo)\n /||\\",
      lane: 202,
      start: 80,
      distance: -112,
      delay: "-3s",
      duration: "18s",
    },
    {
      id: "dog",
      kind: "dog",
      art: "/^..^\\\n /|__|\\",
      lane: 16,
      start: 122,
      distance: -146,
      delay: "-5.5s",
      duration: "9s",
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
      style:--lane={`${actor.lane}px`}
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
    inset: auto 0 0;
    height: min(34dvh, 300px);
    z-index: 0;
  }
  .flock.sheet {
    display: none;
  }
  .actor {
    position: absolute;
    bottom: var(--lane);
    left: 0;
    margin: 0;
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    line-height: 1;
    letter-spacing: 0;
    opacity: 0.58;
    white-space: pre;
    text-shadow: 0 0 14px color-mix(in srgb, var(--color-ink-bright) 18%, transparent);
    transform: translate3d(var(--start), 0, 0);
    animation:
      flock-cross var(--duration) linear var(--delay) infinite,
      flock-wiggle 0.68s ease-in-out var(--delay) infinite alternate;
  }
  .actor.big {
    font-size: var(--fs-base);
    opacity: 0.54;
  }
  .actor.dark {
    color: var(--color-slate);
    text-shadow: 0 0 12px color-mix(in srgb, var(--color-slate) 20%, transparent);
  }
  .actor.dog {
    color: var(--color-amber);
    opacity: 0.72;
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
  .flock.reduced .actor:nth-child(7) {
    transform: translate3d(18vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(8) {
    transform: translate3d(38vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(9) {
    transform: translate3d(70vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(10) {
    transform: translate3d(86vw, 0, 0);
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
      opacity: 0.24;
    }
    .actor.big {
      opacity: 0.22;
    }
    .actor.dog {
      opacity: 0.34;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .actor {
      animation: none;
    }
  }
</style>
