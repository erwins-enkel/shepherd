<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import type { Session } from "#lib/types.js";
  import type { ViewTab } from "#lib/operator-assistant-view.js";
  import ViewportPreviewStart, { clearPreviewPending } from "./ViewportPreviewStart.svelte";

  type Tab = ViewTab;

  let {
    tab = $bindable(),
    session,
    previewPort,
    todoExists,
    hasFiles,
    hasPreview,
    hasBrowser,
    compact,
    headerFolded,
    vpBodyId,
    tabId,
    foldRegionId,
  }: {
    tab: Tab;
    session: Session;
    previewPort: number | null;
    todoExists: boolean;
    hasFiles: boolean;
    hasPreview: boolean;
    /** The repo has the Shared Browser enabled → the live Browser View tab. */
    hasBrowser: boolean;
    compact: boolean;
    headerFolded: boolean;
    vpBodyId: string;
    tabId: (t: Tab) => string;
    foldRegionId: string;
  } = $props();

  // Clear the ▶ start-pending guard once the preview binds. Lives here, not in
  // ViewportPreviewStart: that control unmounts as soon as a port binds (it only
  // renders while there is no preview), and this tab bar stays mounted throughout.
  $effect(() => {
    if (previewPort != null) clearPreviewPending(session.id);
  });
</script>

<div id={foldRegionId} class="tab-group" class:mobile={compact} class:folded={headerFolded}>
  <!-- The preview tab is pinned OUTSIDE this scroll strip (it must stay visible
       while the other tabs scroll), so the tablist owns it via aria-owns rather
       than DOM containment. Only the preview id is listed: the term/todo/activity/
       diff tabs are already DOM children and must not be referenced by aria-owns. -->
  <div
    class="tab-scroll"
    role="tablist"
    aria-label={m.viewport_tablist_aria()}
    aria-owns={hasPreview ? tabId("preview") : undefined}
  >
    <button
      class="tab-btn"
      class:active={tab === "chat"}
      role="tab"
      id={tabId("chat")}
      aria-selected={tab === "chat"}
      aria-controls={vpBodyId}
      use:coachTarget={"chat-tab"}
      onclick={() => (tab = "chat")}>{m.viewport_chat_tab()}</button
    >
    <button
      class="tab-btn"
      class:active={tab === "term"}
      role="tab"
      id={tabId("term")}
      aria-selected={tab === "term"}
      aria-controls={vpBodyId}
      onclick={() => (tab = "term")}>{m.viewport_terminal_tab()}</button
    >
    {#if todoExists}
      <!-- only when the repo has a TODO.md (server-resolved); skips the empty
           "add your first item" tab so the strip stays meaningful. -->
      <button
        class="tab-btn"
        class:active={tab === "todo"}
        role="tab"
        id={tabId("todo")}
        aria-selected={tab === "todo"}
        aria-controls={vpBodyId}
        onclick={() => (tab = "todo")}>{m.viewport_todo_tab()}</button
      >
    {/if}
    <button
      class="tab-btn"
      class:active={tab === "diff"}
      role="tab"
      id={tabId("diff")}
      aria-selected={tab === "diff"}
      aria-controls={vpBodyId}
      onclick={() => (tab = "diff")}>{m.viewport_diff_tab()}</button
    >
    {#if hasFiles}
      <!-- shown for any live session with a claudeSessionId, so files can be uploaded before the
           agent writes anything (#1258). hasScratchpadFiles is now subsumed — it can only be true
           for a live session with a claudeSessionId. Tab visibility is refreshed via session:status push. -->
      <button
        class="tab-btn"
        class:active={tab === "files"}
        role="tab"
        id={tabId("files")}
        aria-selected={tab === "files"}
        aria-controls={vpBodyId}
        use:coachTarget={"files-tab"}
        onclick={() => (tab = "files")}>{m.viewport_files_tab()}</button
      >
    {/if}
    {#if hasBrowser}
      <!-- the repo's Shared Browser, live (Browser View) — sits last, next to Preview -->
      <button
        class="tab-btn"
        class:active={tab === "browser"}
        role="tab"
        id={tabId("browser")}
        aria-selected={tab === "browser"}
        aria-controls={vpBodyId}
        onclick={() => (tab = "browser")}>{m.viewport_browser_tab()}</button
      >
    {/if}
  </div>
  {#if hasPreview}
    <!-- only while the server reports a bound preview listener (single source of
         truth: the live port). Disappears when the dev server stops. -->
    <button
      class="tab-btn preview-tab"
      class:active={tab === "preview"}
      role="tab"
      id={tabId("preview")}
      aria-selected={tab === "preview"}
      aria-controls={vpBodyId}
      onclick={() => (tab = "preview")}>{m.viewport_preview_tab()}</button
    >
  {:else if compact && !session.archivedAt}
    <!-- no preview yet: operator-triggered start. Compact keeps it pinned at the
         tab row's right edge; on desktop it lives in the actions cluster
         (ViewportHeaderActions) — it is an action, not navigation. -->
    <ViewportPreviewStart {session} variant="tab" />
  {/if}
</div>

<style>
  .tab-group {
    display: flex;
    gap: 2px;
  }
  /* desktop: the tab strip opens the right-hand cluster; auto margin pushes it (and
     everything after it) right so the task name keeps the free space and only
     ellipsizes once the row is genuinely full */
  .tab-group:not(.mobile) {
    margin-left: auto;
  }
  /* folded tabs are display:none rather than removed from the DOM so the active
     tab + terminal mount survive the toggle (no remount, no PTY teardown) */
  .tab-group.folded {
    display: none;
  }

  /* transparent pass-through on desktop (matches .tab-group's flex/gap so the
     desktop layout is visually identical); scrolls on compact/mobile below */
  .tab-scroll {
    display: flex;
    gap: 2px;
  }

  .tab-group.mobile {
    order: 10;
    flex-basis: 100%;
    gap: 4px;
  }
  /* phone: nav tabs scroll horizontally so the pinned preview slot (Preview tab
     / Start-dev-server control) stays visible at the row's right edge.
     Matches BacklogView's .overlay-tabs idiom (hidden scrollbar). */
  .tab-group.mobile .tab-scroll {
    flex: 1 1 0;
    min-width: 0;
    flex-wrap: nowrap;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .tab-group.mobile .tab-scroll::-webkit-scrollbar {
    display: none;
  }
  .tab-group.mobile .tab-btn {
    text-align: center;
    padding: 10px 6px;
    font-size: var(--fs-meta);
  }
  /* grow:1 fills the strip when tabs fit (no dead gap, large tap targets);
     shrink:0 + basis:auto forces overflow→scroll when they don't */
  .tab-group.mobile .tab-scroll .tab-btn {
    flex: 1 0 auto;
  }
  /* keep the preview slot pinned + always visible (the Start control's wrap sets
     its own flex-shrink:0 in ViewportPreviewStart) */
  .tab-group.mobile .preview-tab {
    flex-shrink: 0;
  }

  .tab-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }

  .tab-btn:hover {
    color: var(--color-ink);
  }

  .tab-btn.active {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
    background: var(--color-inset);
  }

  /* preview tab marker: the non-reserved blue accent ties it to the row badge */
  .tab-btn.preview-tab.active {
    border-color: var(--color-blue);
    color: var(--color-blue);
  }
</style>
