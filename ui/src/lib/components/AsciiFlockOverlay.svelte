<script lang="ts">
  import { onMount } from "svelte";

  let { placement = "backdrop" }: { placement?: "backdrop" | "sheet" } = $props();

  let reducedMotion = $state(false);

  onMount(() => {
    reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  });

  const actors = [
    {
      id: "sheep-1",
      type: "sheep",
      kind: "light small",
      art: "  __\n (oo)\\\n /||\\",
      lane: 18,
      start: 108,
      distance: -136,
      delay: "-1s",
      duration: "11s",
    },
    {
      id: "sheep-2",
      type: "sheep",
      kind: "dark small",
      art: " ,_,\n(oo)-.\n /|\\\\",
      lane: 72,
      start: 93,
      distance: -124,
      delay: "-6s",
      duration: "13s",
    },
    {
      id: "sheep-3",
      type: "sheep",
      kind: "light big",
      art: "  .-''''-.\n /  (oo)  \\\n(__(____)__)\n   ||  ||",
      lane: 108,
      start: 116,
      distance: -150,
      delay: "-4s",
      duration: "16s",
    },
    {
      id: "sheep-4",
      type: "sheep",
      kind: "dark big",
      art: "   .-oooo-.\n  (  (oo) )\n   )  --  (\n  /__|  |__\\",
      lane: 30,
      start: 70,
      distance: -100,
      delay: "-11s",
      duration: "18s",
    },
    {
      id: "sheep-5",
      type: "sheep",
      kind: "light tiny reverse",
      art: " _.\n(o)\n/|\\",
      lane: 150,
      start: -18,
      distance: 118,
      delay: "-9s",
      duration: "12s",
    },
    {
      id: "sheep-6",
      type: "sheep",
      kind: "light small",
      art: "  __\n (oo)\n/|  |\\",
      lane: 86,
      start: 42,
      distance: -74,
      delay: "-7s",
      duration: "10s",
    },
    {
      id: "sheep-7",
      type: "sheep",
      kind: "dark small",
      art: " .-.\n(oo)___\n || ||",
      lane: 166,
      start: 118,
      distance: -148,
      delay: "-14s",
      duration: "15s",
    },
    {
      id: "dog",
      type: "dog",
      kind: "dog",
      art: " /^..^\\\n/  _  \\\n  / \\_",
      lane: 10,
      start: 122,
      distance: -150,
      delay: "-4s",
      duration: "8s",
    },
  ];
</script>

<div
  class="flock {placement}"
  class:reduced={reducedMotion}
  data-flock={placement}
  data-reduced={reducedMotion ? "true" : "false"}
  aria-hidden="true"
>
  {#each actors as actor (actor.id)}
    <pre
      class="actor {actor.kind}"
      data-flock-actor={actor.type}
      data-flock-art={actor.id}
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
    height: min(36dvh, 310px);
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
    font-family: inherit;
    font-size: var(--fs-meta);
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0;
    white-space: pre;
    opacity: 0.64;
    transform: translate3d(var(--start), 0, 0);
    animation:
      flock-cross var(--duration) linear var(--delay) infinite,
      flock-wiggle 0.58s ease-in-out var(--delay) infinite alternate;
  }
  .actor.big {
    font-size: var(--fs-base);
    opacity: 0.58;
  }
  .actor.tiny {
    font-size: var(--fs-micro);
    opacity: 0.58;
  }
  .actor.dark {
    color: var(--color-slate);
    opacity: 0.68;
  }
  .actor.dog {
    color: var(--color-amber);
    font-size: var(--fs-base);
    opacity: 0.82;
    animation:
      flock-cross var(--duration) linear var(--delay) infinite,
      dog-loop 0.46s ease-in-out var(--delay) infinite alternate;
  }
  .flock.reduced .actor {
    animation: none;
  }
  .flock.reduced .actor:nth-child(1) {
    transform: translate3d(10vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(2) {
    transform: translate3d(24vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(3) {
    transform: translate3d(42vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(4) {
    transform: translate3d(62vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(5) {
    transform: translate3d(76vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(6) {
    transform: translate3d(33vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(7) {
    transform: translate3d(88vw, 0, 0);
  }
  .flock.reduced .actor:nth-child(8) {
    transform: translate3d(54vw, 0, 0);
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
      translate: 0 -3px;
      rotate: -2deg;
    }
    to {
      translate: 0 4px;
      rotate: 2deg;
    }
  }
  @keyframes dog-loop {
    from {
      translate: 0 -6px;
      rotate: 3deg;
    }
    to {
      translate: 0 5px;
      rotate: -3deg;
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
      opacity: 0.3;
    }
    .actor.big {
      opacity: 0.28;
    }
    .actor.dog {
      opacity: 0.42;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .actor {
      animation: none;
    }
  }
</style>
