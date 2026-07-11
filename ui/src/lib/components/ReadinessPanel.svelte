<script lang="ts">
  import { getReadiness, adoptGitignore } from "$lib/api";
  import type { GuardrailId, ReadinessReport } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { toasts } from "$lib/toasts.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { SvelteSet } from "svelte/reactivity";
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
      case "dependency_automation":
        return m.readiness_g_dependency_automation_title();
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
      case "dependency_automation":
        return m.readiness_g_dependency_automation_removes();
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

  // Independent of `report`: this only needs `repoPath`, so it stays actionable
  // even when the scorecard is loading-errored or the repo isn't JS/TS.
  // Keyed by repoPath, not a single boolean: the component persists across repo
  // switches (no {#key} in BacklogView), so a per-repo set keeps an in-flight
  // adopt for one repo from disabling the button on any other repo you switch to.
  const adoptingRepos = new SvelteSet<string>();

  async function adoptGitignoreClick() {
    const rp = repoPath;
    if (adoptingRepos.has(rp)) return;
    adoptingRepos.add(rp);
    try {
      const res = await adoptGitignore(rp);
      // Ignore a result that landed after the operator switched repos.
      if (rp !== repoPath) return;
      if (res.status === "applied") {
        const url = res.prUrl ?? "";
        toasts.info(m.readiness_adopt_gitignore_applied({ url }), {
          key: "adopt-gitignore-applied",
          action: url
            ? {
                label: m.readiness_adopt_gitignore_view_pr(),
                run: () => window.open(url, "_blank", "noopener,noreferrer"),
              }
            : undefined,
        });
      } else if (res.status === "already") {
        toasts.info(m.readiness_adopt_gitignore_already(), { key: "adopt-gitignore-already" });
      } else if (res.status === "no-forge") {
        // No forge configured: a PR is impossible, but the local exclude already
        // hides the artifacts — an info outcome, not a retryable error.
        toasts.info(m.readiness_adopt_gitignore_no_forge(), {
          key: "adopt-gitignore-no-forge",
        });
      } else if (res.status === "no-access") {
        toasts.info(m.readiness_adopt_gitignore_no_access(), {
          key: "adopt-gitignore-no-access",
        });
      }
    } catch {
      if (rp !== repoPath) return;
      // Assertive failure (alert) → 12s auto-dismiss, keyed per-tone so repeated
      // failures collapse into one toast instead of stacking.
      toasts.info(m.readiness_adopt_gitignore_error(), {
        alert: true,
        key: "adopt-gitignore-fail",
      });
    } finally {
      // Release only THIS repo's lock — deleting `rp` (not the current repoPath)
      // so a concurrent adopt on another repo isn't cleared, and a mid-adopt
      // repo switch never leaves the lock stuck.
      adoptingRepos.delete(rp);
    }
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
          <span class="score-figure">
            <span class="score-num">{report.score}</span>
            <span class="score-pct">%</span>
          </span>
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

  <!-- Always-visible (whenever not loading): depends only on repoPath, so it stays
       actionable across the applicable, not-applicable and load-error states. -->
  {#if !loading}
    <div class="adopt-gitignore">
      <button
        class="cta"
        type="button"
        disabled={adoptingRepos.has(repoPath)}
        onclick={adoptGitignoreClick}
        use:coachTarget={"adopt-gitignore"}
      >
        {m.readiness_adopt_gitignore_button()}
      </button>
      <div class="adopt-gitignore-note">{m.readiness_adopt_gitignore_note()}</div>
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
    align-items: center;
    justify-content: center;
    min-width: 64px;
    height: 64px;
    border-radius: 50%;
    border: 2px solid var(--color-line-bright);
    color: var(--color-ink-bright);
  }
  /* Keep the % on the number's baseline while the group sits centered in the ring. */
  .score-figure {
    display: flex;
    align-items: baseline;
  }
  .score-ring.low {
    border-color: var(--color-red);
    color: var(--color-red);
  }
  .score-ring.fair {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .score-ring.good,
  .score-ring.strong {
    border-color: var(--color-green);
    color: var(--color-green);
  }
  .score-num {
    font-size: var(--fs-2xl);
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
    color: var(--color-amber);
  }
  .score-band.good,
  .score-band.strong {
    color: var(--color-green);
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
    font-size: var(--fs-meta);
  }
  .dot.present {
    color: var(--color-green);
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
    color: var(--color-green);
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
  .cta:disabled {
    opacity: 0.55;
    cursor: default;
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
    color: var(--color-amber);
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

  /* ── always-visible .gitignore adoption footer ── */
  .adopt-gitignore {
    padding: 12px 14px;
    border-top: 1px solid var(--color-line);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .adopt-gitignore-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    line-height: 1.45;
  }
</style>
