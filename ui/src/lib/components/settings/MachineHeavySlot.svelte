<script lang="ts">
  import type { RemoteInstance } from "#lib/types.js";
  import { ramUsedPct, slotEnabled } from "#lib/components/heavy-slot/heavy-slot.js";
  import { formatAgo } from "#lib/format.js";
  import { m } from "#lib/paraglide/messages.js";

  // A machine's check slot (#3181) as of its last answered check: budget in use, who is queued,
  // the memory brake and RAM. Read-only — the budget is set on the machine itself. When the
  // machine is out of reach this is its last known state, said so.
  let { slot, now }: { slot: RemoteInstance["heavySlot"]; now: number } = $props();

  const snap = $derived(slot?.snapshot ?? null);
  const ram = $derived(snap ? ramUsedPct(snap) : null);
</script>

<div class="mch-caps" data-heavy-slot>
  <span class="mch-meta">
    {m.settings_machines_slot_title()}
    {#if slot?.stale}
      <span class="mch-badge mch-warn" data-stale
        >{m.settings_machines_slot_stale({ ago: formatAgo(now - slot.readAt) })}</span
      >
    {/if}
  </span>
  {#if !slot || !snap}
    <span class="mch-meta">{m.settings_machines_slot_none()}</span>
  {:else if !slotEnabled(snap)}
    <span class="mch-meta">{m.settings_machines_slot_off()}</span>
  {:else}
    <ul class="mch-chips">
      <li class="mch-chip">
        {m.settings_machines_slot_held({ held: snap.holders.length, capacity: snap.capacity })}
      </li>
      {#if snap.waiters.length > 0}
        <li class="mch-chip">{m.settings_machines_slot_waiting({ count: snap.waiters.length })}</li>
      {/if}
      {#if snap.brake.active}
        <li class="mch-chip mch-warn" data-brake>{m.settings_machines_slot_brake()}</li>
      {/if}
      {#if ram !== null}
        <li class="mch-chip">{m.settings_machines_slot_ram({ pct: ram })}</li>
      {/if}
    </ul>
  {/if}
  {#if slot?.stale}<p class="mch-hint mch-warn">{m.settings_machines_slot_stale_hint()}</p>{/if}
</div>
