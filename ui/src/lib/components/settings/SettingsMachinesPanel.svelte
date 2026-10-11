<script lang="ts">
  import { onMount } from "svelte";
  import { getInstance, listRemoteInstances, renameInstance } from "#lib/api.js";
  import type { InstanceIdentity, RemoteInstance } from "#lib/types.js";
  import { platformLabel } from "#lib/machines.js";
  import MachineRow from "./MachineRow.svelte";
  import MachineConnectForm from "./MachineConnectForm.svelte";
  import HighlightText from "./HighlightText.svelte";
  import GlossaryText from "#lib/components/GlossaryText.svelte";
  import "./settings-controls.css";
  import "./machines.css";
  import { m } from "#lib/paraglide/messages.js";

  // Settings → Machines (#2759): this Shepherd's own identity, the other Shepherds it is connected
  // to, and the form to connect one. Mounted only while the section is shown, and only then does it
  // poll — the server checks every machine once a minute; this just picks up the result.
  let { query = "" }: { query?: string } = $props();

  const POLL_MS = 10_000;

  let self = $state<InstanceIdentity | null>(null);
  let selfFailed = $state(false);
  let editingName = $state(false);
  let nameDraft = $state("");
  let savingName = $state(false);
  let nameError = $state("");

  let machines = $state<RemoteInstance[]>([]);
  let loading = $state(true);
  let loadFailed = $state(false);
  let now = $state(Date.now());

  async function loadSelf() {
    try {
      self = await getInstance();
      selfFailed = false;
    } catch {
      selfFailed = true;
    }
  }

  async function loadMachines() {
    try {
      machines = (await listRemoteInstances()).instances;
      loadFailed = false;
    } catch {
      loadFailed = true;
    } finally {
      loading = false;
      now = Date.now();
    }
  }

  function upsert(instance: RemoteInstance) {
    const known = machines.some((x) => x.instanceId === instance.instanceId);
    machines = known
      ? machines.map((x) => (x.instanceId === instance.instanceId ? instance : x))
      : [...machines, instance];
    now = Date.now();
  }

  function drop(instanceId: string) {
    machines = machines.filter((x) => x.instanceId !== instanceId);
  }

  function startRename() {
    nameDraft = self?.name ?? "";
    nameError = "";
    editingName = true;
  }

  async function saveName(e: SubmitEvent) {
    e.preventDefault();
    if (savingName) return;
    savingName = true;
    nameError = "";
    try {
      self = await renameInstance(nameDraft.trim() || null);
      editingName = false;
    } catch {
      nameError = m.settings_machines_rename_failed();
    } finally {
      savingName = false;
    }
  }

  onMount(() => {
    void loadSelf();
    void loadMachines();
    const timer = setInterval(() => void loadMachines(), POLL_MS);
    return () => clearInterval(timer);
  });
</script>

<p class="mch-hint"><GlossaryText text={m.settings_machines_intro()} /></p>

<div class="mch-block">
  <span class="mch-micro"><HighlightText text={m.settings_machines_self_title()} {query} /></span>
  {#if self}
    <dl class="mch-facts">
      <dt>{m.settings_machines_name_label()}</dt>
      <dd>{self.name}</dd>
      <dt>{m.settings_machines_id_label()}</dt>
      <dd class="mch-mono">{self.instanceId}</dd>
      <dt>{m.settings_machines_version_label()}</dt>
      <dd>{self.version}</dd>
      <dt>{m.settings_machines_platform_label()}</dt>
      <dd>{platformLabel(self.platform)} · {self.arch}</dd>
    </dl>
    {#if editingName}
      <form class="mch-form" onsubmit={saveName}>
        <label class="mch-fld">
          <span class="mch-lbl">{m.settings_machines_name_label()}</span>
          <input
            class="mch-txt"
            type="text"
            bind:value={nameDraft}
            maxlength="64"
            disabled={savingName}
          />
        </label>
        <button type="submit" class="mch-run" disabled={savingName}>{m.common_save()}</button>
        <button
          type="button"
          class="set-gbtn"
          disabled={savingName}
          onclick={() => (editingName = false)}>{m.common_cancel()}</button
        >
      </form>
      <p class="mch-hint">{m.settings_machines_self_hint()}</p>
    {:else}
      <div class="mch-actions">
        <button type="button" class="set-gbtn" onclick={startRename}
          >{m.settings_machines_rename()}</button
        >
      </div>
    {/if}
    {#if nameError}<p class="mch-hint mch-err" role="alert">{nameError}</p>{/if}
  {:else if selfFailed}
    <p class="mch-hint mch-err" role="alert">{m.settings_machines_self_load_failed()}</p>
  {:else}
    <p class="mch-hint">{m.common_loading()}</p>
  {/if}
</div>

<div class="mch-block">
  <span class="mch-micro"><HighlightText text={m.settings_machines_list_title()} {query} /></span>
  {#if loading}
    <p class="mch-hint">{m.common_loading()}</p>
  {:else if machines.length === 0 && !loadFailed}
    <p class="mch-hint">{m.settings_machines_empty()}</p>
  {:else}
    <ul class="mch-list">
      {#each machines as machine (machine.instanceId)}
        <MachineRow {machine} {now} onchange={upsert} onremove={drop} />
      {/each}
    </ul>
  {/if}
  {#if loadFailed}
    <p class="mch-hint mch-err" role="alert">{m.settings_machines_load_failed()}</p>
    <div class="mch-actions">
      <button type="button" class="set-gbtn" onclick={loadMachines}>{m.common_retry()}</button>
    </div>
  {/if}
</div>

<MachineConnectForm {query} onconnected={upsert} />
