<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { keyedMessages } from "#lib/keyed-messages.js";
  import { repoSettingsWindow } from "#lib/repo-settings-window.svelte.js";
  import GuardMarker from "#lib/components/GuardMarker.svelte";
  import { buildGuardTimeline, type GuardRepoConfig } from "#lib/guard-timeline.js";
  import type { AgentProvider } from "#lib/types.js";

  // "Where does this task wait for a human?" — rendered under the Guards toggles.
  //
  // The header line is always visible and names the current combination; the step list
  // starts collapsed and is NOT remembered across dialog openings (deliberate: the New
  // Task card is already dense, and the header carries the answer on its own).
  //
  // All of the semantics live in #lib/guard-timeline — this component only renders keys.
  let {
    planGate,
    autopilot,
    provider,
    baseBranch,
    repo,
    repoPath,
  }: {
    planGate: boolean;
    autopilot: boolean;
    provider: AgentProvider;
    baseBranch: string;
    /** null while the repo config is still loading → the post-PR steps are omitted. */
    repo: GuardRepoConfig | null;
    repoPath: string;
  } = $props();

  let expanded = $state(false);

  const timeline = $derived(
    buildGuardTimeline({ planGate, autopilot, provider, baseBranch, repo }),
  );
  // Split rather than interleaving a divider row into one <ol>: a non-step <li> would
  // consume an ordinal, so the repo steps would be misnumbered.
  const localSteps = $derived(timeline.steps.filter((s) => !s.repoScoped));
  const repoSteps = $derived(timeline.steps.filter((s) => s.repoScoped));

  // Only the `guardtl_*` key family is bundled for these data-driven keys (#3242).
  const guardMessage = keyedMessages(m, ["guardtl_"]);
  const msg = (key: string) => guardMessage(key)!();

  // A repo-scoped step opens the repo settings window (#3443) where its switch lives; the typed
  // prompt stays, as the window sits over the New Task card.
  function openSettings(e: MouseEvent, step: string) {
    repoSettingsWindow.open(repoPath, {
      section: step === "critic" ? "review" : "merge",
      opener: e.currentTarget as HTMLElement,
    });
  }
</script>

<div class="gtl">
  <!-- No aria-label: the visible line IS the answer, so it must be the button's
       accessible name rather than being replaced by a generic one. -->
  <button
    type="button"
    class="gtl-head"
    aria-expanded={expanded}
    onclick={() => (expanded = !expanded)}
  >
    <span class="gtl-head-text">{msg(timeline.headerKey)}</span>
    <span class="gtl-chev" class:open={expanded} aria-hidden="true">▾</span>
  </button>

  {#if expanded}
    <ol class="gtl-list">
      {#each localSteps as step (step.id)}
        <li class="gtl-step">
          <GuardMarker kind={step.kind} />
          <span class="gtl-text">{msg(step.key)}</span>
        </li>
      {/each}
    </ol>

    {#if repoSteps.length > 0}
      <span class="gtl-divider">{m.guardtl_divider()}</span>
      <ol class="gtl-list" start={localSteps.length + 1}>
        {#each repoSteps as step (step.id)}
          <li class="gtl-step">
            <GuardMarker kind={step.kind} />
            <span class="gtl-text">{msg(step.key)}</span>
            <button
              type="button"
              class="gtl-open"
              aria-label={m.guardtl_open_automation()}
              aria-haspopup="dialog"
              onclick={(e) => openSettings(e, step.id)}>↗</button
            >
          </li>
        {/each}
      </ol>
    {/if}
  {/if}
</div>

<style>
  .gtl {
    display: flex;
    flex-direction: column;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--color-line);
  }
  .gtl-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    margin: 0;
    padding: 0;
    background: transparent;
    border: 0;
    text-align: left;
    cursor: pointer;
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }
  .gtl-head:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gtl-head-text {
    min-width: 0;
  }
  .gtl-chev {
    margin-left: auto;
    flex-shrink: 0;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }
  .gtl-chev.open {
    transform: rotate(180deg);
  }
  .gtl-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 6px 0 0;
    padding-left: 18px;
    font-size: var(--fs-micro);
    color: var(--color-ink);
  }
  .gtl-step {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .gtl-text {
    min-width: 0;
  }
  .gtl-open {
    flex-shrink: 0;
    margin: 0;
    padding: 0 2px;
    background: transparent;
    border: 0;
    cursor: pointer;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }
  .gtl-open:hover,
  .gtl-open:focus-visible {
    color: var(--color-ink-bright);
  }
  .gtl-open:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gtl-divider {
    margin-top: 8px;
    font-size: var(--fs-micro);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
</style>
