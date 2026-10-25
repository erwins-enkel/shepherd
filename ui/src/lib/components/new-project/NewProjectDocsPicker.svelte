<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import {
    docChips,
    emptyDocs,
    mergeDocs,
    pickedDocs,
    removeDocChip,
    type AttachedDocs,
    type DocArea,
  } from "./project-docs";

  // #3420: the Idea field's in-field part — attach buttons, the idea counter and the attached
  // files as removable chips. Whatever the kickoff, the files land in docs/prd + docs/design of
  // the first commit; both are optional, the bootstrap agent asks for whatever is missing.
  let {
    docs = $bindable(),
    count,
    countOver,
  }: { docs: AttachedDocs; count: string; countOver: boolean } = $props();

  let prdInput = $state<HTMLInputElement>();
  let designInput = $state<HTMLInputElement>();

  const chips = $derived(docChips(docs));

  // PRD picks only ever come from the plain (non-directory) picker, so they stay loose files —
  // one chip each with its own target.
  function pick(area: DocArea, input: HTMLInputElement) {
    docs = mergeDocs(docs, { ...emptyDocs(), [area]: pickedDocs(input.files) });
    input.value = "";
  }
</script>

{#if chips.length > 0}
  <ul class="chips" aria-label={m.newproject_docs_group()}>
    {#each chips as chip (`${chip.area}:${chip.key}`)}
      <li class="chip">
        <span class="chip-name">{chip.name}</span>
        <span class="chip-target">
          {chip.folder
            ? m.newproject_doc_target_folder({ target: chip.target, count: chip.count })
            : m.newproject_doc_target({ target: chip.target })}
        </span>
        <button
          type="button"
          class="chip-x"
          aria-label={m.newproject_doc_remove_aria({ name: chip.name })}
          onclick={() => (docs = removeDocChip(docs, chip))}>✕</button
        >
      </li>
    {/each}
  </ul>
{/if}

<!-- In-field toolbar (New Task's recipe): attach PRD, design folder, idea counter. -->
<div class="toolbar">
  <button
    type="button"
    class="tool-btn"
    title={m.newproject_attach_prd_title()}
    onclick={() => prdInput?.click()}
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path
        d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
      />
    </svg>
    <span class="tool-label">{m.newproject_attach_prd()}</span>
  </button>
  <button
    type="button"
    class="tool-btn"
    title={m.newproject_attach_design_title()}
    onclick={() => designInput?.click()}
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
    <span class="tool-label">{m.newproject_attach_design()}</span>
  </button>
  <span id="np-idea-count" class="char-count" class:over={countOver}>{count}</span>
</div>

<input
  bind:this={prdInput}
  type="file"
  multiple
  hidden
  accept=".md,.markdown,.txt,.pdf"
  onchange={(e) => pick("prd", e.currentTarget)}
/>
<input
  bind:this={designInput}
  type="file"
  multiple
  hidden
  webkitdirectory
  onchange={(e) => pick("design", e.currentTarget)}
/>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 6px 8px;
    list-style: none;
  }
  /* AttachmentChip's recipe plus the docs target; both texts give way before the chip overflows. */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    box-sizing: border-box;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 3px 7px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .chip-name,
  .chip-target {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip-name {
    max-width: 22ch;
  }
  .chip-target {
    color: var(--color-muted);
  }
  .chip-x {
    flex-shrink: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    line-height: 1;
  }
  .chip-x:hover {
    color: var(--color-ink-bright);
  }
  .chip-x:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 8px;
    border-top: 1px solid var(--color-line);
  }
  /* Icon + word, the `.gbtn`-style labelled control New Task's attach button uses. */
  .tool-btn {
    flex-shrink: 0;
    height: 28px;
    padding: 0 8px;
    gap: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    cursor: pointer;
  }
  .tool-btn svg {
    width: var(--icon-btn-glyph);
    height: var(--icon-btn-glyph);
    display: block;
  }
  .tool-label {
    white-space: nowrap;
  }
  .tool-btn:hover {
    background: var(--color-hover);
    border-color: var(--color-line-bright);
  }
  .tool-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .char-count {
    margin-left: auto;
    flex-shrink: 0;
    font-size: var(--fs-micro);
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .char-count.over {
    color: var(--color-red);
  }

  @media (max-width: 768px) {
    .toolbar {
      padding: 8px;
    }
    .tool-btn {
      height: auto;
      min-height: 44px;
      padding: 0 12px;
    }
    /* The ✕ grows to a 44px tap target and takes over the chip's right/vertical padding. */
    .chip {
      padding: 0 0 0 7px;
    }
    .chip-x {
      min-width: 44px;
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .char-count {
      font-size: var(--fs-meta);
    }
  }
</style>
