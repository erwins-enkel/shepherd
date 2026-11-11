<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { useRepoConfig } from "./repo-config-editor.svelte.js";
  const repoConfig = useRepoConfig();
  import { AUTONOMY_STEPS, autonomyChain, type AutonomyStep } from "#lib/autonomy.js";
  import { autonomyExplanation } from "#lib/tooltips/explanations.js";
  import GuardMarker from "../GuardMarker.svelte";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import AutonomyLevels from "./AutonomyLevels.svelte";

  // Autonomy (#3445), the window's first section: the level, and who takes each step of the way —
  // live from the config, so a switch flipped in another section shows here at once.
  let { repoPath }: { repoPath: string } = $props();

  const chain = $derived(
    autonomyChain(repoConfig.flags(repoPath), repoConfig.repoModeFor(repoPath) === "lightweight"),
  );

  function stepName(step: AutonomyStep): string {
    switch (step) {
      case "pickup":
        return m.reposettings_chain_pickup();
      case "plan":
        return m.reposettings_chain_plan();
      case "stops":
        return m.reposettings_chain_stops();
      case "review":
        return m.reposettings_chain_review();
      case "fix":
        return m.reposettings_chain_fix();
      case "merge":
        return m.reposettings_chain_merge();
    }
  }
</script>

<!-- `field` names no repo key: the level is a view over five of them, and a setting link
     (data-field~=) must still find each one's own row. -->
<RepoSettingRow
  field="autonomyLevel"
  glyph="◎"
  name={m.reposettings_autonomy_name()}
  desc={m.reposettings_autonomy_desc()}
  explanation={autonomyExplanation()}
>
  {#snippet below()}
    <AutonomyLevels {repoPath} />
  {/snippet}
</RepoSettingRow>
<RepoSettingRow
  field="autonomyChain"
  glyph="⇢"
  name={m.reposettings_chain_name()}
  desc={m.reposettings_chain_desc()}
>
  {#snippet below()}
    <ol class="chain" aria-label={m.reposettings_chain_name()}>
      {#each AUTONOMY_STEPS as step (step)}
        <li class="step" data-step={step}>
          <span class="step-name">{stepName(step)}</span>
          {#if chain[step] === "shepherd"}
            <GuardMarker kind="auto" label={m.reposettings_chain_shepherd()} />
          {:else}
            <GuardMarker kind="human" />
          {/if}
        </li>
      {/each}
    </ol>
  {/snippet}
</RepoSettingRow>

<style>
  .chain {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--fs-meta);
    counter-reset: step;
  }
  .step {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 3px 8px;
    border-left: 2px solid var(--color-line);
    counter-increment: step;
  }
  .step-name {
    color: var(--color-ink);
  }
  .step-name::before {
    content: counter(step) ". ";
    color: var(--color-faint);
  }
</style>
