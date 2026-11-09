<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { getLocale } from "#lib/i18n.js";
  import type { ActionsAccountBilling, ActionsRunnerOs } from "#lib/types.js";
  import { costlyRunner, usd } from "./github-actions";

  // One account's cost breakdown under its row: where the money goes (runner OS, repos), what
  // runs free, and the GitHub pages to act on it.
  let { account, id }: { account: ActionsAccountBilling; id: string } = $props();

  const OS_COLOR: Record<ActionsRunnerOs, string> = {
    linux: "var(--color-data-1)",
    macos: "var(--color-data-4)",
    windows: "var(--color-data-7)",
    other: "var(--color-data-3)",
  };
  function osName(os: ActionsRunnerOs): string {
    return { linux: "Linux", macos: "macOS", windows: "Windows", other: m.topbar_gha_os_other() }[
      os
    ];
  }

  const num = (n: number) => n.toLocaleString(getLocale());
  const minutesTotal = $derived(account.runners.reduce((s, r) => s + r.minutes, 0));
  const costTotal = $derived(account.runners.reduce((s, r) => s + r.grossUsd, 0));
  const share = (part: number, total: number) => (total > 0 ? (part / total) * 100 : 0);
  const costly = $derived(costlyRunner(account));
  const billingBase = $derived(
    account.kind === "org"
      ? `https://github.com/organizations/${account.login}/settings/billing`
      : "https://github.com/settings/billing",
  );
</script>

<div class="gha-detail" {id}>
  <div class="cols">
    {#if account.runners.length > 0}
      <div>
        <div class="eyebrow">{m.topbar_gha_by_runner()}</div>
        <div class="split" aria-hidden="true">
          <span class="split-label">{m.topbar_gha_minutes()}</span>
          <span class="split-bar">
            {#each account.runners as r (r.os)}
              <span style="width:{share(r.minutes, minutesTotal)}%;background:{OS_COLOR[r.os]}"
              ></span>
            {/each}
          </span>
          <span class="split-label">{m.topbar_gha_cost()}</span>
          <span class="split-bar">
            {#each account.runners as r (r.os)}
              <span style="width:{share(r.grossUsd, costTotal)}%;background:{OS_COLOR[r.os]}"
              ></span>
            {/each}
          </span>
        </div>
        <ul class="legend">
          {#each account.runners as r (r.os)}
            <li>
              <span class="swatch" style="background:{OS_COLOR[r.os]}" aria-hidden="true"></span>
              {m.topbar_gha_runner_row({
                os: osName(r.os),
                minutes: num(r.minutes),
                cost: usd(r.grossUsd),
              })}
            </li>
          {/each}
        </ul>
        {#if costly}
          <p class="insight">
            {m.topbar_gha_costly_runner({
              os: osName(costly.os),
              minutes: costly.minutesPct,
              cost: costly.costPct,
            })}
          </p>
        {/if}
      </div>
    {/if}
    {#if account.topRepos.length > 0}
      <div>
        <div class="eyebrow">{m.topbar_gha_top_repos()}</div>
        <ul class="repos">
          {#each account.topRepos as r, i (r.repo)}
            <li>
              <span class="repo" class:first={i === 0}>{r.repo}</span>
              <span class="amount">{usd(r.grossUsd)}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if account.publicMinutes > 0}
      <div>
        <div class="eyebrow">{m.topbar_gha_free()}</div>
        <p class="free">
          {m.topbar_gha_free_text({
            minutes: num(account.publicMinutes),
            value: usd(account.publicGrossUsd),
          })}
        </p>
        {#if account.topPublicRepo}
          <p class="free-top">
            {m.topbar_gha_free_top({
              minutes: num(account.topPublicRepo.minutes),
              repo: account.topPublicRepo.repo,
            })}
          </p>
        {/if}
      </div>
    {/if}
  </div>
  <div class="links">
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external GitHub billing pages -->
    <a href="{billingBase}/budgets" target="_blank" rel="noopener noreferrer"
      >{m.topbar_gha_link_budget()}</a
    >
    <a href="{billingBase}/usage" target="_blank" rel="noopener noreferrer"
      >{m.topbar_gha_link_usage()}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  </div>
</div>

<style>
  .gha-detail {
    margin: 10px 0 2px 184px;
    padding: 12px 14px;
    background: var(--color-panel-2);
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 14px 22px;
  }
  .eyebrow {
    margin-bottom: 8px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  .split {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 6px 8px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
  .split-bar {
    display: flex;
    gap: 1px;
    height: 8px;
    overflow: hidden;
  }
  .legend,
  .repos {
    display: grid;
    gap: 3px;
    margin: 9px 0 0;
    padding: 0;
    list-style: none;
    font-size: var(--fs-micro);
    font-variant-numeric: tabular-nums;
  }
  .legend li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .swatch {
    flex-shrink: 0;
    width: 7px;
    height: 7px;
  }
  .insight {
    margin: 8px 0 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
    line-height: 1.45;
  }
  .repos {
    margin: 0;
    gap: 5px;
    font-size: var(--fs-meta);
  }
  .repos li {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }
  .repo {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }
  .repo.first {
    color: var(--color-ink-bright);
  }
  .free {
    margin: 0;
    font-size: var(--fs-meta);
    line-height: 1.5;
  }
  .free-top {
    margin: 6px 0 0;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--color-line);
  }
  .links a {
    color: var(--color-ink);
    font-size: var(--fs-meta);
    text-decoration: underline;
    text-decoration-color: var(--color-line-bright);
    text-underline-offset: 3px;
  }
  .links a:hover,
  .links a:focus-visible {
    color: var(--color-ink-bright);
    text-decoration-color: var(--color-ink);
  }
  @container gha (max-width: 640px) {
    .gha-detail {
      margin-left: 0;
    }
  }
</style>
