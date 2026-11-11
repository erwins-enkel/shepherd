<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { getLocale } from "#lib/i18n.js";
  import { getRepoEgressBlocks } from "#lib/api.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { clock } from "#lib/now.svelte.js";
  import { relativeTimeAgo } from "#lib/format.js";
  import { egressBlockedHostsExplanation } from "#lib/tooltips/explanations.js";
  import type { EgressBlock } from "#lib/types.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import EgressHostList from "./EgressHostList.svelte";

  // The hosts the Autonomous egress firewall blocked for this repo (#3922), each with "Allow for
  // this repo" (EgressHostList). Renders nothing while the list is empty (a failed first load
  // included: the list is guidance, not a gate); `count` tells the section whether there is
  // anything to show.
  let { repoPath, count = $bindable(0) }: { repoPath: string; count?: number } = $props();

  let hosts = $state<EgressBlock[]>([]);
  let failed = $state(false);
  let seq = 0;

  $effect(() => {
    count = hosts.length;
  });

  // Reload when the repo or its extra hosts change: an allowed host drops out of the list.
  $effect(() => {
    void repoConfig.egressExtraHostsFor(repoPath);
    void load(repoPath);
  });

  async function load(repo: string) {
    const mine = ++seq;
    try {
      const res = await getRepoEgressBlocks(repo);
      if (mine !== seq) return;
      hosts = res.hosts ?? [];
      failed = false;
    } catch {
      if (mine === seq) failed = true;
    }
  }

  const items = $derived(
    hosts.map((b) => ({
      host: b.host,
      meta: m.egress_blocked_meta({
        count: b.count,
        sessions: b.sessions,
        ago: relativeTimeAgo(b.lastSeen, clock.current, getLocale()),
      }),
    })),
  );
</script>

{#if hosts.length}
  <RepoSettingRow
    field="egressBlockedHosts"
    name={m.egress_blocked_label()}
    explanation={egressBlockedHostsExplanation()}
    indent
  >
    {#snippet below()}
      {#if failed}
        <div class="blk-note">{m.egress_blocked_load_failed()}</div>
      {/if}
      <EgressHostList
        {repoPath}
        {items}
        onallowed={(host) => (hosts = hosts.filter((b) => b.host !== host))}
      />
    {/snippet}
  </RepoSettingRow>
{/if}

<style>
  .blk-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
</style>
