<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { getRepoEgressSuggestions } from "#lib/api.js";
  import { useRepoConfig } from "./repo-config-editor.svelte.js";
  const repoConfig = useRepoConfig();
  import { egressSuggestedHostsExplanation } from "#lib/tooltips/explanations.js";
  import type { EgressSuggestion } from "#lib/types.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import EgressHostList from "./EgressHostList.svelte";

  // The registry hosts this repo's lockfiles name (#3927), so they can be allowed before an
  // Autonomous run is blocked; each with "Allow for this repo" (EgressHostList). The server
  // leaves out allowed and blocked-listed hosts. Renders nothing while the list is empty (a
  // failed first load included: suggestions are guidance, not a gate).
  let { repoPath }: { repoPath: string } = $props();

  let hosts = $state<EgressSuggestion[]>([]);
  let failed = $state(false);
  let seq = 0;

  // Reload when the repo or its extra hosts change: an allowed host drops out of the list.
  $effect(() => {
    void repoConfig.egressExtraHostsFor(repoPath);
    void load(repoPath);
  });

  async function load(repo: string) {
    const mine = ++seq;
    try {
      const res = await getRepoEgressSuggestions(repo);
      if (mine !== seq) return;
      hosts = res.hosts ?? [];
      failed = false;
    } catch {
      if (mine === seq) failed = true;
    }
  }

  const items = $derived(
    hosts.map((s) => ({
      host: s.host,
      meta: m.egress_suggested_meta({ sources: s.sources.join(", ") }),
    })),
  );
</script>

{#if hosts.length}
  <RepoSettingRow
    field="egressSuggestedHosts"
    name={m.egress_suggested_label()}
    explanation={egressSuggestedHostsExplanation()}
    indent
  >
    {#snippet below()}
      {#if failed}
        <div class="sug-note">{m.egress_suggested_load_failed()}</div>
      {/if}
      <EgressHostList
        {repoPath}
        {items}
        onallowed={(host) => (hosts = hosts.filter((s) => s.host !== host))}
      />
    {/snippet}
  </RepoSettingRow>
{/if}

<style>
  .sug-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
</style>
