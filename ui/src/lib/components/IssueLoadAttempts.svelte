<script lang="ts">
  /**
   * The gh transports that ran and failed behind a "couldn't load issues" state.
   *
   * GitHub answers issue listings over two INDEPENDENT budgets (`gh issue list` on
   * the GraphQL bucket, `gh api` on the REST bucket) and Shepherd falls back from one
   * to the other, so "couldn't load" alone leaves the operator guessing at a rate
   * limit when the real cause may be an expired login. Each line names one transport
   * that actually ran, in the order it ran; hovering reveals the full gh message.
   *
   * Renders ONLY the trail — the failure sentence and the retry control stay with the
   * caller, whose type scale and padding differ (the modal runs on --fs-meta, the
   * panel on --fs-base), which is why sizing here is inherited rather than set.
   */
  import type { IssueFetchAttempt } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { statusTip } from "$lib/actions/statusTip.svelte";

  const {
    attempts,
    /** Suppress the tooltip's entrance animation on motion-free surfaces (New Task). */
    still = false,
  }: { attempts: IssueFetchAttempt[]; still?: boolean } = $props();

  function transportLabel(a: IssueFetchAttempt): string {
    switch (a.transport) {
      case "cli":
        return m.issues_transport_cli();
      case "rest":
        return m.issues_transport_rest();
      // Wire data: a transport this build doesn't know is shown verbatim rather than
      // dropped — naming an unfamiliar path still beats naming none.
      default:
        return a.transport;
    }
  }

  function reasonLabel(a: IssueFetchAttempt): string {
    switch (a.reason) {
      case "rate_limit":
        return m.issues_attempt_rate_limit();
      case "auth":
        return m.issues_attempt_auth();
      case "not_found":
        return m.issues_attempt_not_found();
      case "gh_missing":
        return m.issues_attempt_gh_missing();
      case "network":
        return m.issues_attempt_network();
      // `http` without a status would render "HTTP undefined"; fall through instead.
      case "http":
        return a.status === undefined
          ? m.issues_attempt_unknown()
          : m.issues_attempt_http({ status: a.status });
      default:
        return m.issues_attempt_unknown();
    }
  }
</script>

{#if attempts.length > 0}
  <div class="attempts">
    <span class="attempts-label">{m.issues_attempts_label()}</span>
    <ul class="attempt-list">
      <!-- Keyed by index: the trail is a short, positional record of one fetch, and
           the same transport can legitimately appear twice across future orders. -->
      {#each attempts as a, i (i)}
        <li class="attempt" use:statusTip={a.detail ? { text: a.detail, still, wide: true } : null}>
          <span class="attempt-transport">{transportLabel(a)}</span>
          <span class="attempt-arrow" aria-hidden="true">→</span>
          <span class="attempt-reason">{reasonLabel(a)}</span>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .attempts {
    /* Inherit the caller's type scale — this block is a continuation of its
       failure sentence, not a surface of its own. */
    font-family: var(--font-mono);
    font-size: inherit;
    color: var(--color-faint);
    margin-top: 6px;
  }

  .attempts-label {
    display: block;
  }

  .attempt-list {
    list-style: none;
    margin: 0;
    padding: 0 0 0 12px;
  }

  .attempt {
    /* Fits the widest line without wrapping mid-reason on a narrow panel. */
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    width: fit-content;
    max-width: 100%;
  }

  .attempt-transport {
    /* One step brighter than the surrounding faint text: the command name is the
       part the operator scans for. */
    color: var(--color-muted);
  }
</style>
