<script lang="ts">
  import { onMount } from "svelte";
  import { theme } from "$lib/theme.svelte";

  let { placement = "backdrop" }: { placement?: "backdrop" | "sheet" } = $props();

  // The system hint is read here rather than off the controller because the
  // controller samples it once at module init — before a test can install its
  // matchMedia stub. The explicit preference still wins over whatever it says.
  let systemReduced = $state(false);
  onMount(() => {
    systemReduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  });
  const reducedMotion = $derived(
    theme.motion === "full" ? false : theme.motion === "reduced" ? true : systemReduced,
  );

  /** Ground-plane depth. Everything visual hangs off this, so an actor can't end
   *  up small-but-fast or near-but-high: far is smaller, higher (closer to the
   *  horizon), fainter and slower; near is bigger, lower, stronger and quicker. */
  type Depth = "far" | "mid" | "near";

  type Actor = {
    id: string;
    type: "sheep" | "dog";
    depth: Depth;
    /** Travel direction along the ground: -1 leftwards, +1 rightwards. */
    dir: -1 | 1;
    /** Where it sits at t=0, in vw — expressed as a delay against the crossing. */
    at: number;
    /** Composed resting spot (vw) for the static, reduced-motion tableau. */
    rest: number;
    tone?: "slate";
  };

  /** Seconds for one full crossing, per depth. Near is fastest — that is the
   *  parallax. The dog gets its own, quicker pace so it gains on the flock
   *  instead of drifting along with it. */
  const PACE: Record<Depth, number> = { far: 19, mid: 14, near: 10 };
  const DOG_PACE = 8.5;
  /** Gait period per depth: a nearer animal visibly steps faster. */
  const STEP: Record<Depth, number> = { far: 0.9, mid: 0.72, near: 0.58 };

  /** The crossing spans START → START + TRAVEL, both well outside the viewport. */
  const START = 120;
  const TRAVEL = 140;

  // The whole flock moves one way and the dog works it from behind — that is the
  // premise, so there is no counter-walking straggler. Facing is derived from
  // `dir` below, never listed per actor: hand-kept flip flags are exactly how
  // four of the seven sheep ended up moon-walking.
  const actors: Actor[] = [
    { id: "sheep-far-1", type: "sheep", depth: "far", dir: -1, at: 70, rest: 20 },
    { id: "sheep-far-2", type: "sheep", depth: "far", dir: -1, at: 18, rest: 58, tone: "slate" },
    { id: "sheep-mid-1", type: "sheep", depth: "mid", dir: -1, at: 92, rest: 8 },
    { id: "sheep-mid-2", type: "sheep", depth: "mid", dir: -1, at: 46, rest: 40, tone: "slate" },
    { id: "sheep-mid-3", type: "sheep", depth: "mid", dir: -1, at: 5, rest: 72 },
    { id: "sheep-near-1", type: "sheep", depth: "near", dir: -1, at: 78, rest: 26 },
    { id: "sheep-near-2", type: "sheep", depth: "near", dir: -1, at: 30, rest: 62, tone: "slate" },
    { id: "dog", type: "dog", depth: "near", dir: -1, at: 100, rest: 88 },
  ];

  /** Static grass, sitting on the same ground lines the animals walk. */
  const tufts: { id: string; depth: Depth; x: number }[] = [
    { id: "t1", depth: "far", x: 12 },
    { id: "t2", depth: "far", x: 47 },
    { id: "t3", depth: "far", x: 81 },
    { id: "t4", depth: "mid", x: 28 },
    { id: "t5", depth: "mid", x: 66 },
    { id: "t6", depth: "near", x: 15 },
    { id: "t7", depth: "near", x: 71 },
  ];

  const VIEWBOX = { sheep: { w: 160, h: 100 }, dog: { w: 120, h: 76 } };

  /** The sprites are drawn facing right; anything travelling left is mirrored. */
  const facing = (a: Actor) => (a.dir < 0 ? "left" : "right");
  const pace = (a: Actor) => (a.type === "dog" ? DOG_PACE : PACE[a.depth]);
  /** Off-screen entry edge: right for a leftward walk, left for a rightward one. */
  const origin = (a: Actor) => -START * a.dir;
  /** Negative delay = start the crossing mid-flight, so `at` is the t=0 spot. */
  const delay = (a: Actor) => -(pace(a) * Math.abs(a.at - origin(a))) / TRAVEL;
</script>

<div
  class="flock {placement}"
  class:reduced={reducedMotion}
  data-flock={placement}
  data-reduced={reducedMotion ? "true" : "false"}
  aria-hidden="true"
