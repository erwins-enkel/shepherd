<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { capabilityList } from "#lib/placement.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { derivedRequirementsExplanation } from "#lib/tooltips/explanations.js";
  import type { RequirementsDerivation } from "#lib/types.js";

  // What the server read from the task (#2773), in two places of the machine strip. The `tag`
  // part sits right after the chips: "reading task…" while it reads, "from task" once the chips
  // above hold what it found (correctable). The `notice` part is the strip's second line, only
  // when something needs the operator: the question when the task was unclear — nothing starts
  // before it is answered — or that nothing could be read. Once the chips are the operator's own
  // (`touched`), an answer that differs from them is only offered there, to take over.
  let {
    part,
    pending,
    derivation,
    touched = false,
    requirements = [],
    onanswer,
    onadopt,
  }: {
    part: "tag" | "notice";
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

{#if part === "tag"}
  {#if pending}
    <span class="nt-derive tag" role="status">{m.newtask_derive_tag_pending()}</span>
  {:else if derivation?.status === "derived" && !differs}
    <button
      type="button"
      class="nt-derive tag"
      use:statusTip={{ text: derivedRequirementsExplanation(), wide: true }}
    >
      {m.newtask_derive_tag()}
    </button>
  {/if}
{:else if !pending && derivation?.status === "derived" && differs}
  <div class="nt-derive-ask nt-strip-note" role="group" aria-label={foundText}>
    <span class="nt-derive">{foundText}</span>
    <button type="button" class="gbtn" onclick={() => onadopt?.([...found])}>
      {m.newtask_derive_adopt()}
    </button>
  </div>
{:else if !pending && derivation?.status === "unclear"}
  <div class="nt-derive-ask nt-strip-note" role="group" aria-label={m.newtask_derive_question()}>
    <span class="question">{m.newtask_derive_question()}</span>
    {#each derivation.options ?? [] as option (option.join(","))}
      <button type="button" class="gbtn" onclick={() => onanswer([...option])}>
        {label(option)}
      </button>
    {/each}
  </div>
{:else if !pending && derivation && derivation.status !== "derived" && derivation.status !== "skipped"}
  <!-- failed, or a status this client does not know: nothing was derived, and it says so. -->
  <span class="nt-derive warn nt-strip-note" role="status">{m.newtask_derive_failed()}</span>
{/if}

<style>
  .nt-derive {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .tag {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  button.tag {
    background: transparent;
    border: none;
    padding: 0;
    font-family: inherit;
    cursor: help;
  }
  button.tag:hover,
  button.tag:focus-visible {
    color: var(--color-ink);
  }
  .nt-derive.warn {
    color: var(--status-warn);
  }
  .nt-derive-ask {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-meta);
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
