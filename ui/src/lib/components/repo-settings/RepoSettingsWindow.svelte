<script lang="ts">
  import { onMount } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { basename } from "#lib/basename.js";
  import { repos } from "#lib/repos.svelte.js";
  import type { DrainStatus, Session, Settings } from "#lib/types.js";
  import type { RepoSettingsSection as SectionId } from "./sections";
  import RepoSettingsBody from "./RepoSettingsBody.svelte";
  import { revealSetting } from "./setting-link";

  // The repo settings window (#3443): every repo setting in one modal (RepoSettingsBody), full
  // screen on a phone.
  let {
    repoPath,
    section,
    field,
    sessionId,
    planPhase = null,
    drain = null,
    globals = null,
    onsetupci,
    onclose,
  }: {
    repoPath: string;
    /** The section to open at; absent = the first one a hint marks, else Autonomy. */
    section?: SectionId;
    /** A row to scroll into view once it renders (#3922: the blocked egress hosts). */
    field?: string;
    /** The task it was opened from: its review pulse and plan gate show here. */
    sessionId?: string;
    planPhase?: Session["planPhase"];
    /** The repo's live drain: epic mode, the drain's rails, a sandbox-held epic. */
    drain?: DrainStatus | null;
    /** The page's global settings an "inherit" follows; null while they load. */
    globals?: Settings | null;
    /** Seed a New Task that sets up PR CI for this repo (#3305). */
    onsetupci?: () => void;
    onclose: () => void;
  } = $props();

  const repoName = $derived(repos.nameFor(repoPath) ?? basename(repoPath));

  let card = $state<HTMLDivElement>();
  // Open on the section's tab, so the arrow keys move between sections right away.
  onMount(() => {
    card?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    if (field && card) return revealSetting(card, field);
  });
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    bind:this={card}
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.reposettings_dialog_label({ repo: repoName })}
    use:dialog={{ onclose }}
    data-repo-settings
  >
    <RepoSettingsBody
      {repoPath}
      {section}
      {sessionId}
      {planPhase}
      {drain}
      {globals}
      {onsetupci}
      variant="window"
    >
      {#snippet headEnd()}
        <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
      {/snippet}
    </RepoSettingsBody>
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
    z-index: 40;
  }
  .card {
    position: relative;
    width: min(820px, 94vw);
    height: min(720px, 88vh);
    border: 1px solid var(--color-line-bright);
    background: var(--color-inset);
    box-shadow: var(--shadow-popover);
    color: var(--color-ink);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .x {
    min-width: 32px;
    min-height: 32px;
    border: 0;
    background: transparent;
    color: var(--color-muted);
    font-size: var(--fs-base);
    cursor: pointer;
  }
  .x:hover,
  .x:focus-visible {
    color: var(--color-amber);
    outline: none;
  }
  /* Phone: full screen; the body stacks its chips above the section by its container width. */
  @media (max-width: 768px) {
    .card {
      width: 100vw;
      height: 100dvh;
      border: 0;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
    }
    .x {
      order: 1;
      min-width: 44px;
      min-height: 44px;
    }
  }
</style>
