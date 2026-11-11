<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { coachTarget, coachTargets } from "#lib/actions/coachTarget.svelte.js";
  import { featureDiscovery } from "#lib/featureDiscovery.svelte.js";
  import { featureAnnouncements } from "#lib/feature-announcements.js";
  import LazyMount from "#lib/components/page/LazyMount.svelte";
  import { loadCoachmark } from "#lib/components/page/overlay-loaders.js";
  import { reviews, repoConfig, planGates } from "#lib/reviews.svelte.js";
  import { automationCount, AUTOMATION_TOTAL } from "../git-rail-automation";
  import type { Session } from "#lib/types.js";
  import type { ViewTab } from "#lib/operator-assistant-view.js";
  import ViewportPreviewStart, { clearPreviewPending } from "./ViewportPreviewStart.svelte";

  type Tab = ViewTab;

  let {
    tab = $bindable(),
    session,
    previewPort,
    todoExists,
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

  // Automation tab: the repo's automation count, amber while a critic or plan review runs.
  const hasAutomation = $derived(!!session.repoPath);
  $effect(() => {
    if (session.repoPath) repoConfig.ensure(session.repoPath);
  });
  const autoCount = $derived(automationCount(repoConfig.flags(session.repoPath)));
  const autoReviewing = $derived(
    reviews.isReviewing(session.id) || planGates.isReviewing(session.id),
  );

  // The critic / auto-address toggles live in the Automation tab, so their discovery coachmarks
  // anchor on its button: a "new" dot while either is unseen, and the first unseen one arms once
  // the operator leaves the tab after opening it.
  const TAB_FEATURE_IDS = ["critic", "auto-address"] as const;
  const automationHasUnseen = $derived(TAB_FEATURE_IDS.some((id) => !featureDiscovery.isSeen(id)));
  let armedId = $state<string | null>(null);
  let sawAutomation = false;
  $effect(() => {
    if (tab === "automation") {
      sawAutomation = true;
      return;
    }
    if (!sawAutomation) return;
    sawAutomation = false;
    const next = TAB_FEATURE_IDS.find((id) => !featureDiscovery.isSeen(id) && coachTargets.has(id));
    if (next) armedId = next;
  });
  const armedEntry = $derived(
    armedId && !featureDiscovery.isSeen(armedId) && coachTargets.has(armedId)
      ? (featureAnnouncements.find((e) => e.targetId === armedId) ?? null)
      : null,
  );
</script>

<div id={foldRegionId} class="tab-group" class:mobile={compact} class:folded={headerFolded}>
  <!-- The preview tab is pinned OUTSIDE this scroll strip (it must stay visible
       while the other tabs scroll), so the tablist owns it via aria-owns rather
       than DOM containment. Only the preview id is listed: the term/todo/activity/
       files tabs are already DOM children and must not be referenced by aria-owns. -->
  <div
    class="tab-scroll"
    role="tablist"
    aria-label={m.viewport_tablist_aria()}
    aria-owns={hasPreview ? tabId("preview") : undefined}
  >
    {#if !session.terminal}
      <!-- a clean terminal is a bare shell: there is no agent to chat with -->
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
    {/if}
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
    <!-- always shown: the Diff subtab inside Files is available for every session. Scratchpad /
         Worktree subtabs appear there only when computeHasFiles holds (#1258, #1717). -->
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
    {#if hasAutomation}
      <!-- the repo's automation settings + this task's autopilot override -->
      <button
        class="tab-btn auto-tab"
        class:active={tab === "automation"}
        role="tab"
        id={tabId("automation")}
        aria-selected={tab === "automation"}
        aria-controls={vpBodyId}
        aria-busy={autoReviewing}
        aria-label={autoReviewing
          ? m.viewport_automation_tab_reviewing_aria({ count: autoCount, total: AUTOMATION_TOTAL })
          : m.viewport_automation_tab_aria({ count: autoCount, total: AUTOMATION_TOTAL })}
        use:coachTarget={"automation-tab"}
        use:coachTarget={"critic"}
        use:coachTarget={"auto-address"}
        onclick={() => (tab = "automation")}
        >{m.viewport_automation_tab()}
        <span class="auto-count" class:on={autoCount > 0} class:reviewing={autoReviewing}
          >{autoCount}/{AUTOMATION_TOTAL}</span
        >{#if automationHasUnseen}<span class="new-dot" aria-hidden="true"></span><span
            class="sr-only">{m.newdot_aria()}</span
          >{/if}</button
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
{#if armedEntry}
  <!-- Lazy: the feature-catalog copy rides with Coachmark, off the boot bundle (#3242). -->
  <LazyMount load={loadCoachmark} onerror={() => (armedId = null)}>
    {#snippet children(Coachmark)}
      <Coachmark
        targetId={armedEntry.targetId ?? null}
        titleKey={armedEntry.titleKey}
        bodyKey={armedEntry.bodyKey}
        onseen={() => {
          if (armedId) featureDiscovery.markSeen(armedId);
          armedId = null;
        }}
        onclose={() => {
          armedId = null;
        }}
      />
    {/snippet}
  </LazyMount>
{/if}

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

  /* Automation tab: the label + a mono n/N readout. The count is telemetry, not a status light:
     faint (nothing on) to plain ink, amber only while a review runs (DESIGN.md Four-Light Rule). */
  .auto-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    white-space: nowrap;
  }
  .auto-count {
    font-family: var(--font-mono);
    letter-spacing: 0;
    color: var(--color-faint);
  }
  .auto-count.on {
    color: var(--color-ink);
  }
  .auto-count.reviewing {
    color: var(--color-amber);
  }
  /* "new" discovery pip (accent blue). The animation lacks !important so the global
     reduced-motion blanket in app.css suppresses it. */
  .new-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-blue);
    flex-shrink: 0;
    animation: new-pip-pulse 2s ease-in-out infinite;
  }
  @keyframes new-pip-pulse {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* preview tab marker: the non-reserved blue accent ties it to the row badge */
  .tab-btn.preview-tab.active {
    border-color: var(--color-blue);
    color: var(--color-blue);
  }
</style>
