<script lang="ts">
  import { onMount } from "svelte";
  import { getGithubActionsBilling } from "#lib/api.js";
  import { relativeAge } from "#lib/format.js";
  import { getLocale } from "#lib/i18n.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { TooltipExplanation } from "#lib/tooltips/content.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { GithubActionsBilling } from "#lib/types.js";
  import { sortAccounts } from "./github-actions";
  import GithubActionsRow from "./GithubActionsRow.svelte";

  // The usage panel's GitHub Actions section: one row per account (personal + orgs) with this
  // month's allowance up to the stop, and a forecast that colors the row when the pace runs into
  // that stop before the reset. Reads its own data when the panel opens; the server caches it.
  let { nowMs }: { nowMs: number } = $props();

  let data = $state<GithubActionsBilling | null>(null);
  let failed = $state(false);

  onMount(() => {
    let alive = true;
    getGithubActionsBilling().then(
      (d) => {
        if (alive) data = d;
      },
      () => {
        if (alive) failed = true;
      },
    );
    return () => {
      alive = false;
    };
  });

  const accounts = $derived(data ? sortAccounts(data.accounts, nowMs) : []);
  const period = $derived.by(() => {
    if (!data) return "";
    const month = new Date(data.periodStart).toLocaleDateString(getLocale(), {
      month: "long",
      timeZone: "UTC",
    });
    const age = relativeAge(data.fetchedAt, nowMs);
    return age === "now" ? m.topbar_gha_period_now({ month }) : m.topbar_gha_period({ month, age });
  });

  const explanation: TooltipExplanation = $derived({
    title: m.topbar_gha_tip_title(),
    summary: m.topbar_gha_tip_summary(),
    sections: [
      { label: m.topbar_gha_tip_counts_label(), text: m.topbar_gha_tip_counts() },
      { label: m.topbar_gha_tip_free_label(), text: m.topbar_gha_tip_free() },
      { label: m.topbar_gha_tip_empty_label(), text: m.topbar_gha_tip_empty() },
      { label: m.topbar_gha_tip_included_label(), text: m.topbar_gha_tip_included() },
      { label: m.topbar_gha_tip_next_label(), text: m.topbar_gha_tip_next() },
    ],
    footer: [m.topbar_gha_tip_forecast(), m.topbar_gha_tip_source()],
  });
</script>

{#if failed || !data || accounts.length > 0}
  <section class="gha" aria-labelledby="gha-title">
    <div class="gha-head">
      <span id="gha-title" class="eyebrow">{m.topbar_gha_title()}</span>
      <button
        type="button"
        class="tip-btn"
        use:statusTip={{ text: explanation }}
        aria-label={m.topbar_gha_tip_title()}>?</button
      >
      <span class="rule" aria-hidden="true"></span>
      <span class="period">{period}</span>
    </div>

    {#if failed}
      <p class="note">{m.topbar_gha_load_failed()}</p>
    {:else if !data}
      <p class="note">{m.common_loading()}</p>
    {:else}
      <div class="gha-cols" aria-hidden="true">
        <span>{m.topbar_gha_col_account()}</span>
        <span>{m.topbar_gha_col_allowance()}</span>
        <span class="right">{m.topbar_gha_col_used()}</span>
        <span>{m.topbar_gha_col_forecast()}</span>
        <span class="right">{m.topbar_gha_col_reset()}</span>
      </div>
      {#each accounts as a (a.login)}
        <GithubActionsRow account={a} {nowMs} resetAt={data.resetAt} />
      {/each}

      <div class="legend">
        <span><i class="lg-used" aria-hidden="true"></i>{m.topbar_gha_legend_used()}</span>
        <span><i class="lg-forecast" aria-hidden="true"></i>{m.topbar_gha_legend_forecast()}</span>
        <span><i class="lg-budget" aria-hidden="true"></i>{m.topbar_gha_legend_budget()}</span>
        <span><i class="lg-stop" aria-hidden="true"></i>{m.topbar_gha_legend_stop()}</span>
        <span class="counts">{m.topbar_gha_counts_note()}</span>
      </div>
    {/if}
  </section>
{/if}

<style>
  .gha {
    /* Shared by the column headings and every row (GithubActionsRow). */
    --gha-cols: 170px minmax(0, 1fr) 48px 196px 40px;
    container: gha / inline-size;
    margin-top: 18px;
    padding-top: 16px;
    border-top: 1px solid var(--color-line);
  }
  .gha-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .eyebrow {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  .tip-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-micro);
    cursor: help;
  }
  .tip-btn:hover,
  .tip-btn:focus-visible {
    color: var(--color-ink-bright);
    border-color: var(--color-ink);
  }
  .tip-btn:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  .rule {
    flex: 1;
    height: 1px;
    background: var(--color-line);
  }
  .period {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .note {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .gha-cols {
    display: grid;
    grid-template-columns: var(--gha-cols);
    column-gap: 14px;
    padding-bottom: 6px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .right {
    text-align: right;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 16px;
    padding-top: 10px;
    border-top: 1px solid var(--color-line);
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .legend i {
    display: block;
    width: 14px;
    height: 7px;
    box-sizing: border-box;
  }
  .lg-used {
    background: var(--color-ink);
  }
  .lg-forecast {
    background: repeating-linear-gradient(
      90deg,
      color-mix(in srgb, var(--color-ink) 50%, transparent) 0 2px,
      transparent 2px 4px
    );
  }
  .lg-budget {
    border: 1px solid var(--color-line-bright);
    background: repeating-linear-gradient(
      135deg,
      color-mix(in srgb, var(--color-muted) 45%, transparent) 0 1px,
      transparent 1px 4px
    );
  }
  .legend i.lg-stop {
    width: 2px;
    height: 11px;
    background: var(--color-ink-bright);
  }
  .counts {
    margin-left: auto;
  }

  @media (pointer: coarse) {
    .tip-btn {
      min-width: 44px;
      min-height: 44px;
    }
  }

  @container gha (max-width: 640px) {
    .gha-cols {
      display: none;
    }
    .counts {
      margin-left: 0;
    }
  }
</style>
