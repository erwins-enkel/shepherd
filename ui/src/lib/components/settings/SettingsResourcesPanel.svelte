<script lang="ts">
  import { onMount } from "svelte";
  import { getSettings, getHeavySlot, putHeavyResources } from "#lib/api.js";
  import type { HeavyResourceSettings, HeavySlotSnapshot } from "#lib/types.js";
  import { formatBytes } from "#lib/components/heavy-slot/heavy-slot.js";
  import { m } from "#lib/paraglide/messages.js";
  import SettingRow from "./SettingRow.svelte";
  import SettingToggle from "./SettingToggle.svelte";
  import ResourceCommandList from "./ResourceCommandList.svelte";
  import "./settings-controls.css";

  let { query = "" }: { query?: string } = $props();
  let settings = $state<HeavyResourceSettings | null>(null);
  let snapshot = $state<HeavySlotSnapshot | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state("");
  let liveFailed = $state(false);
  let confirmOff = $state(false);
  const waiting = $derived(snapshot?.waiters.length ?? 0);
  const disabled = $derived(busy || !settings?.enabled);
  const limits = $derived([
    { key: "minAvailableMiB" as const, label: m.resources_ram(), min: 64, max: 1048576 },
    { key: "psiFullMax" as const, label: m.resources_psi(), min: 1, max: 100 },
    { key: "releaseHoldSec" as const, label: m.resources_release(), min: 1, max: 3600 },
  ]);

  onMount(() => {
    let disposed = false;
    let refreshing = false;
    async function refresh() {
      if (refreshing) return;
      refreshing = true;
      try {
        const value = await getHeavySlot();
        if (!disposed) {
          snapshot = value;
          liveFailed = false;
        }
      } catch {
        if (!disposed) liveFailed = true;
      } finally {
        refreshing = false;
      }
    }
    void getSettings()
      .then((s) => {
        if (!disposed) settings = s.heavySlot ?? null;
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) loading = false;
      });
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  });

  async function save(patch: Parameters<typeof putHeavyResources>[0]) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      settings = (await putHeavyResources(patch)).heavySlot;
      confirmOff = false;
      try {
        snapshot = await getHeavySlot();
        liveFailed = false;
      } catch {
        liveFailed = true;
      }
    } catch {
      error = m.resources_save_failed();
    } finally {
      busy = false;
    }
  }

  async function toggle() {
    if (!settings || busy) return;
    if (!settings.enabled) return save({ enabled: true });
    busy = true;
    try {
      snapshot = await getHeavySlot();
      liveFailed = false;
    } catch {
      liveFailed = true;
      return;
    } finally {
      busy = false;
    }
    if (waiting > 0) confirmOff = true;
    else await save({ enabled: false });
  }

  async function waitChange(event: Event, mode = false) {
    const input = event.currentTarget as HTMLInputElement | HTMLSelectElement;
    if (!input.reportValidity()) return;
    await save({ waitMinutes: mode ? (input.value === "block" ? 5 : 0) : Number(input.value) });
    input.value = mode
      ? settings!.waitMinutes > 0
        ? "block"
        : "inform"
      : String(settings!.waitMinutes);
  }

  async function numberChange(event: Event, key: "slots" | keyof HeavyResourceSettings["brake"]) {
    const input = event.currentTarget as HTMLInputElement;
    if (!settings || !input.reportValidity()) return;
    const value = input.value === "" ? null : input.valueAsNumber;
    await save(key === "slots" ? { slots: value } : { brake: { ...settings.brake, [key]: value } });
    input.value = String((key === "slots" ? settings.slots : settings.brake[key]) ?? "");
  }
</script>

