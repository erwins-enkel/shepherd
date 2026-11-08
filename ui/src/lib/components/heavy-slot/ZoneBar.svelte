<script lang="ts">
  import type { Zones } from "./heavy-slot";

  // A bar cut at the brake line: grey used, solid red used past the line, green still free before
  // it, hatched red the brake zone. `mini` is the chip's 30px glance (no hatching: too small to
  // read); `swatch` draws one zone's legend key instead of a bar.
  let {
    zones = null,
    mini = false,
    swatch = null,
  }: { zones?: Zones | null; mini?: boolean; swatch?: keyof Zones | null } = $props();

  const ORDER = ["used", "over", "free", "reserve"] as const;
  // Grow factors in thousandths, so the zones fill the bar whatever their rounding; empty zones
  // are left out so they leave no gap.
  const parts = $derived(
    zones
      ? ORDER.filter((k) => zones[k] > 0).map((k) => ({ k, grow: Math.round(zones[k] * 1000) }))
      : [],
  );
</script>

{#if swatch}
  <span class="sw z-{swatch}" aria-hidden="true"></span>
{:else}
  <span class="zb" class:zb-mini={mini} aria-hidden="true">
    {#each parts as p (p.k)}<span class="z z-{p.k}" style:flex-grow={p.grow}></span>{/each}
  </span>
{/if}

<style>
  .zb {
    display: flex;
    gap: 2px;
    height: 8px;
    margin: 2px 0 4px;
  }
  .zb.zb-mini {
    display: inline-flex;
    gap: 1px;
    width: 30px;
    height: 6px;
    margin: 0;
  }
  .z {
    flex-basis: 0;
    min-width: 2px;
  }
  .zb-mini .z {
    min-width: 1px;
  }
  .sw {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 5px;
    vertical-align: -1px;
  }
  .z-used {
    background: var(--color-faint);
  }
  .z-over {
    background: var(--color-red);
  }
  .z-free {
    background: color-mix(in srgb, var(--color-green) 70%, transparent);
  }
  .z-reserve {
    background: repeating-linear-gradient(
      135deg,
      color-mix(in srgb, var(--color-red) 65%, transparent) 0 2px,
      color-mix(in srgb, var(--color-red) 15%, transparent) 2px 5px
    );
  }
  .zb-mini .z-reserve {
    background: color-mix(in srgb, var(--color-red) 55%, transparent);
  }
</style>
