<script lang="ts">
  import { formatResetIn } from "#lib/format.js";
  import { getLocale } from "#lib/i18n.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { ActionsAccountBilling } from "#lib/types.js";
  import {
    STOP_SOON_MS,
    TONE_COLOR,
    actionsTone,
    daysWithoutCi,
    usd,
    usedLabel,
  } from "./github-actions";
  import GithubActionsDetail from "./GithubActionsDetail.svelte";
  import GithubActionsMeter from "./GithubActionsMeter.svelte";

  // One account in the GitHub Actions section: its bar, share and forecast — or, when its
  // billing can't be read, what to do about it. A stop ahead opens the cost breakdown.
  let {
    account: a,
    nowMs,
    resetAt,
  }: { account: ActionsAccountBilling; nowMs: number; resetAt: number } = $props();

  const SCOPE_CMD = "gh auth refresh -h github.com -s user";

  let toggled = $state<boolean | null>(null);
  let copied = $state(false);

  const ok = $derived(a.status === "ok");
  const tone = $derived(actionsTone(a, nowMs));
  const detail = $derived(
    ok && (a.runners.length > 0 || a.topRepos.length > 0 || a.publicMinutes > 0),
  );
  const open = $derived(detail && (toggled ?? (tone === "warn" || tone === "stopped")));
  const kind = $derived(a.kind === "user" ? m.topbar_gha_kind_user() : m.topbar_gha_kind_org());
  // Past the included amount the share itself is the news (budget or billing); before it, the
  // forecast carries the color.
  const usedColor = $derived(
    a.includedUsd !== null && a.usedUsd >= a.includedUsd ? TONE_COLOR[tone] : "var(--color-ink)",
  );

  const day = (t: number) =>
    new Date(t).toLocaleDateString(getLocale(), { day: "numeric", month: "numeric" });

  function warnLines(stopAt: number): [string, string] {
    const reset = day(resetAt);
    if (stopAt - nowMs <= STOP_SOON_MS) {
      return [
        m.topbar_gha_stop_in({ time: formatResetIn(stopAt, nowMs) }),
        m.topbar_gha_stop_in_sub({ reset }),
      ];
    }
    const out = a.projection.includedOutAt;
    const without = m.topbar_gha_without_ci({ days: `${daysWithoutCi(a, resetAt)}d` });
    return [
      m.topbar_gha_stop_on({ date: day(stopAt) }),
      out !== null && out > nowMs
        ? `${m.topbar_gha_included_out_on({ date: day(out) })} · ${without}`
        : without,
    ];
  }

  const forecast = $derived.by((): [string, string] => {
    const stopAt = a.projection.stopAt;
    if (tone === "stopped" && stopAt !== null) {
      return [
        m.topbar_gha_stopped({ date: day(stopAt) }),
        m.topbar_gha_stopped_sub({ reset: day(resetAt) }),
      ];
    }
    if (tone === "warn" && stopAt !== null) return warnLines(stopAt);
    if (tone === "paid") {
      const extra = Math.max(a.projection.monthEndUsd - (a.includedUsd ?? 0), a.paidUsd);
      return [m.topbar_gha_extra_cost({ amount: usd(extra) }), ""];
    }
    // The spend line under the bar already names the stop.
    if (tone === "quiet") return [m.topbar_gha_no_runs(), ""];
    return [
      m.topbar_gha_lasts(),
      m.topbar_gha_lasts_sub({ amount: usd(a.projection.monthEndUsd) }),
    ];
  });

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(SCOPE_CMD);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* clipboard blocked — the command stays visible to copy by hand */
    }
  }
</script>

