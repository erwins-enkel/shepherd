<script lang="ts">
  import { onMount } from "svelte";
  import { getLastUpdate, getUpdate } from "#lib/api.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { UpdateCallRecord } from "#lib/types.js";
  import { updateCallOrigin } from "#lib/update-call.js";
  import SettingRow from "./SettingRow.svelte";

  // Who last updated this Shepherd (#3623). The server keeps the rest: every call, refused ones
  // included, stays in its signals and log.
  let { query = "" }: { query?: string } = $props();
  let running = $state<string | null>(null);
  let last = $state<UpdateCallRecord | null>(null);
  let loading = $state(true);
  let failed = $state(false);

  onMount(async () => {
    try {
      const [status, lastCall] = await Promise.all([getUpdate(), getLastUpdate()]);
      running = status.current;
      last = lastCall;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  });

  const lastLine = $derived.by(() => {
    if (!last) return m.settings_update_last_none();
    const time = new Date(last.at).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const origin = updateCallOrigin(last);
    return last.outcome === "applied"
      ? m.settings_update_last_applied({ time, origin })
      : m.settings_update_last_started({ time, origin });
  });
</script>

{#if loading}
  <p class="hint">{m.common_loading()}</p>
{:else if failed}
  <p class="hint err" role="alert">{m.settings_update_load_failed()}</p>
{:else}
  <SettingRow title={m.settings_update_running_title()} {query}>
    {#snippet control()}<code class="sha">{running ?? "—"}</code>{/snippet}
  </SettingRow>
  <SettingRow title={m.settings_update_last_title()} description={lastLine} {query}>
    {#snippet control()}
      {#if last?.from && last.to}<code class="sha">{last.from} → {last.to}</code>{/if}
    {/snippet}
  </SettingRow>
{/if}

<style>
  .hint {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  .err {
    color: var(--color-red);
  }
  .sha {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }
</style>