<p class="hint">{m.resources_scope()}</p>
{#if loading}
  <p>{m.common_loading()}</p>
{:else if !settings}
  <p role="alert">{m.resources_unavailable()}</p>
{:else}
  <SettingRow title={m.resources_enabled()} {query} inlineOnMobile>
    {#snippet control()}<SettingToggle
        label={m.resources_enabled()}
        checked={settings!.enabled}
        disabled={busy}
        onchange={toggle}
      />{/snippet}
  </SettingRow>
  {#if confirmOff}
    <div class="confirm" role="alert">
      <p>{m.resources_disable_warning({ count: waiting })}</p>
      <button class="set-gbtn" disabled={busy} onclick={() => save({ enabled: false })}
        >{m.resources_disable_confirm()}</button
      >
      <button class="set-gbtn" disabled={busy} onclick={() => (confirmOff = false)}
        >{m.common_cancel()}</button
      >
    </div>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <h3>{m.resources_now()}</h3>
  {#if liveFailed}<p role="status">{m.resources_live_failed()}</p>
  {:else if snapshot}
    <p class="live">
      {settings!.enabled
        ? m.resources_live({
            held: snapshot.holders.length,
            capacity: snapshot.capacity,
            waiting,
            ram: formatBytes(snapshot.pressure.ramAvailableBytes),
            psi:
              snapshot.pressure.memFullAvg10 === null ? "–" : `${snapshot.pressure.memFullAvg10}%`,
          })
        : m.resources_off()}
    </p>
    {#if settings!.enabled && snapshot.brake.active}<p class="warning">
        {m.resources_braking()}
      </p>{/if}
  {/if}
  <fieldset {disabled}>
    <SettingRow
      title={m.resources_slots()}
      description={m.resources_default({ value: settings!.defaults.slots })}
      {query}
    >
      {#snippet control()}<input
          class="set-num"
          type="number"
          min="1"
          max="64"
          step="1"
          aria-label={m.resources_slots()}
          value={settings!.slots ?? ""}
          placeholder={String(settings!.defaults.slots)}
          onchange={(e) => numberChange(e, "slots")}
        />{/snippet}
    </SettingRow>
    <SettingRow title={m.resources_wait()} description={m.resources_wait_hint()} {query}>
      {#snippet control()}
        <span class="set-select"
          ><select
            aria-label={m.resources_wait()}
            value={settings!.waitMinutes > 0 ? "block" : "inform"}
            onchange={(e) => waitChange(e, true)}
          >
            <option value="inform">{m.resources_inform()}</option><option value="block"
              >{m.resources_block()}</option
            >
          </select></span
        >
      {/snippet}
    </SettingRow>
    {#if settings!.waitMinutes > 0}
      <SettingRow title={m.resources_minutes()} {query}>
        {#snippet control()}<input
            class="set-num"
            type="number"
            min="1"
            max="60"
            step="1"
            required
            aria-label={m.resources_minutes()}
            value={settings!.waitMinutes}
            onchange={(e) => waitChange(e)}
          />{/snippet}
      </SettingRow>
    {/if}
    <h3>{m.resources_heavy()}</h3>
    <ResourceCommandList {settings} {disabled} onsave={(heavyList) => save({ heavyList })} />
    <h3>{m.resources_brake()}</h3>
    <p class="hint">{m.resources_brake_hint()}</p>
    {#each limits as limit (limit.key)}
      <SettingRow
        title={limit.label}
        description={m.resources_default({ value: settings!.defaults[limit.key] })}
        {query}
      >
        {#snippet control()}<input
            class="set-num"
            type="number"
            min={limit.min}
            max={limit.max}
            step="1"
            aria-label={limit.label}
            value={settings!.brake[limit.key] ?? ""}
            placeholder={String(settings!.defaults[limit.key])}
            onchange={(e) => numberChange(e, limit.key)}
          />{/snippet}
      </SettingRow>
    {/each}
  </fieldset>
  <h3>{m.resources_foreign()}</h3>
  <p class="hint">
    {m.resources_foreign_hint({
      bytes: formatBytes(snapshot?.memoryBySource.foreignBytes ?? null),
    })}
  </p>
  {#each snapshot?.memoryBySource.foreignTop ?? [] as process (process.name)}<p class="live">
      {process.name}: {formatBytes(process.bytes)}
    </p>{/each}
{/if}

<style>
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  fieldset:disabled {
    opacity: 0.5;
  }
  h3 {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    margin: 20px 0 8px;
  }
  .hint,
  .live {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .live {
    font-variant-numeric: tabular-nums;
  }
  .confirm {
    padding: 10px;
    border: 1px solid var(--color-amber);
  }
  .confirm p,
  .warning {
    color: var(--color-amber);
  }
  .confirm button {
    margin: 4px 8px 4px 0;
  }
</style>
