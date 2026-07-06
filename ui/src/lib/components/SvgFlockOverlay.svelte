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
      lane: 22,
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
      lane: 70,
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
      lane: 104,
      width: 146,
      start: 116,
      distance: -150,
      delay: "-4s",
      duration: "16s",
    },
    {
      id: "sheep-4",
      type: "sheep",
      kind: "dark big flip",
      lane: 24,
      width: 140,
      start: 70,
      distance: -100,
      delay: "-11s",
      duration: "18s",
    },
    {
      id: "sheep-5",
      type: "sheep",
      kind: "light small",
      lane: 146,
      width: 90,
      start: 82,
      distance: -114,
      delay: "-9s",
      duration: "12s",
    },
    {
      id: "sheep-6",
      type: "sheep",
      kind: "light small flip",
      lane: 86,
      width: 88,
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
      width: 86,
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
      viewBox={actor.type === "dog" ? "0 0 92 54" : "0 0 148 92"}
      style:--lane={`${actor.lane}px`}
      style:--start={`${actor.start}vw`}
      style:--distance={`${actor.distance}vw`}
      style:--delay={actor.delay}
      style:--duration={actor.duration}
      style:--actor-width={`${actor.width}px`}
      role="img"
    >
      {#if actor.type === "dog"}
        <g class="sprite">
          <path class="dog-body" d="M18 34 C22 22 35 19 46 25 L66 23 C73 22 79 27 80 34" />
          <path class="dog-head" d="M18 34 L11 25 L20 19 L31 27" />
          <path class="dog-ear" d="M16 23 L12 12 L25 20" />
          <path class="dog-tail" d="M77 28 C86 21 89 14 88 8" />
          <path class="dog-leg" d="M36 32 L31 46 M57 31 L61 46" />
          <circle class="dog-eye" cx="21" cy="26" r="2" />
        </g>
      {:else}
        <g class="sprite">
          <path class="leg rear" d="M43 62 L39 86 M65 64 L63 86 M91 63 L94 86 M108 60 L113 84" />
          <path
            class="wool mass"
            d="M35 58
               C20 57 14 44 22 34
               C16 22 29 12 42 18
               C49 4 70 6 75 19
               C87 8 105 16 104 31
               C119 29 129 42 123 55
               C129 67 114 77 101 70
               C91 82 72 79 68 67
               C56 79 37 74 35 58Z"
          />
          <circle class="wool puff" cx="34" cy="38" r="16" />
          <circle class="wool puff" cx="52" cy="24" r="18" />
          <circle class="wool puff" cx="75" cy="25" r="20" />
          <circle class="wool puff" cx="98" cy="36" r="18" />
          <circle class="wool puff" cx="54" cy="57" r="20" />
          <circle class="wool puff" cx="83" cy="59" r="19" />
          <path
            class="face"
            d="M111 39
               C126 34 140 44 139 59
               C138 75 121 80 111 68
               C104 60 103 45 111 39Z"
          />
          <path class="ear" d="M116 42 C115 29 128 27 131 39 C126 40 121 42 116 42Z" />
          <path class="snout" d="M126 61 C130 63 134 62 136 59" />
          <circle class="eye" cx="126" cy="52" r="3" />
          <path class="tail" d="M22 47 C11 45 9 55 18 59" />
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
      flock-bob 0.56s ease-in-out var(--delay) infinite alternate;
  }
  .actor.big {
    opacity: 0.56;
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
      dog-bound 0.48s ease-in-out var(--delay) infinite alternate;
  }
  .sprite {
    transform-origin: center;
  }
  .actor.flip .sprite {
    transform: translateX(148px) scaleX(-1);
  }
  .actor.dog.flip .sprite {
    transform: translateX(92px) scaleX(-1);
  }
  .wool {
    fill: currentColor;
    stroke: color-mix(in srgb, currentColor 64%, var(--color-bg));
    stroke-width: 3;
    stroke-linejoin: round;
  }
  .wool.mass {
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
  .leg {
    fill: none;
    stroke: currentColor;
    stroke-width: 5;
    stroke-linecap: round;
  }
  .leg.rear {
    opacity: 0.82;
  }
  .dog-body,
  .dog-head,
  .dog-ear,
  .dog-tail,
  .dog-leg {
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
  @keyframes flock-bob {
    from {
      translate: 0 -3px;
    }
    to {
      translate: 0 4px;
    }
  }
  @keyframes dog-bound {
    from {
      translate: 0 -6px;
    }
    to {
      translate: 0 5px;
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
