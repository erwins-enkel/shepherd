<script lang="ts">
  import { getReadiness } from "$lib/api";
  import type { GuardrailId, ReadinessReport } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { adoptList, haveList, scoreBand, buildAdoptPrompt } from "./readiness-view";

  let {
    repoPath,
    onadopt,
  }: {
    repoPath: string;
    /** Seed a New Task with the install prescription (verbatim snippet rides along). */
    onadopt: (repoPath: string, prompt: string) => void;
  } = $props();

  // Large response that is only ever reassigned → raw, no deep proxy.
  let report = $state.raw<ReadinessReport | null>(null);
  let loading = $state(true);
  // A failed fetch is distinct from a non-applicable repo: fail loud rather than
  // letting a load error read as "not a JS/TS repo".
  let loadError = $state(false);
  let copied = $state(false);

  // Reload whenever the selected repo changes; ignore a stale response that lands
  // after the user has moved on (matches ActionsPanel's guarded-load pattern).
  $effect(() => {
    const rp = repoPath;
    loading = true;
    loadError = false;
    report = null;
    copied = false;
    getReadiness(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        report = r;
        loading = false;
      })
      .catch(() => {
        if (rp !== repoPath) return;
        loadError = true;
        loading = false;
      });
  });

  let adopt = $derived(report ? adoptList(report) : []);
  let have = $derived(report ? haveList(report) : []);
  let band = $derived(report ? scoreBand(report.score) : "low");

  // id → translated chrome. Explicit switches (not dynamic m[`…${id}`]) so the
  // strings stay statically analysable for the i18n parity gate and svelte-check.
  function guardrailTitle(id: GuardrailId): string {
    switch (id) {
      case "pre_push_ci":
        return m.readiness_g_pre_push_ci_title();
      case "git_hooks":
        return m.readiness_g_git_hooks_title();
      case "type_checker":
        return m.readiness_g_type_checker_title();
      case "linter":
        return m.readiness_g_linter_title();
      case "formatter":
        return m.readiness_g_formatter_title();
      case "test_runner":
        return m.readiness_g_test_runner_title();
      case "agent_instructions":
        return m.readiness_g_agent_instructions_title();
      case "ci":
        return m.readiness_g_ci_title();
      case "lint_staged":
        return m.readiness_g_lint_staged_title();
      case "commit_lint":
        return m.readiness_g_commit_lint_title();
      case "dead_code_audit":
        return m.readiness_g_dead_code_audit_title();
    }
  }

  function guardrailRemoves(id: GuardrailId): string {
    switch (id) {
      case "pre_push_ci":
        return m.readiness_g_pre_push_ci_removes();
      case "git_hooks":
        return m.readiness_g_git_hooks_removes();
      case "type_checker":
        return m.readiness_g_type_checker_removes();
      case "linter":
        return m.readiness_g_linter_removes();
      case "formatter":
        return m.readiness_g_formatter_removes();
      case "test_runner":
        return m.readiness_g_test_runner_removes();
      case "agent_instructions":
        return m.readiness_g_agent_instructions_removes();
      case "ci":
        return m.readiness_g_ci_removes();
      case "lint_staged":
        return m.readiness_g_lint_staged_removes();
      case "commit_lint":
        return m.readiness_g_commit_lint_removes();
      case "dead_code_audit":
        return m.readiness_g_dead_code_audit_removes();
    }
  }

  function bandLabel(b: typeof band): string {
    switch (b) {
      case "low":
        return m.readiness_band_low();
      case "fair":
        return m.readiness_band_fair();
      case "good":
        return m.readiness_band_good();
      case "strong":
        return m.readiness_band_strong();
    }
  }

  async function copySnippet() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.claudeMd);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // clipboard blocked (insecure context / denied) — fail quietly; the text
      // is still visible in the block for manual selection.
    }
  }

  function sendToTask() {
    if (!report) return;
    const intro = report.hasAgentInstructions
      ? m.readiness_adopt_intro_merge()
      : m.readiness_adopt_intro_create();
    onadopt(repoPath, buildAdoptPrompt(intro, report.claudeMd));
  }
</script>

