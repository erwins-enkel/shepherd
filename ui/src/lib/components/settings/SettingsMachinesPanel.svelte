<script lang="ts">
  import { onMount, tick } from "svelte";
  import {
    checkInstanceCapabilities,
    getInstance,
    getSettings,
    listRemoteInstances,
    putMachinePlatformOrder,
    renameInstance,
  } from "#lib/api.js";
  import type { IncomingMirror, InstanceIdentity, RemoteInstance, Session } from "#lib/types.js";
  import { platformLabel } from "#lib/machines.js";
  import MachineRow from "./MachineRow.svelte";
  import MachineIncomingRow from "./MachineIncomingRow.svelte";
  import MachineConnectForm from "./MachineConnectForm.svelte";
  import MachineCapabilities from "./MachineCapabilities.svelte";
  import HighlightText from "./HighlightText.svelte";
  import GlossaryText from "#lib/components/GlossaryText.svelte";
  import "./settings-controls.css";
  import "./machines.css";
  import { m } from "#lib/paraglide/messages.js";

  // Settings → Machines (#2759): this Shepherd's own identity, the other Shepherds it is connected
  // to, and the form to connect one. Mounted only while the section is shown, and only then does it
  // poll — the server checks every machine once a minute; this just picks up the result. Its own
  // identity is polled too, so the age of its capability check (#2770) stays current. Both
  // directions (#3056): the machines this one mirrors ("You see their sessions") and the Shepherds
  // mirroring this one ("They see your sessions").
  let {
    query = "",
    remoteSessions = [],
  }: {
    query?: string;
    /** The herd's mirrored sessions, counted per machine. */
    remoteSessions?: Session[];
  } = $props();

  const POLL_MS = 10_000;

  let self = $state<InstanceIdentity | null>(null);
  let selfFailed = $state(false);
  let editingName = $state(false);
  let nameDraft = $state("");
  let savingName = $state(false);
  let nameError = $state("");
  let checkingCaps = $state(false);
  let capsError = $state("");

  let machines = $state<RemoteInstance[]>([]);
  let incoming = $state<IncomingMirror[]>([]);
  /** This instance's platform order for the automatic machine choice (#2772); null until loaded
   *  (or on a server that has none). */
  let order = $state<string[] | null>(null);
  let savingOrder = $state(false);
  let orderError = $state("");
  let loading = $state(true);
  let loadFailed = $state(false);
  let now = $state(Date.now());
  /** The connect form is folded behind the list header's toggle until asked for. */
  let connectOpen = $state(false);
  let connectToggle = $state<HTMLButtonElement>();
  /** The name the connect form starts from, and a counter that remounts it for each "Connect
   *  <name> here", so its address takes focus again. */
  let connectName = $state("");
  let connectRound = $state(0);

  const sessionCounts = $derived(
    remoteSessions.reduce((counts, s) => {
      if (s.host) counts.set(s.host.instanceId, (counts.get(s.host.instanceId) ?? 0) + 1);
      return counts;
    }, new Map<string, number>()),
  );
  const mirroredBy = $derived(
    new Set(
      incoming.flatMap((i) => (i.direction === "both" && i.instanceId ? [i.instanceId] : [])),
    ),
  );

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
      ({ instances: machines, incoming } = await listRemoteInstances());
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

  async function closeConnect() {
    connectOpen = false;
    await tick();
    connectToggle?.focus();
  }

  function toggleConnect() {
    connectName = "";
    connectOpen = !connectOpen;
  }

  /** "Connect <name> here" on a Shepherd that mirrors this one one way only. */
  function connectHere(name: string) {
    connectName = name;
    connectRound++;
    connectOpen = true;
  }

  function connected(instance: RemoteInstance) {
    upsert(instance);
    void closeConnect();
    // A Shepherd that already mirrors this one now counts both ways (#3056): show it right away.
    if (incoming.some((i) => i.instanceId === instance.instanceId)) void loadMachines();
  }

  async function checkCapabilities() {
    if (checkingCaps) return;
    checkingCaps = true;
    capsError = "";
    try {
      self = await checkInstanceCapabilities();
    } catch {
      capsError = m.settings_machines_caps_check_failed();
    } finally {
      checkingCaps = false;
    }
  }

  async function loadOrder() {
    try {
      order = (await getSettings()).machinePlatformOrder ?? null;
    } catch {
      order = null;
    }
  }

  async function saveOrder(value: string) {
    if (savingOrder) return;
    savingOrder = true;
    orderError = "";
    try {
      order = (await putMachinePlatformOrder(value.split(","))).machinePlatformOrder;
    } catch {
      orderError = m.settings_machines_order_failed();
    } finally {
      savingOrder = false;
    }
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
    void loadOrder();
    const timer = setInterval(() => {
      void loadSelf();
      void loadMachines();
    }, POLL_MS);
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
    <MachineCapabilities report={self.capabilities} />
    {#if editingName}
      <form class="mch-form" onsubmit={saveName}>
        <label class="mch-fld">
          <span class="mch-lbl">{m.settings_machines_name_label()}</span>
          <input
            class="pui-input"
            type="text"
            bind:value={nameDraft}
            maxlength="64"
            disabled={savingName}
          />
        </label>
        <button type="submit" class="set-gbtn mch-primary" disabled={savingName}
          >{m.common_save()}</button
        >
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
        <button type="button" class="set-gbtn" disabled={checkingCaps} onclick={checkCapabilities}
          >{checkingCaps
            ? m.settings_machines_status_checking()
            : m.settings_machines_caps_check()}</button
        >
      </div>
    {/if}
    {#if nameError}<p class="mch-hint mch-err" role="alert">{nameError}</p>{/if}
    {#if capsError}<p class="mch-hint mch-err" role="alert">{capsError}</p>{/if}
  {:else if selfFailed}
    <p class="mch-hint mch-err" role="alert">{m.settings_machines_self_load_failed()}</p>
  {:else}
    <p class="mch-hint">{m.common_loading()}</p>
  {/if}
</div>

<div class="mch-block">
  <div class="mch-head">
    <span class="mch-micro"><HighlightText text={m.settings_machines_list_title()} {query} /></span>
    <button
      type="button"
      class="set-gbtn"
      aria-expanded={connectOpen}
      bind:this={connectToggle}
      onclick={toggleConnect}
    >
      <span aria-hidden="true">+</span>
      <HighlightText text={m.settings_machines_connect_title()} {query} />
    </button>
  </div>
  {#if loading}
    <p class="mch-hint">{m.common_loading()}</p>
  {:else if machines.length === 0 && !loadFailed}
    <p class="mch-hint">{m.settings_machines_empty()}</p>
  {:else}
    <ul class="mch-list">
      {#each machines as machine (machine.instanceId)}
        <MachineRow
          {machine}
          {now}
          sessionCount={sessionCounts.get(machine.instanceId) ?? 0}
          mirrorsBack={mirroredBy.has(machine.instanceId)}
          onchange={upsert}
          onremove={drop}
        />
      {/each}
    </ul>
  {/if}
  {#if loadFailed}
    <p class="mch-hint mch-err" role="alert">{m.settings_machines_load_failed()}</p>
    <div class="mch-actions">
      <button type="button" class="set-gbtn" onclick={loadMachines}>{m.common_retry()}</button>
    </div>
  {/if}
  {#if connectOpen}
    {#key connectRound}
      <MachineConnectForm name={connectName} onconnected={connected} oncancel={closeConnect} />
    {/key}
  {/if}
</div>

<div class="mch-block">
  <span class="mch-micro"
    ><HighlightText text={m.settings_machines_incoming_title()} {query} /></span
  >
  <p class="mch-hint">{m.settings_machines_incoming_hint()}</p>
  {#if loading}
    <p class="mch-hint">{m.common_loading()}</p>
  {:else if incoming.length === 0 && !loadFailed}
    <p class="mch-hint">{m.settings_machines_incoming_empty()}</p>
  {:else}
    <ul class="mch-list">
      {#each incoming as mirror, i (`${mirror.instanceId}-${mirror.tokenName}-${mirror.since}-${i}`)}
        <MachineIncomingRow {mirror} {machines} {now} onconnect={connectHere} />
      {/each}
    </ul>
  {/if}
</div>

<!-- Only once a machine is connected: before that there is nothing for the order to rank. -->
{#if order && machines.length > 0}
  <!-- The order the automatic machine choice (#2772) ranks fitting machines by. -->
  <div class="mch-block">
    <span class="mch-micro"><HighlightText text={m.settings_machines_order_title()} {query} /></span
    >
    <label class="mch-fld">
      <span class="mch-lbl">{m.settings_machines_order_label()}</span>
      <select
        class="pui-input"
        value={order.join(",")}
        disabled={savingOrder}
        onchange={(e) => saveOrder(e.currentTarget.value)}
      >
        <option value="linux,macos">{m.settings_machines_order_linux_first()}</option>
        <option value="macos,linux">{m.settings_machines_order_macos_first()}</option>
      </select>
    </label>
    <p class="mch-hint">{m.settings_machines_order_note()}</p>
    {#if orderError}<p class="mch-hint mch-err" role="alert">{orderError}</p>{/if}
  </div>
{/if}