<div class="gha-account" data-login={a.login} data-tone={ok ? tone : a.status}>
  <div class="gha-row">
    <div class="acct">
      {#if detail}
        <button
          type="button"
          class="acct-btn"
          aria-expanded={open}
          aria-controls="gha-detail-{a.login}"
          title={m.topbar_gha_details({ account: a.login })}
          onclick={() => (toggled = !open)}
        >
          <svg
            class="chev"
            class:open
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg
          >
          <span class="login">{a.login}</span>
        </button>
      {:else}
        <span class="login pad">{a.login}</span>
      {/if}
      <span class="plan">{a.plan ? `${a.plan} · ${kind}` : kind}</span>
    </div>

    {#if ok}
      <div class="meter-slot"><GithubActionsMeter account={a} {tone} /></div>
      <span class="used" style="color:{usedColor}">{usedLabel(a)}</span>
      <div class="fc">
        <span
          class="fc-main"
          class:strong={tone !== "ok" && tone !== "quiet"}
          style="color:{TONE_COLOR[tone]}">{forecast[0]}</span
        >
        {#if forecast[1]}<span class="fc-sub">{forecast[1]}</span>{/if}
      </div>
      <span class="reset">{formatResetIn(resetAt, nowMs)}</span>
    {:else if a.status === "missing-scope"}
      <div class="rest scope">
        <span>{m.topbar_gha_missing_scope()}</span>
        <span class="cmd">
          <code>{SCOPE_CMD}</code>
          <button
            type="button"
            class="copy"
            aria-label={copied ? m.topbar_gha_copied() : m.topbar_gha_copy()}
            onclick={copyCommand}
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
              {#if copied}
                <path d="M20 6 9 17l-5-5" />
              {:else}
                <rect x="9" y="9" width="12" height="12" rx="1" />
                <path d="M5 15V4a1 1 0 0 1 1-1h11" />
              {/if}
            </svg>
          </button>
        </span>
      </div>
    {:else}
      <span class="rest muted"
        >{a.status === "no-access" ? m.topbar_gha_no_access() : m.topbar_gha_error()}</span
      >
    {/if}
  </div>
  {#if open}
    <GithubActionsDetail account={a} id="gha-detail-{a.login}" />
  {/if}
</div>

<style>
  .gha-account {
    padding: 10px 0;
    border-top: 1px solid var(--color-line);
  }
  .gha-row {
    display: grid;
    grid-template-columns: var(--gha-cols);
    column-gap: 14px;
    align-items: start;
    font-variant-numeric: tabular-nums;
  }
  .acct {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .acct-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 0;
    background: none;
    border: 0;
    color: var(--color-ink-bright);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .chev {
    flex-shrink: 0;
    width: 12px;
    height: 12px;
    transition: transform 0.15s ease;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .login {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }
  .login.pad,
  .plan {
    padding-left: 18px;
  }
  .plan {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .meter-slot {
    min-width: 0;
  }
  .used {
    font-size: var(--fs-meta);
    text-align: right;
  }
  .fc {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .fc-main {
    font-size: var(--fs-meta);
  }
  .fc-main.strong {
    font-weight: 600;
  }
  .fc-sub {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
  }
  .reset {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    text-align: right;
  }
  .rest {
    grid-column: 2 / -1;
    font-size: var(--fs-meta);
    line-height: 1.5;
  }
  .rest.muted {
    color: var(--color-muted);
  }
  .scope {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
  .cmd {
    display: inline-flex;
    align-items: stretch;
    max-width: 100%;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: var(--color-inset);
  }
  .cmd code {
    padding: 6px 10px;
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    overflow-wrap: anywhere;
  }
  .copy {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 30px;
    padding: 0;
    background: transparent;
    border: 0;
    border-left: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    cursor: pointer;
  }
  .copy svg {
    width: 13px;
    height: 13px;
  }
  .copy:hover,
  .copy:focus-visible {
    color: var(--color-ink-bright);
  }
  .acct-btn:focus-visible,
  .copy:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
  }
  @media (pointer: coarse) {
    .acct-btn {
      min-height: 44px;
    }
    .copy {
      min-width: 44px;
      min-height: 44px;
    }
  }

  /* Narrow (phone sheet, stacked panel): name and share, then the bar, then the forecast. */
  @container gha (max-width: 640px) {
    .gha-row {
      grid-template-columns: minmax(0, 1fr) auto;
      row-gap: 8px;
    }
    .used {
      grid-column: 2;
      grid-row: 1;
    }
    .meter-slot,
    .rest {
      grid-column: 1 / -1;
    }
    .fc {
      grid-column: 1;
    }
    .reset {
      grid-column: 2;
      align-self: end;
    }
  }
</style>