<div class="readiness-panel">
  {#if loading}
    <div class="muted">{m.common_loading()}</div>
  {:else if loadError}
    <div class="muted error">{m.readiness_load_error()}</div>
  {:else if !report || !report.applicable}
    <div class="na">
      <div class="na-title">{m.readiness_not_applicable_title()}</div>
      <div class="na-body">{m.readiness_not_applicable_body()}</div>
    </div>
  {:else}
    <div class="scroll">
      <!-- score header -->
      <div class="score-head">
        <div class="score-ring {band}">
          <span class="score-num">{report.score}</span>
          <span class="score-pct">%</span>
        </div>
        <div class="score-meta">
          <div class="score-label">{m.readiness_score_label()}</div>
          <div class="score-band {band}">{bandLabel(band)}</div>
          <div class="score-summary">
            {m.readiness_summary({ present: have.length, total: report.checks.length })}
          </div>
        </div>
      </div>

      <!-- adopt-list: absent guardrails, leverage-ranked, each stating the churn it removes -->
      {#if adopt.length > 0}
        <div class="section">
          <div class="section-head">{m.readiness_adopt_heading()}</div>
          <ul class="list">
            {#each adopt as g (g.id)}
              <li class="row adopt">
                <span class="dot absent" aria-hidden="true">○</span>
                <div class="row-body">
                  <div class="row-title">{guardrailTitle(g.id)}</div>
                  <div class="row-removes">{guardrailRemoves(g.id)}</div>
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <div class="all-covered">{m.readiness_all_covered()}</div>
      {/if}

      <!-- have-list: present guardrails with the markers that matched (verbatim) -->
      {#if have.length > 0}
        <div class="section">
          <div class="section-head">{m.readiness_have_heading()}</div>
          <ul class="list">
            {#each have as g (g.id)}
              <li class="row">
                <span class="dot present" aria-hidden="true">●</span>
                <div class="row-body">
                  <div class="row-title">{guardrailTitle(g.id)}</div>
                  <div class="row-evidence">{g.evidence.join(" · ")}</div>
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <!-- generated house-rules snippet (verbatim artifact) + actions -->
      <div class="section">
        <div class="section-head claudemd-head">
          <span>{m.readiness_claudemd_heading()}</span>
          <div class="cta-row">
            <button class="cta" type="button" onclick={copySnippet}>
              {copied ? m.readiness_copied() : m.readiness_copy()}
            </button>
            <button class="cta primary" type="button" onclick={sendToTask}>
              {m.readiness_send_to_task()}
            </button>
          </div>
        </div>
        {#if report.hasAgentInstructions}
          <div class="merge-note">{m.readiness_claudemd_present_note()}</div>
        {/if}
        <pre class="claudemd">{report.claudeMd}</pre>
      </div>
    </div>
  {/if}
</div>

<style>
  .readiness-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-inset);
    font-family: var(--font-mono);
    overflow: hidden;
  }

  .muted {
    font-size: var(--fs-base);
    color: var(--color-faint);
    padding: 12px;
  }
  .muted.error {
    color: var(--color-red);
  }

  .na {
    padding: 16px 14px;
  }
  .na-title {
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-bottom: 6px;
  }
  .na-body {
    font-size: var(--fs-base);
    color: var(--color-faint);
    line-height: 1.5;
  }

  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 12px 14px;
  }
  .scroll::-webkit-scrollbar {
    width: 4px;
  }
  .scroll::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }

  /* ── score header ── */
  .score-head {
    display: flex;
    align-items: center;
    gap: 14px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--color-line);
  }
  .score-ring {
    display: flex;
    align-items: baseline;
    justify-content: center;
    min-width: 64px;
    height: 64px;
    border-radius: 50%;
    border: 2px solid var(--color-line-bright);
    color: var(--color-ink-bright);
  }
  .score-ring.low {
    border-color: var(--color-red);
    color: var(--color-red);
  }
  .score-ring.fair {
    border-color: var(--color-amber, #d2a64a);
    color: var(--color-amber, #d2a64a);
  }
  .score-ring.good,
  .score-ring.strong {
    border-color: var(--color-green, #5aa86b);
    color: var(--color-green, #5aa86b);
  }
  .score-num {
    font-size: 1.5rem;
    font-weight: 600;
  }
  .score-pct {
    font-size: var(--fs-meta);
    opacity: 0.7;
  }
  .score-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .score-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  /* Band label color tracks the score ring so the two readouts agree. */
  .score-band {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink);
  }
  .score-band.low {
    color: var(--color-red);
  }
  .score-band.fair {
    color: var(--color-amber, #d2a64a);
  }
  .score-band.good,
  .score-band.strong {
    color: var(--color-green, #5aa86b);
  }
  .score-summary {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }

  /* ── sections / lists ── */
  .section {
    padding: 12px 0;
    border-bottom: 1px solid var(--color-line);
  }
  .section:last-child {
    border-bottom: none;
  }
  .section-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-bottom: 8px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .dot {
    line-height: 1.4;
    font-size: 0.7rem;
  }
  .dot.present {
    color: var(--color-green, #5aa86b);
  }
  .dot.absent {
    color: var(--color-faint);
  }
  .row-body {
    flex: 1;
    min-width: 0;
  }
  .row-title {
    font-size: var(--fs-base);
    color: var(--color-ink);
  }
  .row-removes {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
    margin-top: 1px;
  }
  .row-evidence {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    word-break: break-word;
  }
  .all-covered {
    padding: 12px 0;
    font-size: var(--fs-base);
    color: var(--color-green, #5aa86b);
    border-bottom: 1px solid var(--color-line);
  }

  /* ── generated snippet ── */
  .claudemd-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .cta-row {
    display: flex;
    gap: 6px;
  }
  .cta {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 3px 9px;
    cursor: pointer;
    transition:
      background 0.12s,
      border-color 0.12s;
  }
  .cta:hover {
    background: var(--color-hover);
  }
  .cta.primary {
    border-color: var(--color-line-bright);
    color: var(--color-ink-bright);
    background: var(--color-head);
  }
  .cta.primary:hover {
    border-color: var(--color-ink-bright);
  }
  .merge-note {
    font-size: var(--fs-meta);
    color: var(--color-amber, #d2a64a);
    margin-bottom: 6px;
  }
  .claudemd {
    margin: 0;
    padding: 10px;
    background: var(--color-head);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-ink);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 320px;
    overflow-y: auto;
  }
  .claudemd::-webkit-scrollbar {
    width: 4px;
  }
  .claudemd::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }
</style>
