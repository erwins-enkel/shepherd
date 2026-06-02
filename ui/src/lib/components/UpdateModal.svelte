<script lang="ts">
  import type { UpdateStatus, DeployState } from "$lib/types";
  import { applyUpdate } from "$lib/api";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";

  let {
    update,
    updating = false,
    deploy = null,
    onconfirm,
    onclose,
  }: {
    update: UpdateStatus;
    updating?: boolean;
    /** set once a launched deploy reports failure → show the captured reason */
    deploy?: DeployState | null;
    onconfirm?: () => void;
    onclose?: () => void;
  } = $props();

  let submitting = $state(false);
  let error = $state<string | null>(null);
  // commit subjects truncate to one line by default; tapping a row expands it to
  // the full width so the whole message is readable — on a phone the single line
  // otherwise cuts off with an ellipsis and you never see the end
  let expanded = $state<Record<string, boolean>>({});
  const toggle = (sha: string) => (expanded[sha] = !expanded[sha]);

  const failed = $derived(deploy?.phase === "failed");

  async function confirm() {
    submitting = true;
    error = null;
    try {
      await applyUpdate();
      onconfirm?.(); // store marks `updating`; the page reloads once the new build is live
    } catch (e) {
      error = e instanceof Error ? e.message : m.updatemodal_update_failed();
      submitting = false;
    }
  }

  const busy = $derived(submitting || updating);
  // while the deploy is in flight, show its captured output so the user sees
  // real progress (install → build → restart) instead of a frozen spinner
  const liveLog = $derived(busy && !failed && deploy?.log ? deploy.log : null);
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && !busy) onclose?.();
  }}
>
  <div
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={m.updatemodal_available()}
    use:dialog={{ onclose: () => !busy && onclose?.() }}
  >
    <div class="chead">
      <span class="micro">{m.updatemodal_available()}</span>
      {#if !busy}
        <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
          >✕</button
        >
      {/if}
    </div>

    <div class="summary">
      <span class="count">{update.behind}</span>
      <span class="micro"
        >{update.behind === 1 ? m.updatemodal_commits_one() : m.updatemodal_commits_other()}</span
      >
      {#if update.current && update.latest}
        <span class="shas micro">{update.current} → {update.latest}</span>
      {/if}
    </div>

    <div class="commits">
      {#each update.commits as c (c.sha)}
        <button
          type="button"
          class="commit"
          class:expanded={expanded[c.sha]}
          aria-expanded={!!expanded[c.sha]}
          title={c.subject}
          onclick={() => toggle(c.sha)}
        >
          <span class="sha">{c.sha}</span>
          <span class="subject">{c.subject}</span>
        </button>
      {/each}
    </div>

    {#if busy}
      <div class="status" aria-live="polite">{m.updatemodal_status()}</div>
    {/if}
    {#if liveLog}
      <div class="loghead micro">{m.updatemodal_deploy_log()}</div>
      <!-- The concise .status line above is the polite announcement; the raw log
           stays silent so a fast-appending stream doesn't re-announce every line. -->
      <pre class="log">{liveLog}</pre>
    {/if}
    {#if error}<div class="err">{error}</div>{/if}

    {#if failed}
      <div class="failure">
        <div class="err">
          {m.updatemodal_deploy_failed()}
          {#if deploy?.exitCode != null}
            <span class="code">{m.updatemodal_exit_code({ code: deploy.exitCode })}</span>
          {/if}
        </div>
        {#if deploy?.log}
          <div class="loghead micro">{m.updatemodal_deploy_log()}</div>
          <pre class="log">{deploy.log}</pre>
        {/if}
      </div>
    {/if}

    <div class="actions">
      {#if !busy}
        <button type="button" class="later" onclick={() => onclose?.()}
          >{m.updatemodal_later()}</button
        >
      {/if}
      <button type="button" class="run" onclick={confirm} disabled={busy}>
        {busy
          ? m.updatemodal_updating()
          : failed
            ? m.updatemodal_retry()
            : m.updatemodal_update_now()}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
    padding: 16px;
  }
  .card {
    position: relative;
    width: min(520px, 100%);
    max-height: 80dvh;
    display: flex;
    flex-direction: column;
    gap: 14px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 18px 18px 16px;
    box-shadow: inset 0 0 30px -16px var(--color-amber);
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: -1px;
    right: -1px;
    border-left: 0;
    border-top: 0;
  }
  .chead {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .micro {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font-size: 13px;
  }
  .summary {
    display: flex;
    align-items: baseline;
    gap: 9px;
  }
  .summary .count {
    color: var(--color-amber);
    font-size: 22px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .summary .shas {
    margin-left: auto;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .commits {
    overflow-y: auto;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .commit {
    display: flex;
    gap: 9px;
    align-items: flex-start;
    width: 100%;
    margin: 0;
    padding: 2px 0;
    background: transparent;
    border: 0;
    text-align: left;
    font-family: inherit;
    font-size: 12.5px;
    color: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .commit:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: 2px;
  }
  .commit .sha {
    color: var(--color-amber);
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .commit .subject {
    color: var(--color-ink-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* tapped open → wrap the full subject across the available width */
  .commit.expanded .subject {
    white-space: normal;
    overflow: visible;
    word-break: break-word;
  }
  /* touch devices: roomier rows so a single commit is easy to hit and read */
  @media (pointer: coarse) {
    .commit {
      padding: 8px 0;
      min-height: 34px;
      align-items: center;
    }
    .commit.expanded {
      align-items: flex-start;
    }
    .commits {
      gap: 0;
    }
    .commit + .commit {
      border-top: 1px solid var(--color-line);
    }
  }
  .status {
    color: var(--color-amber);
    font-size: 12px;
  }
  .err {
    color: var(--color-red);
    font-size: 12px;
  }
  .failure {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .failure .code {
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
    margin-left: 6px;
  }
  .loghead {
    color: var(--color-muted);
  }
  .log {
    margin: 0;
    max-height: 200px;
    overflow: auto;
    padding: 8px 10px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-size: 11.5px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .later {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    padding: 8px 14px;
    cursor: pointer;
    letter-spacing: 0.06em;
  }
  .run {
    background: transparent;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    font-weight: 600;
    padding: 8px 16px;
    cursor: pointer;
    letter-spacing: 0.06em;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .run:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
