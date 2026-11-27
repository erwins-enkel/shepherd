<script lang="ts" module>
  /** What the last confirmed save produced: a commit, or a PR when the branch refused it. */
  export interface RulesSaved {
    commit: string | null;
    pr: { number: number; url: string } | null;
  }
</script>

<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { firstSafeHttpUrl } from "#lib/url.js";
  import type { RepoConfigEditor } from "../repo-settings/repo-config-editor.svelte.js";

  // The Backlog Settings tab's sticky footer (#4274): staged repository rules, the one action that
  // reviews and commits them, and the outcome of the last save — on every section and scroll.
  let {
    editor,
    preparing,
    error,
    saved,
    onreview,
    ondismiss,
  }: {
    editor: RepoConfigEditor;
    preparing: boolean;
    error: string;
    saved: RulesSaved | null;
    onreview: () => void;
    ondismiss: () => void;
  } = $props();

  const count = $derived(Object.keys(editor.draft).length);
  const unshared = $derived(editor.view?.repoConfigCommit === null);
  const branch = $derived(editor.view?.repoConfigBranch ?? "");
  const busy = $derived(preparing || editor.saving);
  const notifyFailed = $derived(editor.view?.notifications?.some((result) => !result.ok) ?? false);
</script>

<div
  class={["bar", { pending: editor.dirty }]}
  role="region"
  aria-label={m.automation_layers_bar_label()}
>
  {#if editor.dirty || unshared}
    <div class="text">
      {#if editor.dirty}
        <strong class="count">
          <span class="dot" aria-hidden="true"></span>{m.automation_layers_pending_count({
            count,
          })}
        </strong>
        <span class="note">{m.automation_layers_commit_note({ branch })}</span>
      {:else}
        <span class="note">{m.automation_layers_unshared_note()}</span>
      {/if}
    </div>
    <div class="actions">
      <button
        class="gbtn primary"
        disabled={busy || (!editor.dirty && !unshared)}
        onclick={onreview}
      >
        {unshared ? m.automation_layers_share() : m.automation_layers_review()}
      </button>
      {#if editor.dirty}<button class="gbtn" disabled={busy} onclick={() => editor.discard()}>
          {m.automation_layers_discard()}
        </button>{/if}
    </div>
  {:else if saved}
    <div class="text" role="status">
      {#if saved.pr}
        <span>
          {m.automation_layers_saved_pr({ number: saved.pr.number })}
          <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge PR URL -->
          <a
            href={firstSafeHttpUrl(saved.pr.url) ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
          >
            {m.reposettings_pending_link({ number: saved.pr.number })}
          </a>
          <!-- eslint-enable svelte/no-navigation-without-resolve -->
        </span>
      {:else}
        <span>{m.automation_layers_saved({ commit: saved.commit ?? "" })}</span>
      {/if}
      {#if notifyFailed}<span class="note">{m.automation_layers_notify()}</span>{/if}
    </div>
    <div class="actions">
      <button class="gbtn" onclick={ondismiss}>{m.automation_layers_dismiss()}</button>
    </div>
  {/if}
  {#if error}<p class="err" role="alert">{error}</p>{/if}
</div>

<style>
  .bar {
    position: sticky;
    bottom: 0;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    margin-top: 12px;
    padding: 10px 12px max(10px, env(safe-area-inset-bottom));
    background: var(--color-panel);
    border-top: 1px solid var(--color-line-bright);
    font-size: var(--fs-meta);
  }
  .bar.pending {
    border-top-color: var(--color-amber);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 260px;
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--color-ink);
  }
  .count {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    color: var(--color-amber);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-amber);
    flex: 0 0 auto;
  }
  .note {
    color: var(--color-muted);
  }
  a {
    color: inherit;
    text-decoration: underline;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  /* The design-system .gbtn recipe; the primary is filled so the one save path reads at a glance. */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 6px 12px;
    cursor: pointer;
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
    background: var(--color-amber);
    border-color: var(--color-amber);
    color: var(--color-on-action);
    font-weight: 600;
  }
  .gbtn.primary:hover:not(:disabled) {
    color: var(--color-on-action);
  }
  .gbtn.primary:focus-visible {
    box-shadow: inset 0 0 0 2px var(--color-on-action);
  }
  .err {
    flex-basis: 100%;
    margin: 0;
    color: var(--color-red);
  }
  @media (pointer: coarse) {
    .actions button {
      min-height: 44px;
    }
  }
</style>
