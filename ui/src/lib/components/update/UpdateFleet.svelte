<script lang="ts">
  import type { MachineUpdate } from "#lib/types.js";
  import { getInstance } from "#lib/api.js";
  import { m } from "#lib/paraglide/messages.js";
  import { machineReachable, type MachinePhase } from "#lib/machine-updates.js";
  import type { LocalUpdate } from "./local-update.svelte.js";
  import UpdateLocalRow from "./UpdateLocalRow.svelte";
  import UpdateMachineRow from "./UpdateMachineRow.svelte";

  // The update window with machines connected: this Shepherd is one row among them. "Update all"
  // starts every machine that is behind at once and runs this one last: its update restarts the
  // server and reloads this page, which would end the following of the others.
  let {
    local,
    machines,
    onclose,
    blocking = $bindable(false),
  }: {
    local: LocalUpdate;
    machines: MachineUpdate[];
    onclose?: () => void;
    /** Out: something runs that closing the window would cut off. */
    blocking?: boolean;
  } = $props();

  let self = $state<{ name: string; platform: string } | null>(null);
  getInstance()
    .then((i) => (self = { name: i.name, platform: i.platform }))
    .catch(() => {});
  const selfName = $derived(self?.name ?? m.updatemodal_this_machine());

  let phases = $state<Record<string, MachinePhase>>({});
  const rows: Record<string, ReturnType<typeof UpdateMachineRow> | undefined> = {};
  const phaseOf = (id: string): MachinePhase => phases[id] ?? "idle";
  // this machine is queued behind the others in an "update all"
  let localQueued = $state(false);

  // Read only for machines still listed: one removed mid-run takes its row along, and its last
  // phase must not hold this machine back (or the window open) forever.
  const listedPhases = $derived(machines.map((mc) => phaseOf(mc.instanceId)));
  const remoteRunning = $derived(listedPhases.some((p) => p === "updating"));
  // still running, or blocked on the operator's decision about a dirty tree
  const remoteUnsettled = $derived(listedPhases.some((p) => p === "updating" || p === "dirty"));
  $effect(() => {
    blocking = local.busy || remoteRunning || localQueued;
  });

  const behind = (mc: MachineUpdate) => machineReachable(mc) && (mc.update?.behind ?? 0) > 0;
  const remotesReady = $derived(
    machines.filter((mc) => behind(mc) && phaseOf(mc.instanceId) === "idle"),
  );
  const localReady = $derived(
    local.update.behind > 0 &&
      !localQueued &&
      (local.mode === "clean" || local.mode === "nowclean" || local.mode === "rawlog"),
  );
  const readyCount = $derived(remotesReady.length + (localReady ? 1 : 0));
  const primaryLabel = $derived(
    readyCount === 1
      ? m.updatemodal_update_named({ name: localReady ? selfName : remotesReady[0]!.name })
      : m.updatemodal_update_all({ count: readyCount }),
  );

  const total = $derived(machines.length + 1);
  const remotePending = $derived(
    machines.filter((mc) => behind(mc) && !["done", "skipped"].includes(phaseOf(mc.instanceId)))
      .length,
  );
  const pending = $derived(remotePending + (local.update.behind > 0 ? 1 : 0));
  const doneCount = $derived(listedPhases.filter((p) => p === "done").length);
  const summary = $derived.by((): { count: number; text: string } => {
    if (blocking)
      return {
        count: doneCount,
        text: m.updatemodal_machines_running({ total: doneCount + pending }),
      };
    if (pending === 0) return { count: total, text: m.updatemodal_machines_all_current({ total }) };
    return {
      count: pending,
      text:
        pending === 1
          ? m.updatemodal_machines_summary_one({ total })
          : m.updatemodal_machines_summary_other({ total }),
    };
  });

  function runAll() {
    let started = 0;
    for (const mc of remotesReady) {
      const row = rows[mc.instanceId];
      if (!row) continue;
      phases[mc.instanceId] = "updating"; // now, so the queue below already sees it running
      void row.start();
      started++;
    }
    if (!localReady) return;
    if (started > 0 || remoteUnsettled) localQueued = true;
    else void local.runUpdate();
  }

  // the others are through (or set aside) → this machine's turn
  $effect(() => {
    if (localQueued && !remoteUnsettled) {
      localQueued = false;
      void local.runUpdate();
    }
  });
</script>

<div class="summary">
  <span class="count">{summary.count}</span>
  <span class="micro">{summary.text}</span>
  {#if local.update.latest}
    <span class="target">{m.updatemodal_target({ sha: local.update.latest })}</span>
  {/if}
</div>

<ul class="machines">
  <UpdateLocalRow
    {local}
    name={selfName}
    platform={self?.platform ?? null}
    tagged={self !== null}
    queued={localQueued}
    locked={remoteRunning || localQueued}
  />
  {#each machines as mc (mc.instanceId)}
    <UpdateMachineRow
      bind:this={rows[mc.instanceId]}
      machine={mc}
      onphase={(p) => (phases[mc.instanceId] = p)}
    />
  {/each}
</ul>

{#if localReady && remotesReady.length > 0 && !blocking}
  <p class="note">
    <svg viewBox="0 0 24 24" aria-hidden="true"
      ><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></svg
    >
    <span>{m.updatemodal_local_last()}</span>
  </p>
{/if}

<div class="actions">
  {#if blocking}
    <button type="button" class="run" disabled>{m.updatemodal_updating()}</button>
  {:else}
    <button type="button" class="later" onclick={() => onclose?.()}>
      {pending === 0 ? m.updatemodal_done() : m.updatemodal_later()}
    </button>
    {#if readyCount > 0}
      <button type="button" class="run" onclick={runAll}>{primaryLabel}</button>
    {/if}
  {/if}
</div>

<style>
  .summary {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 9px;
  }
  .count {
    color: var(--color-amber);
    font-size: var(--fs-2xl);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .target {
    margin-left: auto;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  .machines {
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    margin: 0;
    padding: 0;
    border: 1px solid var(--color-line);
    background: var(--color-panel-2);
  }
  .note {
    margin: 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-muted);
  }
  .note svg {
    flex: none;
    width: 14px;
    height: 14px;
    margin-top: 1px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }
  @media (max-width: 768px) {
    .machines {
      flex-grow: 1; /* fill the sheet so the list, not a void, owns the space */
    }
    /* the target drops under the count instead of squeezing the sentence */
    .target {
      flex-basis: 100%;
      margin-left: 0;
    }
  }
</style>
