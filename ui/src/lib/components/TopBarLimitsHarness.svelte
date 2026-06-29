<!--
  Test-only harness for TopBar.browser.test.ts.

  Reproduces the production async ordering of usage limits faithfully: `limits`
  lives in internal $state (starts as the passed-in value, typically null) and is
  flipped LATER via the exported setLimits(), mirroring how store.usageLimits is
  null on first paint and populated by a snapshot/SSE afterwards. Flipping only this
  one piece of state — not the whole prop bag — is what makes the test exercise the
  real reactivity path (gauges appearing must re-trigger the measure effect), rather
  than the spurious full-props re-read that vitest-browser-svelte's rerender() causes.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import TopBar from "./TopBar.svelte";
  import type { Session, UsageLimits, UpdateStatus } from "$lib/types";

  let {
    sessions,
    nowMs,
    connected = false,
    mobile = false,
    touch = false,
    learnings = 0,
    update = null,
    initialLimits = null,
    initialHeldCount = 0,
  }: {
    sessions: Session[];
    nowMs: number;
    connected?: boolean;
    mobile?: boolean;
    touch?: boolean;
    learnings?: number;
    update?: UpdateStatus | null;
    /** Seed for the internal `limits` $state. Defaults to null so the gauge-arrival
     *  test (which flips null→populated via setLimits) is unaffected; the held test
     *  seeds it with gauges already present and constant. */
    initialLimits?: UsageLimits | null;
    /** Seed for the internal `heldCount` $state, flipped later via setHeld(). */
    initialHeldCount?: number;
  } = $props();

  // Starts at the seed (null by default → no gauges) — the production first-paint state.
  // The gauge-arrival test flips it to a populated value AFTER mount via setLimits(),
  // reproducing the async snapshot/SSE arrival. Seeded once from the prop on purpose
  // (the prop is a one-time initial value; later changes come through setLimits()).
  let limits = $state<UsageLimits | null>(untrack(() => initialLimits));

  export function setLimits(next: UsageLimits | null) {
    limits = next;
  }

  // Held tasks arrive async via the held:changed WS event. The held test flips ONLY this
  // after mount via setHeld() — the same single-state-change faithfulness setLimits gives
  // the gauge test — so held arrival is the sole change the measure effect must react to.
  let heldCount = $state(untrack(() => initialHeldCount));

  export function setHeld(next: number) {
    heldCount = next;
  }
</script>

<!--
  Replicate production's .shell box-capping: TopBar sits inside a fixed-width
  flex-column (+page.svelte .shell). As a stretched flex child the .hud gets the
  shell's inner width and CANNOT grow past it — overflow goes to scrollWidth, the
  border-box stays put. That capping is load-bearing for this test: without it the
  unconstrained .hud border-box would itself widen when gauges appear, the
  ResizeObserver would fire and self-heal, and the reactivity bug would be invisible.
  The host width is set by the test via document.body.style.width on this wrapper.
-->
<div class="shell-cap">
  <TopBar
    {sessions}
    {nowMs}
    {connected}
    {mobile}
    {touch}
    {limits}
    {learnings}
    {update}
    {heldCount}
  />
</div>

<style>
  .shell-cap {
    display: flex;
    flex-direction: column;
    width: 100%;
  }
</style>
