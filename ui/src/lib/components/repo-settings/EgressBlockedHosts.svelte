<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { getLocale } from "#lib/i18n.js";
  import { getRepoEgressBlocks } from "#lib/api.js";
  import { useRepoConfig } from "./repo-config-editor.svelte.js";
  const repoConfig = useRepoConfig();
  import { toasts } from "#lib/toasts.svelte.js";
  import { clock } from "#lib/now.svelte.js";
  import { relativeTimeAgo } from "#lib/format.js";
  import { classifyEgressHost, type EgressTrust } from "#lib/egress-trust.js";
  import {
    egressBlockedHostsExplanation,
    egressRiskExplanation,
    egressRiskLabel,
  } from "#lib/tooltips/explanations.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { EgressBlock } from "#lib/types.js";
  import RepoSettingRow from "./RepoSettingRow.svelte";
  import "../automation-settings/automation-fields.css";

  // The hosts the Autonomous egress firewall blocked for this repo (#3922), each with "Allow for
  // this repo" (appends it to egressExtraHosts). The trust tier sets the friction: trusted allows
  // in one click, everything else confirms inline, and a risky host's confirm names why. Renders
  // nothing while the list is empty (a failed first load included: the list is guidance, not a
  // gate); `count` tells the section whether there is anything to show.
  let { repoPath, count = $bindable(0) }: { repoPath: string; count?: number } = $props();

  let hosts = $state<EgressBlock[]>([]);
  let failed = $state(false);
  /** The host whose inline confirm is open; one at a time. */
  let confirming = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let seq = 0;

  $effect(() => {
    count = hosts.length;
  });

  $effect(() => void repoConfig.ensure(repoPath));

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

  const tierOf = (host: string): EgressTrust => classifyEgressHost(host);
  // Allow PUTs the whole list, so it waits for the stored one: appending to the empty fallback of
  // an unloaded (or failed) config would wipe the repo's existing extra hosts.
  const configLoaded = $derived(repoConfig.isConfigLoaded(repoPath));

  async function allow(host: string) {
    busy = host;
    const ok = await repoConfig.setEgressExtraHosts(repoPath, [
      ...repoConfig.egressExtraHostsFor(repoPath),
      host,
    ]);
    busy = null;
    confirming = null;
    if (ok) {
      hosts = hosts.filter((b) => b.host !== host);
      toasts.info(m.egress_blocked_allowed({ host }));
    } else {
      toasts.info(m.egress_blocked_allow_failed({ host }), { alert: true });
    }
  }

  function onAllow(host: string) {
    if (tierOf(host).tier === "trusted") void allow(host);
    else confirming = host;
  }

  function confirmText(host: string): string {
    const t = tierOf(host);
    return t.tier === "risky"
      ? m.egress_blocked_confirm_risky({ host, reason: egressRiskLabel(t.reason) })
      : m.egress_blocked_confirm({ host });
  }
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
      <ul class="blk-list">
        {#each hosts as b (b.host)}
          {@const t = tierOf(b.host)}
          <li class="blk">
            <div class="blk-head">
              <span class="blk-host">{b.host}</span>
              {#if t.tier === "trusted"}
                <span class="badge trusted">{m.egress_blocked_tier_trusted()}</span>
              {:else if t.tier === "risky"}
                <!-- a button so keyboard users can open the explanation; it acts on nothing -->
                <button
                  class="badge risky"
                  type="button"
                  use:statusTip={{ text: egressRiskExplanation(t.reason) }}
                  >⚠ {m.egress_blocked_tier_risky({ reason: egressRiskLabel(t.reason) })}</button
                >
              {/if}
            </div>
            <div class="blk-meta">
              {m.egress_blocked_meta({
                count: b.count,
                sessions: b.sessions,
                ago: relativeTimeAgo(b.lastSeen, clock.current, getLocale()),
              })}
            </div>
            {#if confirming === b.host}
              <div class={["blk-confirm", { risky: t.tier === "risky" }]} role="group">
                <span class="blk-confirm-text">{confirmText(b.host)}</span>
                <div class="blk-actions">
                  <button
                    class={["bs-btn", t.tier === "risky" ? "danger" : "primary"]}
                    type="button"
                    disabled={busy !== null || !configLoaded}
                    onclick={() => allow(b.host)}
                    >{t.tier === "risky"
                      ? m.egress_blocked_confirm_anyway()
                      : m.egress_blocked_confirm_allow()}</button
                  >
                  <button
                    class="bs-btn"
                    type="button"
                    disabled={busy !== null}
                    onclick={() => (confirming = null)}>{m.common_cancel()}</button
                  >
                </div>
              </div>
            {:else}
              <button
                class="bs-btn"
                type="button"
                aria-label={m.egress_blocked_allow_host({ host: b.host })}
                disabled={busy !== null || !configLoaded}
                onclick={() => onAllow(b.host)}>{m.egress_blocked_allow()}</button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/snippet}
  </RepoSettingRow>
{/if}

<style>
  .blk-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
  }
  .blk {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .blk-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .blk-host {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
    overflow-wrap: anywhere;
  }
  .badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
  }
  .badge.trusted {
    color: var(--color-blue);
    border-color: var(--color-blue);
  }
  .badge.risky {
    background: transparent;
    color: var(--color-red);
    border-color: var(--color-red);
    cursor: help;
  }
  .badge.risky:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-red);
  }
  .blk-meta,
  .blk-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .blk-confirm {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px;
    border-left: 2px solid var(--color-amber);
    background: var(--color-panel-2);
  }
  .blk-confirm.risky {
    border-left-color: var(--color-red);
  }
  .blk-confirm-text {
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .blk-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .bs-btn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .bs-btn.danger {
    border-color: var(--color-red);
    color: var(--color-red);
  }
</style>
