<script lang="ts">
  import type { HeavyResourceSettings } from "#lib/types.js";
  import { formatBytes } from "#lib/components/heavy-slot/heavy-slot.js";
  import { m } from "#lib/paraglide/messages.js";
  let {
    settings,
    disabled,
    onsave,
  }: {
    settings: HeavyResourceSettings;
    disabled: boolean;
    onsave: (list: HeavyResourceSettings["heavyList"]) => Promise<void>;
  } = $props();
  let command = $state("");
  let subcommands = $state("");
  let editing = $state(false);
  const entries = $derived([
    ...new Map(
      [...settings.defaults.heavyList, ...settings.heavyList.custom].map((e) => [e.command, e]),
    ).values(),
  ]);
  function toggle(name: string) {
    const off = settings.heavyList.disabled;
    void onsave({
      ...settings.heavyList,
      disabled: off.includes(name) ? off.filter((n) => n !== name) : [...off, name],
    });
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await onsave({
      custom: [
        ...settings.heavyList.custom.filter((e) => e.command !== command),
        { command, subcommands: subcommands.trim().split(/\s+/).filter(Boolean) },
      ],
      disabled: settings.heavyList.disabled.filter((n) => n !== command),
    });
  }
</script>

<p class="hint">{m.resources_list_hint()}</p>
<ul>
  {#each entries as entry (entry.command)}
    {@const custom = settings.heavyList.custom.some((e) => e.command === entry.command)}
    <li>
      <label
        ><input
          type="checkbox"
          checked={!settings.heavyList.disabled.includes(entry.command)}
          {disabled}
          aria-label={m.resources_enable_command({ command: entry.command })}
          onchange={() => toggle(entry.command)}
        /><code>{entry.command} {entry.subcommands.join(" / ")}</code></label
      >
      <span class="source"
        >{custom ? m.resources_source_custom() : m.resources_source_default()}</span
      >
      <span class="peak"
        >{m.resources_peak({ peak: formatBytes(settings.peaks[entry.command] ?? null) })}</span
      >
      <button
        class="set-gbtn"
        {disabled}
        aria-label={m.resources_edit_command({ command: entry.command })}
        onclick={() => {
          command = entry.command;
          subcommands = entry.subcommands.join(" ");
          editing = true;
        }}>{m.resources_edit()}</button
      >
      {#if custom}<button
          class="set-gbtn"
          {disabled}
          aria-label={m.resources_remove_command({ command: entry.command })}
          onclick={() =>
            onsave({
              ...settings.heavyList,
              custom: settings.heavyList.custom.filter((e) => e.command !== entry.command),
            })}>{m.resources_remove()}</button
        >{/if}
    </li>
  {/each}
</ul>
{#if editing}
  <form onsubmit={submit}>
    <label
      >{m.resources_command()}<input
        bind:value={command}
        required
        pattern="[A-Za-z0-9][A-Za-z0-9._+\-]*"
        maxlength="64"
        {disabled}
      /></label
    >
    <label>{m.resources_subcommands()}<input bind:value={subcommands} {disabled} /></label>
    <button class="set-gbtn" type="submit" {disabled}>{m.common_save()}</button>
    <button class="set-gbtn" type="button" {disabled} onclick={() => (editing = false)}
      >{m.common_cancel()}</button
    >
  </form>
{:else}
  <button
    class="set-gbtn"
    {disabled}
    onclick={() => {
      command = "";
      subcommands = "";
      editing = true;
    }}>{m.resources_add()}</button
  >
{/if}

<style>
  ul {
    list-style: none;
    padding: 0;
    margin: 0 0 12px;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px 0;
    border-bottom: 1px solid var(--color-line);
  }
  li label {
    display: flex;
    gap: 8px;
    align-items: center;
    min-width: 0;
  }
  code {
    overflow-wrap: anywhere;
    font: inherit;
  }
  .source,
  .peak,
  .hint {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .peak {
    flex-basis: 100%;
    font-variant-numeric: tabular-nums;
  }
  form {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 120px;
  }
  form input {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    border-radius: 2px;
    min-width: 0;
  }
  form input:focus-visible {
    outline: 1px solid var(--color-amber);
  }
  button {
    min-height: 32px;
  }
  @media (pointer: coarse) {
    button,
    li label {
      min-height: 44px;
    }
  }
</style>
