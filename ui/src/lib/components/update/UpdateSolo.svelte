<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { LocalUpdate } from "./local-update.svelte.js";
  import UpdateDirty from "./UpdateDirty.svelte";
  import UpdateDeployLog from "./UpdateDeployLog.svelte";
  import UpdateDiscardButton from "./UpdateDiscardButton.svelte";

  // The update window with no machines connected: this Shepherd's new commits and its update.
  let { local, onclose }: { local: LocalUpdate; onclose?: () => void } = $props();

  // commit subjects truncate to one line by default; tapping a row expands it to
  // the full width so the whole message is readable — on a phone the single line
  // otherwise cuts off with an ellipsis and you never see the end
  let expanded = $state<Record<string, boolean>>({});
  const toggle = (sha: string) => (expanded[sha] = !expanded[sha]);
  const update = $derived(local.update);
</script>

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
      <span class="row">
        <span class="sha">{c.sha}</span>
        <span class="subject">{c.subject}</span>
      </span>
    </button>
  {/each}
</div>

<UpdateDeployLog {local} />

{#if local.mode === "dirty" || local.mode === "toolarge"}
  <UpdateDirty
    dirty={local.dirty}
    body={m.updatemodal_dirty_body()}
    stale={local.staleHint}
    arming={local.arming && local.mode === "dirty"}
  />
{:else if local.mode === "nowclean"}
  <div class="status">{m.updatemodal_now_clean()}</div>
{/if}

{#if local.error}<div class="err">{local.error}</div>{/if}

<div class="actions">
  {#if !local.busy}
    <button
      type="button"
      class="later"
      onclick={() => (local.arming ? (local.arming = false) : onclose?.())}
    >
      {local.arming ? m.common_close() : m.updatemodal_later()}
    </button>
  {/if}

  {#if local.mode === "dirty"}
    <UpdateDiscardButton {local} />
  {:else if local.mode !== "toolarge"}
    <!-- toolarge offers no destructive action; the operator resolves it manually -->
    <button
      type="button"
      class="run"
      onclick={() => local.runUpdate()}
      disabled={local.busy || local.mode === "loading"}
    >
      {local.busy
        ? m.updatemodal_updating()
        : local.mode === "rawlog" || local.mode === "nowclean"
          ? m.updatemodal_retry()
          : m.updatemodal_update_now()}
    </button>
  {/if}
</div>

<style>
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
    font-family: var(--font-mono);
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
    font-family: var(--font-mono);
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
  @media (max-width: 768px) {
    .commits {
      flex-grow: 1; /* fill the sheet so the list, not a void, owns the space */
    }
  }
</style>
