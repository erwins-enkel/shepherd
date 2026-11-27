<script lang="ts">
  import { ApiError, enableSessionArtifact, getSessionArtifact } from "#lib/api.js";
  import { m } from "#lib/paraglide/messages.js";
  import { artifactTrimExplanation } from "#lib/tooltips/explanations.js";
  import InfoTip from "./InfoTip.svelte";

  // #4293: the built-in tool trim keeps Claude's Artifact tool from a task that did not start with
  // `/design`, and a resume re-applies it. This row says so and offers the operator's per-session
  // opt-in, which resumes the same session (worktree and conversation kept) when Claude must
  // restart. Renders nothing while the answer is unknown or the tool is not trimmed — Codex, the
  // Operator Assistant, a remote session and an already-enabled one all answer `trimmed: false`
  // or fail the read.
  let { sessionId }: { sessionId: string } = $props();

  let trimmed = $state(false);
  let busy = $state(false);
  let outcome = $state<"restarted" | "saved" | "failed" | null>(null);

  $effect(() => {
    const id = sessionId;
    trimmed = false;
    outcome = null;
    let current = true;
    getSessionArtifact(id).then(
      (r) => {
        if (current) trimmed = r.trimmed;
      },
      () => {},
    );
    return () => {
      current = false;
    };
  });

  async function enable() {
    if (busy) return;
    busy = true;
    outcome = null;
    try {
      const r = await enableSessionArtifact(sessionId);
      trimmed = false;
      outcome = r.restarted ? "restarted" : null;
    } catch (e) {
      const saved = e instanceof ApiError && e.code === "resume-refused";
      if (saved) trimmed = false;
      outcome = saved ? "saved" : "failed";
    } finally {
      busy = false;
    }
  }

  const outcomeText = $derived(
    outcome === "restarted"
      ? m.artifact_access_restarted()
      : outcome === "saved"
        ? m.artifact_access_saved()
        : outcome === "failed"
          ? m.artifact_access_failed()
          : "",
  );
</script>

{#if trimmed}
  <div class="aa-row" data-testid="artifact-access">
    <div class="aa-text">
      <span class="aa-title">
        {m.artifact_access_title()}
        <InfoTip text={artifactTrimExplanation()} label={m.artifact_access_info()} />
      </span>
      <span class="aa-hint">{m.artifact_access_hint()}</span>
      {#if outcome === "failed"}<span class="aa-hint" role="alert">{outcomeText}</span>{/if}
    </div>
    <button type="button" class="gbtn primary" disabled={busy} onclick={enable}>
      {busy ? m.artifact_access_enabling() : m.artifact_access_enable()}
    </button>
  </div>
{:else if outcome}
  <p class="aa-row aa-hint" role="status">{outcomeText}</p>
{/if}

<style>
  .aa-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin: 0;
    padding: 10px 12px 10px 16px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-head);
    flex-shrink: 0;
  }
  .aa-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .aa-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  .aa-hint {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  /* .gbtn recipe (/design-system) */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-chip);
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 3px 9px;
    white-space: nowrap;
    cursor: pointer;
    flex-shrink: 0;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  @media (pointer: coarse) {
    .gbtn {
      min-height: var(--mobile-actionbar-hit);
      padding: 6px 12px;
      font-size: var(--fs-base);
    }
  }
</style>
