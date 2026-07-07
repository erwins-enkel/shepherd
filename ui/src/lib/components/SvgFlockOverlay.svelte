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
      lane: 18,
      width: 92,
      start: 108,
      distance: -136,
      delay: "-1s",
      duration: "11s",
    },
    {
      id: "sheep-2",
      type: "sheep",
      kind: "dark small flip",
      lane: 72,
      width: 94,
      start: 93,
      distance: -124,
      delay: "-6s",
      duration: "13s",
    },
    {
      id: "sheep-3",
      type: "sheep",
      kind: "light big",
      lane: 108,
      width: 150,
      start: 116,
      distance: -150,
      delay: "-4s",
      duration: "16s",
    },
    {
      id: "sheep-4",
      type: "sheep",
      kind: "dark big flip",
      lane: 30,
      width: 144,
      start: 70,
      distance: -100,
      delay: "-11s",
      duration: "18s",
    },
    {
      id: "sheep-5",
      type: "sheep",
      kind: "light tiny reverse",
      lane: 150,
      width: 76,
      start: -18,
      distance: 118,
      delay: "-9s",
      duration: "12s",
    },
    {
      id: "sheep-6",
      type: "sheep",
      kind: "light small",
      lane: 86,
      width: 90,
      start: 42,
      distance: -74,
      delay: "-7s",
      duration: "10s",
    },
    {
      id: "sheep-7",
      type: "sheep",
      kind: "dark small",
      lane: 166,
      width: 96,
      start: 118,
      distance: -148,
      delay: "-14s",
      duration: "15s",
    },
    {
      id: "dog",
      type: "dog",
      kind: "dog",
      lane: 10,
      width: 92,
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
    <svg
      class="actor {actor.kind}"
      data-flock-actor={actor.type}
      viewBox={actor.type === "dog" ? "0 0 96 58" : "0 0 150 96"}
      style:--lane={`${actor.lane}px`}
      style:--start={`${actor.start}vw`}
      style:--distance={`${actor.distance}vw`}
      style:--delay={actor.delay}
      style:--duration={actor.duration}
      style:--actor-width={`${actor.width}px`}
      role="img"
    >
      {#if actor.type === "dog"}
        <g class="sprite dog-sprite">
          <path
            class="dog-line body"
            data-dog-body
            d="M19 37 C24 23 39 20 51 28 L70 26 C78 25 84 31 84 39"
          />
          <path class="dog-line head" d="M20 37 L11 27 L20 19 L33 29" />
          <path class="dog-line ear" d="M17 24 L13 12 L27 21" />
          <path class="dog-line tail" d="M81 31 C91 24 94 16 91 8" />
          <path class="dog-line legs" d="M38 35 L32 50 M60 34 L65 50" />
          <circle class="dog-eye" cx="22" cy="27" r="2.4" />
        </g>
      {:else}
        <g class="sprite sheep-sprite">
          <path
            class="sheep-leg rear"
            d="M42 61 L38 88 M64 63 L62 88 M92 62 L95 88 M110 60 L115 86"
          />
          <path
            class="wool base"
            data-sheep-body
            d="M35 59
               C20 58 14 45 22 34
               C17 22 30 12 43 18
               C50 4 71 6 77 20
               C89 8 107 17 106 32
               C121 30 130 43 124 56
               C130 68 115 78 101 71
               C91 83 72 80 68 68
               C56 80 37 75 35 59Z"
          />
          <circle class="wool puff" cx="34" cy="39" r="16" />
          <circle class="wool puff" cx="52" cy="24" r="18" />
          <circle class="wool puff" cx="76" cy="25" r="20" />
          <circle class="wool puff" cx="99" cy="37" r="18" />
          <circle class="wool puff" cx="54" cy="58" r="20" />
          <circle class="wool puff" cx="84" cy="60" r="19" />
          <path
            class="face"
            d="M112 40
               C128 35 141 45 140 60
               C139 76 122 81 112 69
               C105 61 104 46 112 40Z"
          />
          <path class="ear" d="M117 43 C116 30 130 28 132 40 C127 41 122 43 117 43Z" />
          <path class="snout" d="M127 62 C131 64 135 63 137 60" />
          <circle class="eye" cx="127" cy="53" r="3" />
          <path class="tail" d="M22 48 C11 46 9 56 18 60" />
        </g>
      {/if}
    </svg>
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
    width: var(--actor-width);
    height: auto;
    color: var(--color-ink-bright);
    opacity: 0.62;
    overflow: visible;
    transform: translate3d(var(--start), 0, 0);
    animation:
      flock-cross var(--duration) linear var(--delay) infinite,
      flock-wiggle 0.58s ease-in-out var(--delay) infinite alternate;
  }
  .actor.big {
    opacity: 0.56;
  }
  .actor.tiny {
    opacity: 0.54;
  }
  .actor.dark {
    color: var(--color-slate);
    opacity: 0.66;
  }
  .actor.dog {
    color: var(--color-amber);
    opacity: 0.82;
    animation:
      flock-cross var(--duration) linear var(--delay) infinite,
      dog-loop 0.46s ease-in-out var(--delay) infinite alternate;
  }
  .sprite {
    transform-origin: center;
  }
  .actor.flip .sprite {
    transform: translateX(150px) scaleX(-1);
  }
  .actor.dog.flip .sprite {
    transform: translateX(96px) scaleX(-1);
  }
  .wool {
    fill: currentColor;
    stroke: color-mix(in srgb, currentColor 64%, var(--color-bg));
    stroke-width: 3;
    stroke-linejoin: round;
  }
  .wool.base {
    opacity: 0.82;
  }
  .wool.puff {
    opacity: 0.96;
  }
  .face,
  .ear {
    fill: var(--color-bg);
    stroke: currentColor;
    stroke-width: 4;
    stroke-linejoin: round;
  }
  .tail,
  .snout,
  .eye {
    fill: none;
    stroke: currentColor;
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .eye {
    fill: currentColor;
    stroke: none;
  }
  .sheep-leg {
    fill: none;
    stroke: currentColor;
    stroke-width: 5;
    stroke-linecap: round;
  }
  .sheep-leg.rear {
    opacity: 0.82;
  }
  .dog-line {
    fill: none;
    stroke: currentColor;
    stroke-width: 4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .dog-eye {
    fill: currentColor;
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
      opacity: 0.26;
    }
    .actor.big {
      opacity: 0.24;
    }
    .actor.dog {
      opacity: 0.38;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .actor {
      animation: none;
    }
  }
</style>
