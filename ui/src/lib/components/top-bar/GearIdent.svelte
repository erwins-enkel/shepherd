<script lang="ts">
  import type { Snippet } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { version } from "$lib/build-info";

  // Identity header shared by the desktop telemetry popover and the mobile sheet
  // (design handoff 3b/3c): brand mark · build version · connection readout.
  // Connectivity stays in the neutral ink ramp — brightness, not a status hue,
  // carries the cue (canon; not the reference's green).
  let {
    connected,
    mobile = false,
    children,
  }: {
    connected: boolean;
    mobile?: boolean;
    /** Optional trailing content (the sheet's explicit ✕) — styled by the caller. */
    children?: Snippet;
  } = $props();
</script>

<div class={["ident", { mobile }]}>
  <span class="ident-brand">SHEPHERD</span>
  <span class="ident-conn">
    v{version} · <span class="ident-dot" class:on={connected} aria-hidden="true">●</span>
    {connected ? m.gearmenu_conn_live() : m.gearmenu_conn_offline()}
  </span>
  {@render children?.()}
</div>

<style>
  .ident {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .ident-brand {
    font-size: var(--fs-micro);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .ident-conn {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  .ident-dot {
    color: var(--color-faint);
  }
  .ident-dot.on {
    color: var(--color-ink-bright);
  }
  /* Sheet scale: larger type, sheet gutters, panel ground (the sheet header is not
     a separate head-tinted bar — the grab handle already caps the surface). */
  .ident.mobile {
    padding: 6px 20px 10px;
    background: transparent;
  }
  .ident.mobile .ident-brand,
  .ident.mobile .ident-conn {
    font-size: var(--fs-meta);
  }
</style>
