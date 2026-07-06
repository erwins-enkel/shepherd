<script lang="ts">
  import type { UpdateStatus, DeployState } from "$lib/types";
  import { applyUpdate } from "$lib/api";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import AsciiFlockOverlay from "$lib/components/AsciiFlockOverlay.svelte";

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
  {#if busy}
    <AsciiFlockOverlay placement="backdrop" />
  {/if}
  <div
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={m.updatemodal_available()}
    use:dialog={{ onclose: () => !busy && onclose?.() }}
  >
    {#if busy}
      <AsciiFlockOverlay placement="sheet" />
    {/if}
    <div class="card-content">
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
            <!-- inner wrapper carries the flex layout: WebKit doesn't reliably
                 grow a <button> that is itself a flex container when a child
                 wraps, which painted the expanded subject over the next row -->
            <span class="row">
              <span class="sha">{c.sha}</span>
              <span class="subject">{c.subject}</span>
            </span>
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
    box-sizing: border-box;
    z-index: 1;
    width: min(520px, 100%);
    max-height: 80dvh;
    display: flex;
    flex-direction: column;
    gap: 0;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 18px 18px 16px;
    overflow-x: clip;
    box-shadow: inset 0 0 30px -16px var(--color-amber);
  }
  .card-content {
    position: relative;
    z-index: 1;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
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
    top: 0;
    left: 0;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: 0;
    right: 0;
    border-left: 0;
    border-top: 0;
  }
  .chead {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-base);
  }
  .summary {
    display: flex;
    align-items: baseline;
    gap: 9px;
  }
  .summary .count {
    color: var(--color-amber);
    font-size: var(--fs-2xl);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .summary .shas {
    margin-left: auto;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .commits {
    /* shrinkable flex child: without min-height the list refuses to shrink
       below its content and 16 commits push the actions off-screen */
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .commit {
    display: block;
    width: 100%;
    margin: 0;
    padding: 2px 0;
    background: transparent;
    border: 0;
    text-align: left;
    font-family: inherit;
    font-size: var(--fs-base);
    color: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .commit .row {
    display: flex;
    gap: 9px;
    align-items: flex-start;
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
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* tapped open → wrap the full subject across the available width */
  .commit.expanded .subject {
    white-space: normal;
    word-break: break-word;
  }
  /* touch devices: roomier rows so a single commit is easy to hit and read */
  @media (pointer: coarse) {
    .commit {
      padding: 8px 0;
    }
    .commit .row {
      min-height: 28px;
      align-items: center;
    }
    .commit.expanded .row {
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
    font-size: var(--fs-base);
  }
  .err {
    color: var(--color-red);
    font-size: var(--fs-base);
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
    flex: 1 1 96px;
    margin: 0;
    min-height: 96px;
    max-height: 200px;
    overflow: auto;
    padding: 8px 10px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
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
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
    box-shadow: none;
  }
  /* phones: rise as a full-height sheet (same pattern as NewTask) so the
     commit list gets the whole screen and scrolls internally while the
     actions stay pinned and thumb-reachable above the home indicator */
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
      padding: 0;
    }
    .card {
      width: 100%;
      max-height: none;
      height: 100dvh;
      border: 0;
      /* safe-area top: standalone-PWA status bar / Dynamic Island */
      padding: calc(16px + env(safe-area-inset-top)) 16px calc(14px + env(safe-area-inset-bottom));
      /* fallback when even fully-shrunk content exceeds the viewport
         (landscape phones): scroll the card rather than clip the actions */
      overflow-y: auto;
      animation: sheet-up 0.18s ease-out;
    }
    .card-content {
      min-height: 100%;
    }
    .bracket::before,
    .bracket::after {
      display: none;
    }
    .x {
      min-width: 44px;
      min-height: 44px;
      margin: -14px -14px -10px 0; /* keep the glyph optically in the corner */
    }
    .commits {
      flex-grow: 1; /* fill the sheet so the list, not a void, owns the space */
    }
    .later,
    .run {
      min-height: 44px;
      flex: 1; /* two thumb-width targets instead of two slivers at the edge */
    }
    .actions {
      margin-top: auto; /* pin to the bottom even when few commits */
    }
  }
  @keyframes sheet-up {
    from {
      transform: translateY(12px);
      opacity: 0.6;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style>
