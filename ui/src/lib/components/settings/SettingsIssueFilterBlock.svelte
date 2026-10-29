<script lang="ts">
  import { onMount, tick } from "svelte";
  import { issueFilterSettings } from "#lib/issue-filter-settings.svelte.js";
  import type { IssueFilterForks, IssueFilterScope, IssueFilterSettings } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { isHiddenLabel } from "../up-next-filter";
  import SettingsGroup from "./SettingsGroup.svelte";
  import SettingRow from "./SettingRow.svelte";
  import SettingToggle from "./SettingToggle.svelte";
  import "./settings-controls.css";

  // Settings › Workspace "Default issue filter" (#3019): the same server-side setting the Up Next
  // flyout and the Backlog / New Task filter popover write, so a change here shows there live
  // (settings:issue-filter push) and the other way round.
  let { query = "" }: { query?: string } = $props();

  let open = $state(true);
  let adding = $state(false);
  let draft = $state("");
  let inputEl = $state<HTMLInputElement>();

  onMount(() => void issueFilterSettings.ensureLoaded());

  const filter = $derived(issueFilterSettings.value);

  const SCOPES: { value: IssueFilterScope; label: () => string }[] = [
    { value: "all", label: m.upnext_filter_scope_all },
    { value: "mine_unassigned", label: m.upnext_filter_scope_mine_unassigned },
    { value: "mine", label: m.upnext_filter_scope_mine },
  ];
  const FORKS: { value: IssueFilterForks; label: () => string }[] = [
    { value: "all", label: m.upnext_filter_forks_all },
    { value: "own", label: m.upnext_filter_forks_own },
    { value: "hide", label: m.upnext_filter_forks_hide },
  ];
  type ToggleKey = "hideActive" | "hideSubIssues" | "hideBlocked";
  const TOGGLES: { key: ToggleKey; title: () => string; desc: () => string }[] = [
    { key: "hideActive", title: m.issues_filter_active_label, desc: m.issues_filter_active_title },
    {
      key: "hideSubIssues",
      title: m.issues_filter_subissues_label,
      desc: m.issues_filter_subissues_title,
    },
    {
      key: "hideBlocked",
      title: m.issues_filter_blocked_label,
      desc: m.issues_filter_blocked_title,
    },
  ];

  function set(patch: Partial<IssueFilterSettings>) {
    void issueFilterSettings.update(patch);
  }

  function flip(key: ToggleKey) {
    if (filter) set({ [key]: !filter[key] });
  }

  async function startAdding() {
    adding = true;
    await tick();
    inputEl?.focus();
  }

  function addLabel() {
    const label = draft.trim();
    draft = "";
    adding = false;
    if (!filter || !label || isHiddenLabel(filter, label)) return;
    set({ hiddenLabels: [...filter.hiddenLabels, label] });
  }

  function removeLabel(label: string) {
    if (!filter) return;
    set({ hiddenLabels: filter.hiddenLabels.filter((l) => l !== label) });
  }

  function onInputKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      addLabel();
    } else if (e.key === "Escape") {
      // Cancel the draft only — don't let Escape also close Settings.
      e.stopPropagation();
      draft = "";
      adding = false;
    }
  }
</script>

<SettingsGroup
  label={m.settings_issue_filter_title()}
  count={6}
  expanded={open}
  ontoggle={() => (open = !open)}
