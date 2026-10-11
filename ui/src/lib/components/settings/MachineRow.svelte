<script lang="ts">
  import { checkRemoteInstance, removeRemoteInstance, renameRemoteInstance } from "#lib/api.js";
  import type { RemoteInstance } from "#lib/types.js";
  import {
    machineHint,
    machineStatusLabel,
    machineStatusTone,
    platformLabel,
  } from "#lib/machines.js";
  import { formatAgo } from "#lib/format.js";
  import { m } from "#lib/paraglide/messages.js";

  // One connected machine (#2759): who it is, whether this Shepherd can reach it right now, and —
  // when it can't — what to do about it. Identity and projects survive a failed check as "last
  // seen" values, so a flapping network does not blank the row.
  let {
    machine,
    now,
    onchange,
    onremove,
  }: {
    machine: RemoteInstance;
    /** When the parent last loaded the list; ages are measured against it. */
    now: number;
    onchange: (instance: RemoteInstance) => void;
    onremove: (instanceId: string) => void;
  } = $props();

  let busy = $state(false);
  let checking = $state(false);
  let editing = $state(false);
  let confirming = $state(false);
  let labelDraft = $state("");
  let error = $state("");

  const tone = $derived(machineStatusTone(machine.status));
  const hint = $derived(machineHint(machine.status, machine.reason));
  const seen = $derived.by(() => {
    if (machine.status === "checking") return "";
    if (machine.status === "connected" && machine.checkedAt !== null)
      return m.settings_machines_checked({ ago: formatAgo(now - machine.checkedAt) });
    if (machine.lastSeenAt !== null)
      return m.settings_machines_last_seen({ ago: formatAgo(now - machine.lastSeenAt) });
    return m.settings_machines_never_seen();
  });

  /** Run one row action; any failure shows `failure` and leaves the row as it was. */
  async function act(failure: string, fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await fn();
    } catch {
      error = failure;
    } finally {
      busy = false;
    }
  }

  async function check() {
    checking = true;
    await act(m.settings_machines_check_failed(), async () =>
      onchange(await checkRemoteInstance(machine.instanceId)),
    );
    checking = false;
  }

  function startEdit() {
    labelDraft = machine.label ?? "";
    editing = true;
  }

  const saveLabel = (e: SubmitEvent) => {
    e.preventDefault();
    return act(m.settings_machines_label_failed(), async () => {
      onchange(await renameRemoteInstance(machine.instanceId, labelDraft.trim() || null));
      editing = false;
    });
  };

  const remove = () =>
    act(m.settings_machines_remove_failed(), async () => {
      await removeRemoteInstance(machine.instanceId);
      onremove(machine.instanceId);
    });
</script>

<li class="mch-row" data-machine={machine.instanceId}>
  <div class="mch-main">
    <span class="mch-title">
      <span class="mch-name">{machine.name}</span>
      <span class="mch-badge mch-{tone}" data-status={machine.status}
        >{machineStatusLabel(machine.status)}</span
      >
    </span>
    <span class="mch-meta mch-mono">{machine.url}</span>
    {#if machine.info}
      <span class="mch-meta">
        {machine.info.version} · {platformLabel(machine.info.platform)} · {machine.info.arch} ·
        <span class="mch-mono" title={machine.instanceId}>{machine.instanceId.slice(0, 8)}</span>
      </span>
    {/if}
    {#if hint}<p class="mch-hint" class:mch-err={tone === "bad"}>{hint}</p>{/if}
    <span class="mch-meta">
      {seen}{#if machine.tokenHint}{seen ? " · " : ""}<span class="mch-mono"
          >{m.settings_machines_token({ hint: machine.tokenHint })}</span
        >{/if}
    </span>
    {#if machine.projects}
      <details class="mch-projects">
        <summary>{m.settings_machines_projects({ count: machine.projects.length })}</summary>
        {#if machine.projects.length === 0}
          <p class="mch-hint">{m.settings_machines_projects_none()}</p>
        {:else}
          <ul>
            {#each machine.projects as slug (slug)}<li>{slug}</li>{/each}
          </ul>
        {/if}
      </details>
    {/if}
    {#if editing}
      <form class="mch-form" onsubmit={saveLabel}>
        <label class="mch-fld">
          <span class="mch-lbl"
            >{m.settings_machines_label_aria({ name: machine.reportedName })}</span
          >
          <input
            class="mch-txt"
            type="text"
            bind:value={labelDraft}
            maxlength="64"
            disabled={busy}
            placeholder={machine.reportedName}
          />
        </label>
        <button type="submit" class="mch-run" disabled={busy}>{m.common_save()}</button>
        <button type="button" class="set-gbtn" disabled={busy} onclick={() => (editing = false)}
          >{m.common_cancel()}</button
        >
      </form>
      <p class="mch-hint">{m.settings_machines_label_hint()}</p>
    {/if}
    {#if confirming}<p class="mch-hint">{m.settings_machines_remove_hint()}</p>{/if}
    {#if error}<p class="mch-hint mch-err" role="alert">{error}</p>{/if}
  </div>
  <div class="mch-actions">
    {#if confirming}
      <button type="button" class="set-gbtn danger" disabled={busy} onclick={remove}
        >{m.settings_machines_remove_yes()}</button
      >
      <button type="button" class="set-gbtn" disabled={busy} onclick={() => (confirming = false)}
        >{m.common_cancel()}</button
      >
    {:else}
      <button type="button" class="set-gbtn" disabled={busy} onclick={check}
        >{checking ? m.settings_machines_status_checking() : m.settings_machines_check()}</button
      >
      <button type="button" class="set-gbtn" disabled={busy || editing} onclick={startEdit}
        >{m.settings_machines_rename()}</button
      >
      <button
        type="button"
        class="set-gbtn"
        disabled={busy}
        onclick={() => (confirming = true)}
        aria-label={m.settings_machines_remove_aria({ name: machine.name })}
        >{m.settings_machines_remove()}</button
      >
    {/if}
  </div>
</li>
