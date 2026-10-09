<script lang="ts">
  import type { CompletedEpic, LandingCiAutomation } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { formatAgo } from "#lib/format.js";
  import AutomationPanel from "./AutomationPanel.svelte";
  import GuardMarker from "./GuardMarker.svelte";

  // #2872: what is red on an epic's landing PR and who handles it — Shepherd's automatic reruns,
  // the agent repair (only with Auto-Drain on), then the operator. Display-only: every state comes
  // from the server's landingCiChecks / landingCiAutomation, which mirror the drain's gates.
  let {
    epic,
    nowMs,
    onopensession,
  }: {
    epic: CompletedEpic;
    nowMs: number;
    onopensession: (id: string) => void;
  } = $props();

  let panelOpen = $state(false);
  let wrapEl = $state<HTMLElement | null>(null);

  const checks = $derived(epic.landingCiChecks);
  const automation = $derived(epic.landingCiAutomation);

  type SkipReason =
    LandingCiAutomation["reruns"]["skipReason"] | LandingCiAutomation["repair"]["skipReason"];
  function skipText(reason: SkipReason): string {
    switch (reason) {
      case "auto-drain-off":
        return m.landing_ci_skip_auto_drain_off();
      case "no-github":
        return m.landing_ci_skip_no_github();
      case "draft-mode":
        return m.landing_ci_skip_draft_mode();
      case "not-engaged":
        return m.landing_ci_skip_not_engaged();
      case "draft-pr":
        return m.landing_ci_skip_draft_pr();
      default:
        return m.landing_ci_skip_no_run();
    }
  }

  const rerunText = $derived.by(() => {
    const r = automation?.reruns;
    if (!r) return "";
    if (r.status === "skipped") return skipText(r.skipReason);
    if (r.status === "running") return m.landing_ci_rerun_running({ used: r.used, cap: r.cap });
    if (r.status === "done") return m.landing_ci_stage_done_red({ used: r.used, cap: r.cap });
    return m.landing_ci_stage_pending();
  });

  const repairText = $derived.by(() => {
    const r = automation?.repair;
    if (!r) return "";
    if (r.status === "skipped") return skipText(r.skipReason);
    if (r.status === "done") return m.landing_ci_stage_done_red({ used: r.used, cap: r.cap });
    if (r.status === "pending") return m.landing_ci_stage_pending();
    const running =
      r.sessionStartedAt != null
        ? m.landing_ci_repair_running({ ago: formatAgo(nowMs - r.sessionStartedAt) })
        : m.landing_ci_repair_running_nostart();
    const names = (checks?.failed ?? []).map((c) => c.name).join(", ");
    return names ? `${running} · ${m.landing_ci_repair_fixing({ checks: names })}` : running;
  });

  // The anchored, non-modal AutomationPanel popover: Escape and an outside click close it (as in
  // GuardTimeline); Escape is consumed so an enclosing dialog stays open.
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !panelOpen) return;
    e.preventDefault();
    panelOpen = false;
  }
  function onWindowPointerdown(e: PointerEvent) {
    if (panelOpen && wrapEl && !wrapEl.contains(e.target as Node)) panelOpen = false;
  }
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

{#if checks && (checks.failed.length > 0 || checks.running > 0)}
  <section class="lcs-checks" aria-label={m.landing_ci_checks_label()}>
    {#if checks.failed.length > 0}
      <ul>
        {#each checks.failed as check, i (i)}
          <li>
            <span class="lcs-x" aria-hidden="true">✕</span>
            <span class="lcs-name">{check.name}</span>
            {#if check.url}
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
              <a href={check.url} target="_blank" rel="noopener noreferrer">{m.landing_ci_log()}</a>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    <p class="lcs-counts">
      {m.landing_ci_counts({ running: checks.running, passed: checks.passed })}
    </p>
  </section>
{/if}

{#if automation}
  <section
    class="lcs-who"
    aria-label={m.landing_ci_who_heading()}
    bind:this={wrapEl}
    onkeydowncapture={onKeydown}
  >
    <h5>{m.landing_ci_who_heading()}</h5>
    <ol>
      <li class="lcs-stage" data-stage="reruns" data-status={automation.reruns.status}>
        <GuardMarker kind={automation.reruns.status === "skipped" ? "conditional" : "auto"} />
        <span class="lcs-label">{m.landing_ci_reruns_label()}</span>
        <span class="lcs-state">{rerunText}</span>
      </li>
      <li class="lcs-stage" data-stage="repair" data-status={automation.repair.status}>
        <GuardMarker kind={automation.repair.status === "skipped" ? "conditional" : "auto"} />
        <span class="lcs-label">{m.landing_ci_repair_label()}</span>
        <span class="lcs-state">{repairText}</span>
        {#if automation.repair.status === "done" && automation.repair.sessionId}
          {@const id = automation.repair.sessionId}
          <button type="button" class="lcs-link" onclick={() => onopensession(id)}
            >{m.landing_ci_view_session()}</button
          >
        {/if}
        {#if automation.repair.skipReason === "auto-drain-off"}
          <button
            type="button"
            class="lcs-link"
            aria-expanded={panelOpen}
            onclick={() => (panelOpen = !panelOpen)}>{m.landing_ci_open_automation()}</button
          >
        {/if}
      </li>
      <li class="lcs-stage" data-stage="you">
        <GuardMarker kind="human" />
        <span class="lcs-label">{m.landing_ci_you_label()}</span>
      </li>
    </ol>
    {#if panelOpen}
      <!-- touch-only dim+blur behind the automation sheet (AutomationPanel turns into a fixed
           full-screen sheet on coarse pointers); purely visual → aria-hidden. -->
      <div class="lcs-scrim scrim" aria-hidden="true"></div>
      <AutomationPanel repoPath={epic.repoPath} onClose={() => (panelOpen = false)} />
    {/if}
  </section>
{/if}

<style>
  .lcs-checks ul,
  .lcs-who ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .lcs-checks {
    margin-top: 10px;
  }
  .lcs-checks li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    min-width: 0;
  }
  .lcs-x {
    color: var(--color-red);
    flex: none;
  }
  .lcs-name {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .lcs-checks a {
    flex: none;
    margin-left: auto;
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .lcs-checks a:hover {
    color: var(--color-ink-bright);
  }
  .lcs-counts {
    margin: 4px 0 0;
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .lcs-who {
    position: relative;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--color-line);
  }
  h5 {
    margin: 0 0 6px;
    font-size: var(--fs-micro);
    font-weight: normal;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .lcs-stage {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 6px;
    row-gap: 2px;
    font-size: var(--fs-micro);
    color: var(--color-ink);
  }
  .lcs-label {
    color: var(--color-ink-bright);
  }
  .lcs-state {
    color: var(--color-muted);
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .lcs-link {
    margin: 0;
    padding: 0;
    background: transparent;
    border: 0;
    cursor: pointer;
    color: var(--color-amber);
    font: inherit;
  }
  .lcs-link:hover {
    color: var(--color-ink-bright);
  }
  .lcs-link:focus-visible {
    outline: 2px solid var(--color-ink-bright);
    outline-offset: 2px;
  }
  .lcs-scrim {
    display: none;
    z-index: 50;
  }
  @media (pointer: coarse) {
    .lcs-scrim {
      display: block;
    }
    .lcs-link {
      min-height: 44px;
    }
  }
</style>
