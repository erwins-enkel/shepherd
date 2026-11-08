<script lang="ts" generics="R extends string">
  import type { TooltipExplanation } from "#lib/tooltips/content.js";
  import type { ListEntryCheck } from "#lib/list-entries.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import "../automation-settings/automation-fields.css";

  // A repo setting that is a list of short strings (#3446): browser hosts, extra egress hosts,
  // priority labels. Chips with ×, an add form, and an inline error from `check` — the client
  // mirror of the server's rule, so a refused entry never reaches the PUT. The caller gates
  // visibility and persists the full list through `onchange`.
  let {
    field,
    name,
    explanation,
    items,
    fixed = [],
    check,
    errors,
    placeholder,
    addLabel,
    removeLabel,
    empty = "",
    hint = "",
    onchange,
  }: {
    /** The repo-config key the list writes. */
    field: string;
    /** Row name; also the input's and the form's accessible name. */
    name: string;
    explanation?: TooltipExplanation;
    items: readonly string[];
    /** Always-on entries shown first, without ×; they count for duplicates but aren't stored. */
    fixed?: readonly string[];
    check: (raw: string, existing: readonly string[]) => ListEntryCheck<R>;
    errors: Record<R, () => string>;
    placeholder: string;
    addLabel: string;
    removeLabel: (item: string) => string;
    /** Shown while the list (fixed entries included) is empty. */
    empty?: string;
    hint?: string;
    onchange: (next: string[]) => void;
  } = $props();

  const uid = $props.id();
  const errorId = `${uid}-error`;

  let draft = $state("");
  let error = $state<string | null>(null);

  function add() {
    const r = check(draft, [...fixed, ...items]);
    if (!r.ok) {
      error = errors[r.reason]();
      return;
    }
    error = null;
    draft = "";
    onchange([...items, r.value]);
  }

  function remove(item: string) {
    onchange(items.filter((i) => i !== item));
  }
</script>

<RepoSettingRow {field} {name} {explanation} indent>
  {#snippet below()}
    <div class="list-field">
      {#if fixed.length || items.length}
        <ul class="items">
          {#each fixed as item (item)}
            <li class="item fixed"><span class="item-name">{item}</span></li>
          {/each}
          <!-- Keyed by position: the server doesn't dedupe host lists, so a list set through the API
               can hold a repeat. Removing one removes every copy. -->
          {#each items as item, i (i)}
            <li class="item">
              <span class="item-name">{item}</span>
              <button
                class="item-remove"
                type="button"
                aria-label={removeLabel(item)}
                onclick={() => remove(item)}>×</button
              >
            </li>
          {/each}
        </ul>
      {:else if empty}
        <div class="items-note">{empty}</div>
      {/if}
      <form
        class="drain-field"
        aria-label={name}
        onsubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          class="afield-num txt"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          {placeholder}
          aria-label={name}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          bind:value={draft}
          oninput={() => (error = null)}
        />
        <button class="bs-btn" type="submit">{addLabel}</button>
      </form>
      {#if error}
        <div class="items-error" id={errorId} role="alert">{error}</div>
      {/if}
      {#if hint}
        <div class="items-note">{hint}</div>
      {/if}
    </div>
  {/snippet}
</RepoSettingRow>

<style>
  .list-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
  }
  .items {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 2px 1px 6px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  /* An always-on entry: no ×, so pad it evenly and quiet it. */
  .item.fixed {
    padding: 1px 6px;
    color: var(--color-muted);
  }
  .item-name {
    overflow-wrap: anywhere;
  }
  .item-remove {
    background: transparent;
    border: none;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-base);
    line-height: 1;
    padding: 0 4px;
  }
  .item-remove:hover,
  .item-remove:focus-visible {
    color: var(--color-red);
    outline: none;
  }
  .afield-num[aria-invalid="true"] {
    border-color: var(--color-red);
  }
  .items-error {
    font-size: var(--fs-meta);
    color: var(--color-red);
  }
  .items-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
</style>
