<script lang="ts" module>
  import type { TooltipExplanation } from "#lib/tooltips/content.js";

  /** Why a valid entry deserves a second look (#3922: a risky egress host). */
  export interface ListItemWarning {
    /** Inline note shown when adding it; the next submit of the same entry adds it. */
    text: string;
    /** The ⚠ marker's accessible name on a listed entry. */
    label: string;
    /** The ⚠ marker's hover explanation. */
    explanation: TooltipExplanation;
  }
</script>

<script lang="ts" generics="R extends string">
  import type { ListEntryCheck } from "#lib/list-entries.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
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
    warn,
    addAnywayLabel,
    bare = false,
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
    /** Flags a valid entry as risky: adding it takes a second submit, and its chip gets a ⚠. */
    warn?: (item: string) => ListItemWarning | null;
    /** The add button while a warned entry waits for that second submit. */
    addAnywayLabel?: string;
    /** Just the editor, without its repo-settings row (a host that brings its own row). */
    bare?: boolean;
    onchange: (next: string[]) => void;
  } = $props();

  const uid = $props.id();
  const errorId = `${uid}-error`;

  let draft = $state("");
  let error = $state<string | null>(null);
  /** The warned entry the next submit adds, and its note. */
  let pending = $state<{ value: string; text: string } | null>(null);

  function add() {
    const r = check(draft, [...fixed, ...items]);
    if (!r.ok) {
      error = errors[r.reason]();
      return;
    }
    error = null;
    const w = warn?.(r.value);
    if (w && pending?.value !== r.value) {
      pending = { value: r.value, text: w.text };
      return;
    }
    pending = null;
    draft = "";
    onchange([...items, r.value]);
  }

  function remove(item: string) {
    onchange(items.filter((i) => i !== item));
  }
</script>

{#if bare}
  {@render editor()}
{:else}
  <RepoSettingRow {field} {name} {explanation} indent>
    {#snippet below()}
      {@render editor()}
    {/snippet}
  </RepoSettingRow>
{/if}

{#snippet editor()}
  <div class="list-field">
    {#if fixed.length || items.length}
      <ul class="items">
        {#each fixed as item (item)}
          <li class="item pinned"><span class="item-name">{item}</span></li>
        {/each}
        <!-- Keyed by position: the server doesn't dedupe host lists, so a list set through the API
               can hold a repeat. Removing one removes every copy. -->
        {#each items as item, i (i)}
          {@const w = warn?.(item)}
          <li class={["item", { warned: !!w }]}>
            {#if w}
              <button
                class="item-warn"
                type="button"
                aria-label={w.label}
                use:statusTip={{ text: w.explanation }}>⚠</button
              >
            {/if}
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
        oninput={() => {
          error = null;
          pending = null;
        }}
      />
      <button class="bs-btn" type="submit"
        >{pending ? (addAnywayLabel ?? addLabel) : addLabel}</button
      >
    </form>
    {#if error}
      <div class="items-error" id={errorId} role="alert">{error}</div>
    {/if}
    {#if pending}
      <div class="items-warn" role="status">{pending.text}</div>
    {/if}
    {#if hint}
      <div class="items-note">{hint}</div>
    {/if}
  </div>
{/snippet}

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
  .item.pinned {
    padding: 1px 6px;
    color: var(--color-muted);
  }
  .item-name {
    overflow-wrap: anywhere;
  }
  .item.warned {
    border-color: var(--color-red);
  }
  .item-warn {
    background: transparent;
    border: none;
    color: var(--color-red);
    cursor: help;
    font-size: var(--fs-meta);
    line-height: 1;
    padding: 0;
  }
  .item-warn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-red);
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
  .items-warn {
    font-size: var(--fs-meta);
    color: var(--status-warn);
  }
  .items-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
</style>
