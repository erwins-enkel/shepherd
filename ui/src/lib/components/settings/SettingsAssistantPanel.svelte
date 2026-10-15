<script lang="ts">
  import { untrack } from "svelte";
  import { putAssistantPermissions } from "#lib/api.js";
  import {
    ASSISTANT_ACTION_GROUPS,
    ASSISTANT_ACTION_LEVELS,
    ASSISTANT_SHELL_LEVELS,
    type AssistantActionGroup,
    type AssistantPermissions,
    type Settings,
  } from "#lib/types.js";
  import {
    assistantActionLevelLabel,
    assistantGroupHint,
    assistantGroupTitle,
    assistantShellLevelLabel,
  } from "#lib/assistant-permissions.js";
  import {
    assistantGroupExplanation,
    assistantShellExplanation,
  } from "#lib/tooltips/explanations.js";
  import SettingRow from "./SettingRow.svelte";
  import "./settings-controls.css";
  import { toasts } from "#lib/toasts.svelte.js";
  import { m } from "#lib/paraglide/messages.js";

  // Settings → Assistant: what the Operator Assistant may do. One row for the shell, one per action
  // group, each saved on its own. Seeded once from the parent's getSettings() payload; the server
  // answers every save with the whole merged set, and its `operator-assistant:update` frame carries
  // the change to the panel chip.
  let { payload, query = "" }: { payload: Settings | null; query?: string } = $props();

  let perms = $state<AssistantPermissions | null>(null);
  let saved: AssistantPermissions | null = null;
  let busy = $state(false);

  let seeded = false;
  $effect(() => {
    if (!payload || seeded) return;
    seeded = true;
    const p = payload.assistantPermissions;
    untrack(() => {
      if (!p) return; // an older server: no section to edit
      perms = { ...p };
      saved = { ...p };
    });
  });

  async function save(key: keyof AssistantPermissions) {
    if (busy || !perms || !saved) return;
    busy = true;
    try {
      const r = await putAssistantPermissions({ [key]: perms[key] });
      perms = { ...r.assistantPermissions };
      saved = { ...r.assistantPermissions };
    } catch {
      perms = { ...saved };
      toasts.info(m.settings_assistant_save_failed(), {
        key: "assistant-permissions",
        alert: true,
      });
    } finally {
      busy = false;
    }
  }
</script>

<p class="asp-intro">{m.settings_assistant_intro()}</p>

{#if perms}
  <SettingRow
    title={m.settings_assistant_shell_title()}
    description={m.settings_assistant_shell_hint()}
    explanation={assistantShellExplanation()}
    {query}
  >
    {#snippet control()}
      <span class="set-select">
        <select
          bind:value={perms!.shell}
          disabled={busy}
          aria-label={m.settings_assistant_shell_title()}
          onchange={() => save("shell")}
        >
          {#each ASSISTANT_SHELL_LEVELS as level (level)}
            <option value={level}>{assistantShellLevelLabel(level)}</option>
          {/each}
        </select>
        <span class="set-chev" aria-hidden="true">▾</span>
      </span>
    {/snippet}
  </SettingRow>

  {#each ASSISTANT_ACTION_GROUPS as group (group)}
    {@render groupRow(group)}
  {/each}
{:else if !payload}
  <p class="asp-intro">{m.common_loading()}</p>
{/if}

{#snippet groupRow(group: AssistantActionGroup)}
  <SettingRow
    title={assistantGroupTitle(group)}
    description={assistantGroupHint(group)}
    explanation={assistantGroupExplanation(group)}
    {query}
  >
    {#snippet control()}
      <span class="set-select">
        <select
          bind:value={perms![group]}
          disabled={busy}
          aria-label={assistantGroupTitle(group)}
          onchange={() => save(group)}
        >
          {#each ASSISTANT_ACTION_LEVELS as level (level)}
            <option value={level}>{assistantActionLevelLabel(level)}</option>
          {/each}
        </select>
        <span class="set-chev" aria-hidden="true">▾</span>
      </span>
    {/snippet}
  </SettingRow>
{/snippet}

<style>
  .asp-intro {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0 0 12px;
  }
</style>
