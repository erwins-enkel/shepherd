<script lang="ts">
  import type { BacklogPayload, Issue, PullRequest } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { dialog } from "$lib/a11yDialog";
  import BacklogView from "./BacklogView.svelte";

  let {
    payload,
    mobile,
    onissue,
    onquick = undefined,
    onpr,
    onclose,
  }: {
    payload: BacklogPayload | null;
    mobile: boolean;
    onissue: (repoPath: string, issue: Issue) => void;
    onquick?: (repoPath: string, issue: Issue) => void;
    onpr: (repoPath: string, pr: PullRequest) => void;
    onclose: () => void;
  } = $props();
</script>

<div
  class="overlay"
  class:mobile
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="card"
    class:mobile
    role="dialog"
    aria-modal="true"
    aria-label={m.actionbar_backlog()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.actionbar_backlog()}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>
    <div class="body">
      <BacklogView {payload} {mobile} {onissue} {onquick} {onpr} />
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
    z-index: 20;
    padding: 24px;
  }
  .overlay.mobile {
    padding: 0;
  }
  .card {
    width: min(960px, 94vw);
    max-height: 88vh;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .card.mobile {
    width: 100%;
    max-height: none;
    height: 100%;
    border: 0;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .chead {
    display: flex;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid var(--color-line);
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 2px 6px;
  }
  .x:hover {
    color: var(--color-amber);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
</style>
