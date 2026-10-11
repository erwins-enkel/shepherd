<script lang="ts">
  import type { CapabilityReport } from "#lib/types.js";
  import { availableCapabilities, missingCapabilities } from "#lib/machines.js";
  import { formatAgo } from "#lib/format.js";
  import GlossaryText from "#lib/components/GlossaryText.svelte";
  import { m } from "#lib/paraglide/messages.js";

  // A machine's verified capabilities (#2770): what it checked it can run, how old that check is,
  // and what is missing and why. The age is the server's `ageMs` (clock-skew free) and staleness is
  // the server's verdict; this only renders them.
  let { report }: { report: CapabilityReport | null | undefined } = $props();

  const available = $derived(report ? availableCapabilities(report) : []);
  const missing = $derived(report ? missingCapabilities(report) : []);
</script>

<div class="mch-caps" data-capabilities>
  {#if report}
    <span class="mch-meta">
      <GlossaryText text={m.settings_machines_caps_checked({ ago: formatAgo(report.ageMs) })} />
      {#if report.stale}
        <span class="mch-badge mch-warn" data-stale>{m.settings_machines_caps_stale()}</span>
      {/if}
    </span>
    {#if available.length > 0}
      <ul class="mch-chips">
        {#each available as label (label)}<li class="mch-chip">{label}</li>{/each}
      </ul>
    {/if}
    {#if missing.length > 0}
      <span class="mch-meta">{m.settings_machines_caps_missing({ list: missing.join(" · ") })}</span
      >
    {/if}
    {#if report.stale}<p class="mch-hint mch-warn">{m.settings_machines_caps_stale_hint()}</p>{/if}
  {:else}
    <span class="mch-meta"><GlossaryText text={m.settings_machines_caps_none()} /></span>
  {/if}
</div>
