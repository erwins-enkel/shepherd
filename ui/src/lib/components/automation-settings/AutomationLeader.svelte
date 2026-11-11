<script lang="ts">
  import { onMount } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { getInstance, getRepoConfigProject, type RepoConfigProject } from "#lib/api.js";
  import { repos } from "#lib/repos.svelte.js";
  import type { RepoConfigEditor } from "../repo-settings/repo-config-editor.svelte.js";
  import GlossaryTerm from "../GlossaryTerm.svelte";
  let { editor, repoPath }: { editor: RepoConfigEditor; repoPath: string } = $props();
  let candidates = $state<RepoConfigProject["machines"]>([]);
  let error = $state(false);
  let self = $state<{ instanceId: string; name: string } | null>(null);
  const status = $derived(editor.view?.leitrechnerStatus);
  const selected = $derived(
    "leitrechner" in editor.draft ? editor.draft.leitrechner : editor.view?.leitrechner,
  );
  const message = $derived(
    status?.pauseReason === "config_refresh_failed"
      ? m.automation_layers_refresh_failed()
      : status?.pauseReason === "leitrechner_unreachable"
        ? m.automation_layers_offline()
        : status?.role === "unknown"
          ? m.automation_layers_unknown()
          : status?.role === "local"
            ? m.automation_layers_local_leader()
            : status?.role === "remote"
              ? m.automation_layers_remote()
              : m.automation_layers_none(),
  );
  async function load() {
    error = false;
    try {
      self = await getInstance();
      editor.localName = self.name;
      editor.machineNames = { ...editor.machineNames, [self.instanceId]: self.name };
      if (!repos.loaded) await repos.load();
      const entry = repos.entries.find(
        (repo) => repo.path === repoPath || repo.realPath === repoPath,
      );
      if (entry?.remoteSlug) {
        candidates = (await getRepoConfigProject(entry.remoteSlug)).machines;
        editor.machineNames = {
          ...editor.machineNames,
          ...Object.fromEntries(candidates.map((machine) => [machine.instanceId, machine.name])),
        };
      }
    } catch {
      error = true;
    }
  }
  onMount(load);
</script>

<div class="leader">
  <p>
    <GlossaryTerm id="leitrechner" label={m.automation_layers_leader()} />: {status?.name ??
      status?.instanceId ??
      m.automation_layers_none()}
  </p>
  {#if status?.instanceId && status.reachable !== null}<p>
      {status.reachable ? m.automation_layers_reachable() : m.automation_layers_unreachable()}
    </p>{/if}
  <p role="status">{message}</p>
  <p>{m.automation_layers_running()}</p>
  {#if editor.shareable}
    <label
      >{m.automation_layers_leader_change()}
      <select
        class="afield-num afield-select"
        value={selected ?? ""}
        disabled={editor.saving}
        onchange={(event) => editor.setLeader(event.currentTarget.value || null)}
      >
        <option value="">{m.automation_layers_none()}</option>
        {#if self}<option value={self.instanceId}>{self.name}</option>{/if}
        {#each candidates.filter((machine) => machine.instanceId !== self?.instanceId && machine.membership === "present" && machine.reachable) as machine (machine.instanceId)}<option
            value={machine.instanceId}>{machine.name}</option
          >{/each}
        {#if selected && selected !== self?.instanceId && !candidates.some((machine) => machine.instanceId === selected && machine.membership === "present" && machine.reachable)}<option
            value={selected}>{status?.name ?? selected}</option
          >{/if}
      </select>
    </label>
  {/if}
  {#if error}<p role="alert">{m.automation_layers_candidates_error()}</p>
    <button class="gbtn" onclick={load}>{m.automation_layers_retry()}</button>{/if}
</div>

<style>
  .leader {
    padding: 0 12px 12px;
    font-size: var(--fs-meta);
  }
  p {
    margin: 6px 0;
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  select {
    width: 100%;
    min-width: 0;
  }
</style>
