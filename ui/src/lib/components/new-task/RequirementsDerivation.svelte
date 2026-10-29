<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { capabilityList } from "#lib/placement.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { derivedRequirementsExplanation } from "#lib/tooltips/explanations.js";
  import type { RequirementsDerivation } from "#lib/types.js";

  // What the server read from the task (#2773), under the requirement chips: while it reads, what
  // it found (the chips above hold it, correctable), the question when the task was unclear —
  // nothing starts before it is answered — or that nothing could be read. Once the chips are the
  // operator's own (`touched`), an answer that differs from them is only offered, to take over.
  let {
    pending,
    derivation,
    touched = false,
    requirements = [],
    onanswer,
    onadopt,
  }: {
    pending: boolean;
    derivation: RequirementsDerivation | null;
    touched?: boolean;
    requirements?: readonly string[];
    onanswer: (requirements: string[]) => void;
    onadopt?: (requirements: string[]) => void;
  } = $props();

  const found = $derived(derivation?.requirements ?? []);
  const foundText = $derived(
    found.length > 0
      ? m.newtask_derive_found({ list: capabilityList(found) })
      : m.newtask_derive_none(),
  );
  /** The operator's chips differ from what the task calls for now. */
  const differs = $derived(
    touched && [...found].sort().join(",") !== [...requirements].sort().join(","),
  );
  const label = (option: readonly string[]) =>
    option.length > 0 ? capabilityList(option) : m.newtask_derive_option_none();
</script>

{#if pending}
  <span class="nt-derive" role="status">{m.newtask_derive_pending()}</span>
{:else if derivation?.status === "derived" && differs}
  <div class="nt-derive-ask" role="group" aria-label={foundText}>
    <span class="nt-derive">{foundText}</span>
    <button type="button" class="gbtn" onclick={() => onadopt?.([...found])}>
      {m.newtask_derive_adopt()}
    </button>
  </div>
{:else if derivation?.status === "derived"}
  <button
    type="button"
    class="nt-derive"
    use:statusTip={{ text: derivedRequirementsExplanation(), wide: true }}
  >
    {foundText}
  </button>
{:else if derivation?.status === "unclear"}
  <div class="nt-derive-ask" role="group" aria-label={m.newtask_derive_question()}>
    <span class="question">{m.newtask_derive_question()}</span>
    {#each derivation.options ?? [] as option (option.join(","))}
      <button type="button" class="gbtn" onclick={() => onanswer([...option])}>
        {label(option)}
      </button>
    {/each}
  </div>
{:else if derivation && derivation.status !== "skipped"}
  <!-- failed, or a status this client does not know: nothing was derived, and it says so. -->
  <span class="nt-derive warn" role="status">{m.newtask_derive_failed()}</span>
{/if}

<style>
  .nt-derive {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  button.nt-derive {
    background: transparent;
    border: none;
    padding: 0;
    font-family: inherit;
    text-align: left;
    cursor: help;
  }
  .nt-derive.warn {
    color: var(--status-warn);
  }
  .nt-derive-ask {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-micro);
  }
  .question {
    color: var(--status-warn);
  }
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