>
  <div class="pasture">
    <div class="ground"></div>
    <div class="horizon"></div>

    {#each tufts as tuft (tuft.id)}
      <svg
        class="tuft {tuft.depth}"
        viewBox="0 0 24 14"
        style:--x={`${tuft.x}vw`}
        aria-hidden="true"
        ><path d="M4 14 C4 8 3 5 1 2 M12 14 C12 6 12 4 12 1 M20 14 C20 8 21 5 23 3" /></svg
      >
    {/each}

    {#each actors as actor (actor.id)}
      <svg
        class="actor {actor.depth} {actor.type}"
        class:slate={actor.tone === "slate"}
        data-flock-actor={actor.type}
        data-facing={facing(actor)}
        viewBox="0 0 {VIEWBOX[actor.type].w} {VIEWBOX[actor.type].h}"
        style:--vb={VIEWBOX[actor.type].w}
        style:--start={`${origin(actor)}vw`}
        style:--distance={`${TRAVEL * actor.dir}vw`}
        style:--rest={`${actor.rest}vw`}
        style:--delay={`${delay(actor).toFixed(2)}s`}
        style:--pace={`${pace(actor)}s`}
        style:--step={`${STEP[actor.depth]}s`}
        role="img"
      >
        {#if actor.type === "dog"}
          <g class="facing">
            <!-- far pair first: drawn under the body, so it reads as the off side -->
            <g class="legs far"><path d="M25 42 L22 65 M68 44 L72 65" /></g>
            <path class="tail" d="M16 34 C7 36 2 32 1 25" />
            <!-- Collie proportions: long lean barrel, tucked waist, deep chest. -->
            <path
              class="silhouette"
              data-dog-body
              d="M16 34 C14 26 22 21 32 23 C44 20 56 21 64 25 C72 26 76 30 76 36
                 C74 43 68 47 60 46 C52 47 46 41 40 41 C30 42 17 41 16 34Z"
            />
            <g class="legs near"><path d="M32 43 L28 67 M60 45 L64 67" /></g>
            <g class="head">
              <path
                class="silhouette"
                d="M70 26 C72 18 80 14 88 17 C96 19 100 24 104 26 C110 27 112 30 108 32
                   C102 34 94 34 88 32 C80 32 72 31 70 26Z"
              />
              <path class="ear" d="M76 19 L75 7 C79 5 83 9 87 14Z" />
              <circle class="eye" cx="88" cy="24" r="2" />
            </g>
          </g>
        {:else}
          <g class="facing">
            <g class="legs far"><path d="M40 60 L38 88 M92 60 L94 88" /></g>
            <path class="tail" d="M20 44 C10 40 6 50 14 55" />
            <path
              class="silhouette"
              data-sheep-body
              d="M22 54 C10 50 10 34 24 31 C22 18 38 12 48 20 C54 6 76 6 82 19
                 C94 8 112 15 111 30 C124 30 126 46 114 52 C116 62 104 68 96 63
                 C88 72 70 71 64 63 C52 70 30 66 22 54Z"
            />
            <path class="curl" d="M40 34 C46 28 54 30 56 36 M66 28 C72 22 82 24 84 30" />
            <path class="curl" d="M50 50 C56 44 66 46 68 52" />
            <g class="legs near"><path d="M54 62 L52 90 M104 60 L108 90" /></g>
            <g class="head">
              <path
                class="silhouette"
                d="M110 38 C122 31 142 33 149 43 C155 51 150 62 140 64 C128 66 112 56 110 38Z"
              />
              <!-- after the head, or its own silhouette fill swallows the ear -->
              <path class="ear" d="M121 39 C112 31 116 21 126 25 C127 31 125 36 121 39Z" />
              <path class="snout" d="M141 58 C145 59 148 57 149 54" />
              <circle class="eye" cx="130" cy="45" r="2.6" />
            </g>
          </g>
        {/if}
      </svg>
    {/each}
  </div>
</div>

<style>
  .flock {
    pointer-events: none;
    overflow: hidden;
    user-select: none;
    contain: paint;
    /* Sprite sizes scale as one, so the composition holds when the band shrinks. */
    --scale: 1;
  }
  .flock.backdrop {
    position: absolute;
    inset: auto 0 0;
    height: min(42dvh, 340px);
    z-index: 0;
  }
  .flock.sheet {
    display: none;
  }

  /* The pasture is the scene: the animals' lanes and the horizon are percentages
     of THIS box, so the band can change height without anything clipping. */
  .pasture {
    position: absolute;
    inset: auto 0 0;
    height: 100%;
  }
  /* Ground below the horizon — a barely-there lift, not a fill. */
  .ground {
    position: absolute;
    inset: auto 0 0;
    height: 44%;
    background: linear-gradient(
      to bottom,
      color-mix(in srgb, var(--color-ink-bright) 4%, transparent),
      transparent
    );
  }
  .horizon {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 44%;
    height: 1px;
    background: var(--color-line-bright);
    /* Faded ends so it reads as distance, not as a rule drawn across the screen. */
    -webkit-mask-image: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
    mask-image: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
  }

  .tuft,
  .actor {
    position: absolute;
    left: 0;
    height: auto;
    overflow: visible;
    color: var(--color-ink-bright);
  }
  /* Depth drives size, lane, opacity and pace together — see the Depth type. */
  .far {
    bottom: 28%;
    opacity: 0.3;
  }
  .mid {
    bottom: 16%;
    opacity: 0.44;
  }
  .near {
    bottom: 4%;
    opacity: 0.6;
  }
  .actor.far {
    width: calc(72px * var(--scale));
  }
  .actor.mid {
    width: calc(106px * var(--scale));
  }
  .actor.near {
    width: calc(152px * var(--scale));
  }
  .actor.slate {
    color: var(--color-slate);
  }
  .actor.dog {
    width: calc(130px * var(--scale));
    color: var(--color-amber);
    opacity: 0.78;
  }
  .tuft {
    color: var(--color-line-bright);
    transform: translate3d(var(--x), 0, 0);
  }
  .tuft.far {
    width: calc(16px * var(--scale));
  }
  .tuft.mid {
    width: calc(24px * var(--scale));
  }
  .tuft.near {
    width: calc(34px * var(--scale));
  }
  .tuft path {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
  }

  .actor {
    transform: translate3d(var(--start), 0, 0);
    animation:
      flock-cross var(--pace) linear var(--delay) infinite,
      flock-bob var(--step) ease-in-out var(--delay) infinite alternate;
  }
  /* `translate`/`rotate` are independent of `transform`, so the bob and the gait
     compose with the crossing instead of overwriting it. */
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
      translate: 0 -1.5px;
    }
    to {
      translate: 0 1.5px;
    }
  }

  .actor[data-facing="left"] .facing {
    transform: translateX(calc(var(--vb) * 1px)) scaleX(-1);
  }

  .legs {
    transform-box: fill-box;
    transform-origin: top center;
    animation: step var(--step) ease-in-out var(--delay) infinite alternate;
  }
  /* The two pairs swing in opposite phase — that is what makes it a walk. */
  .legs.near {
    animation-direction: alternate-reverse;
  }
  @keyframes step {
    from {
      rotate: -8deg;
    }
    to {
      rotate: 8deg;
    }
  }

  /* The dog works the flank: it pendulums across the ground plane (toward and
     away from the camera) while it gains on the flock, and its tail wags. */
  .actor.dog .facing {
    animation: dog-weave 2.6s ease-in-out var(--delay) infinite alternate;
  }
  @keyframes dog-weave {
    from {
      translate: 0 -5px;
    }
    to {
      translate: 0 6px;
    }
  }
  .actor.dog .tail {
    transform-box: fill-box;
    transform-origin: bottom left;
    animation: wag 0.3s ease-in-out var(--delay) infinite alternate;
  }
  @keyframes wag {
    from {
      rotate: -16deg;
    }
    to {
      rotate: 16deg;
    }
  }

  /* Line art throughout. The silhouettes carry the page ground as their fill so
     overlapping animals occlude each other cleanly instead of blending into a
     muddle of half-transparent shapes. */
  .silhouette {
    fill: var(--color-bg);
    stroke: currentColor;
    stroke-width: 3;
    stroke-linejoin: round;
  }
  .ear {
    fill: var(--color-bg);
    stroke: currentColor;
    stroke-width: 2.6;
    stroke-linejoin: round;
  }
  .curl,
  .snout,
  .tail {
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .legs path {
    fill: none;
    stroke: currentColor;
    stroke-width: 3.4;
    stroke-linecap: round;
  }
  .eye {
    fill: currentColor;
  }

  /* Resting state. Positions come from the actor data, not from an nth-child
     ladder that silently drifts the moment the list is reordered. */
  .flock.reduced .actor,
  .flock.reduced .actor .facing,
  .flock.reduced .legs,
  .flock.reduced .tail {
    animation: none;
  }
  .flock.reduced .actor {
    transform: translate3d(var(--rest), 0, 0);
    translate: none;
  }
  /* Heads down: a flock at rest is a flock grazing. */
  .flock.reduced .actor:not(.dog) .head {
    transform-box: fill-box;
    transform-origin: left center;
    rotate: 24deg;
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
      --scale: 0.62;
    }
    /* No ground band on a phone. The sheet's commit list carries `flex-grow: 1`
       and an opaque `--color-inset` background, so it eats the screen and the
       only strip left at the bottom is the action row — a pasture there lands
       the whole herd across the "Updating…" button. The animals spread over the
       full sheet instead and show through the gaps between the opaque boxes:
       same sprites, same gait, same derived facing, framed as a backdrop rather
       than a scene. The horizon and tufts only make sense on real ground. */
    .flock.sheet .ground,
    .flock.sheet .horizon,
    .flock.sheet .tuft {
      display: none;
    }
    .flock.sheet .far {
      bottom: 62%;
    }
    .flock.sheet .mid {
      bottom: 38%;
    }
    .flock.sheet .near {
      bottom: 14%;
    }
    .flock.sheet .actor {
      opacity: 0.26;
    }
    .flock.sheet .actor.dog {
      opacity: 0.34;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .actor,
    .actor .facing,
    .legs,
    .tail {
      animation: none;
    }
  }
</style>
