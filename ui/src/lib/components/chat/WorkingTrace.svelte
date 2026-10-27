<script lang="ts">
  // The chat's "working" light: an oscilloscope beam sweeping a fixed telemetry trace, its
  // phosphor tail decaying behind it. Every layer draws the same path (pathLength 1) as a single
  // dash of length --l ending at the shared head --wt-head, so the heads ride the trace together.
  // The head overshoots the end so the tails drain before the next sweep. At rest (reduced motion
  // stops all animation) the head's initial value shows a frozen frame with the beam at the end.
  const TRACE =
    "M0 5H6L7.5 4.3L9 5.6L10.5 5H16L17.5 3.6L19 6.3L20.5 5H23L24.5 1L26 9L27.5 2.5L29 7.5L30.5 4L32 5.8L33 5H40";
  const LAYERS = [
    { l: 0.6, opacity: 0.22, width: 1 },
    { l: 0.3, opacity: 0.5, width: 1 },
    { l: 0.12, opacity: 0.9, width: 1.25 },
    { l: 0.001, opacity: 1, width: 2.5 },
  ];
</script>

<svg class="wt" viewBox="0 0 40 10" width="40" height="10" aria-hidden="true">
  <line class="wt-mid" x1="0" y1="5" x2="40" y2="5" />
  {#each LAYERS as layer (layer.l)}
    <path
      class="wt-beam"
      d={TRACE}
      pathLength="1"
      style:--l={layer.l}
      stroke-opacity={layer.opacity}
      stroke-width={layer.width}
    />
  {/each}
</svg>

<style>
  .wt {
    flex: none;
    overflow: visible;
  }
  .wt-mid {
    stroke: var(--color-line);
    stroke-width: 1;
  }
  .wt-beam {
    fill: none;
    stroke: var(--color-amber);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: var(--l) 3;
    stroke-dashoffset: calc(var(--l) - var(--wt-head));
    animation: wt-sweep 1.6s linear infinite;
  }
  /* Registered so it interpolates: var() inside keyframes animates discretely. */
  @property --wt-head {
    syntax: "<number>";
    inherits: false;
    initial-value: 1;
  }
  @keyframes wt-sweep {
    from {
      --wt-head: 0;
    }
    to {
      --wt-head: 1.6;
    }
  }
</style>