>
  <p class="summary">{m.settings_issue_filter_summary()}</p>
  {#if !filter}
    <p class="summary">{m.settings_issue_filter_unavailable()}</p>
  {:else}
    {#snippet segmented(
      name: string,
      options: { value: string; label: () => string }[],
      current: string,
      pick: (v: string) => void,
    )}
      <div class="seg-row" role="group" aria-label={name}>
        {#each options as opt (opt.value)}
          <button
            type="button"
            class={["seg-btn", { "seg-active": current === opt.value }]}
            aria-pressed={current === opt.value}
            onclick={() => pick(opt.value)}>{opt.label()}</button
          >
        {/each}
      </div>
    {/snippet}

    <SettingRow
      title={m.upnext_filter_scope_heading()}
      description={m.settings_issue_filter_scope_desc()}
      {query}
    >
      {#snippet below()}
        {@render segmented(m.upnext_filter_scope_heading(), SCOPES, filter.scope, (v) =>
          set({ scope: v as IssueFilterScope }),
        )}
      {/snippet}
    </SettingRow>
    <SettingRow
      title={m.upnext_filter_forks_heading()}
      description={m.settings_issue_filter_forks_desc()}
      {query}
    >
      {#snippet below()}
        {@render segmented(m.upnext_filter_forks_heading(), FORKS, filter.forks, (v) =>
          set({ forks: v as IssueFilterForks }),
        )}
      {/snippet}
    </SettingRow>
    {#each TOGGLES as t (t.key)}
      <SettingRow
        title={t.title()}
        description={t.desc()}
        {query}
        inlineOnMobile
        onrowclick={() => flip(t.key)}
      >
        {#snippet control()}
          <SettingToggle checked={filter[t.key]} label={t.title()} onchange={() => flip(t.key)} />
        {/snippet}
      </SettingRow>
    {/each}
    <SettingRow
      title={m.upnext_filter_labels_heading()}
      description={m.settings_issue_filter_labels_desc()}
      {query}
    >
      {#snippet below()}
        <div class="labels">
          {#each filter.hiddenLabels as label (label)}
            <span class="lchip">
              <span class="lname">{label}</span>
              <button
                type="button"
                class="lx"
                aria-label={m.settings_issue_filter_remove_label({ label })}
                onclick={() => removeLabel(label)}>×</button
              >
            </span>
          {:else}
            {#if !adding}<span class="none">{m.settings_issue_filter_labels_none()}</span>{/if}
          {/each}
          {#if adding}
            <input
              bind:this={inputEl}
              class="ladd"
              type="text"
              spellcheck="false"
              bind:value={draft}
              placeholder={m.settings_issue_filter_label_placeholder()}
              aria-label={m.settings_issue_filter_label_input_aria()}
              onkeydown={onInputKey}
              onblur={addLabel}
            />
          {:else}
            <button type="button" class="set-gbtn" onclick={startAdding}>
              {m.settings_issue_filter_add_label()}
            </button>
          {/if}
        </div>
      {/snippet}
    </SettingRow>
  {/if}
</SettingsGroup>

<style>
  .summary {
    margin: 10px 0 4px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  /* Segmented control — the /design-system recipe, framed as a field. */
  .seg-row {
    display: flex;
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .seg-btn {
    flex: 1;
    min-width: 0;
    min-height: 32px;
    border: 0;
    border-right: 1px solid var(--color-line);
    background: none;
    font-family: inherit;
    font-size: var(--fs-base);
    color: var(--color-muted);
    cursor: pointer;
    padding: 0 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .seg-btn:last-child {
    border-right: 0;
  }
  .seg-btn:hover {
    color: var(--color-ink);
  }
  .seg-btn.seg-active {
    color: var(--color-amber);
    background: var(--color-inset);
    box-shadow: inset 0 -2px 0 var(--color-amber);
  }
  .seg-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .labels {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .lchip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    padding: 1px 2px 1px 8px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .lname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lx {
    border: 0;
    background: none;
    color: var(--color-muted);
    font: inherit;
    cursor: pointer;
    padding: 0 6px;
  }
  .lx:hover {
    color: var(--color-ink);
  }
  .lx:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .none {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .ladd {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    padding: 2px 8px;
    width: 14em;
    max-width: 100%;
  }
  .ladd:focus {
    outline: none;
    border-color: var(--color-amber);
  }

  @media (max-width: 768px) {
    .seg-btn {
      min-height: 44px;
    }
    .lx {
      min-width: 32px;
      min-height: 32px;
    }
  }
</style>
