<script lang="ts">
  import type { BacklogProject, DocAgentRun } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import type { ActionsTabState } from "../backlog-view";
  import DocAgentControl from "./DocAgentControl.svelte";

  type Tab = "issues" | "prs" | "actions" | "readiness" | "automation";

  // The Issues/PRs/Actions/Readiness/Automation tab strip + Fast-forward button,
  // shared by BacklogView's desktop split and mobile overlay (#855). `variant`
  // only swaps the wrapper class (the desktop `.tab-bar` vs the horizontally-
  // scrolling mobile `.overlay-tabs`); the buttons are identical.
  let {
    variant,
    activeTab,
    selected = null,
    actionsState,
    ffInFlight,
    selectedPath,
    docAgentEnabled = false,
    docAgentAct = false,
    docAgentRunning = false,
    docAgentRuns = [],
    onselecttab,
    onff,
    ondocagent = () => {},
  }: {
    variant: "desktop" | "mobile";
    activeTab: Tab;
    selected?: BacklogProject | null;
    actionsState: ActionsTabState;
    ffInFlight: boolean;
    selectedPath: string | null;
    docAgentEnabled?: boolean;
    docAgentAct?: boolean;
    docAgentRunning?: boolean;
    docAgentRuns?: DocAgentRun[];
    onselecttab: (tab: Tab) => void;
    onff: () => void;
    ondocagent?: () => void;
  } = $props();

  // coachTarget only on the desktop variant — preserves the pre-split behavior
  // where only the desktop tab bar carried the backlog coachmark anchors. The
  // guard returns the real action when an id is given, else a no-op. variant is
  // fixed per instance (mobile/desktop are separate {#if} branches that mount
  // distinct instances), so the id never flips at runtime.
  function coachMaybe(node: HTMLElement, id: string | undefined) {
    return id ? coachTarget(node, id) : undefined;
  }
</script>

<div class={variant === "mobile" ? "overlay-tabs" : "tab-bar"}>
  <button
    class="tab-btn"
    class:active={activeTab === "issues"}
    type="button"
    onclick={() => onselecttab("issues")}
  >
    {selected && selected.openIssues !== null
      ? m.backlog_tab_issues_count({ count: selected.openIssues })
      : m.backlog_tab_issues()}
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "prs"}
    type="button"
    onclick={() => onselecttab("prs")}
  >
    {selected && selected.openPRs !== null
      ? m.backlog_tab_prs_count({ count: selected.openPRs })
      : m.backlog_tab_prs()}
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "actions"}
    class:failing={actionsState.kind === "failing"}
    type="button"
    onclick={() => onselecttab("actions")}
  >
    {#if actionsState.kind === "failing"}
      {m.backlog_tab_actions_failing()}
    {:else if actionsState.kind === "count"}
      {m.backlog_tab_actions_count({ count: actionsState.count })}
    {:else}
      {m.backlog_tab_actions()}
    {/if}
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "readiness"}
    type="button"
    onclick={() => onselecttab("readiness")}
  >
    {m.backlog_tab_readiness()}
  </button>
  <button
    class="tab-btn"
    class:active={activeTab === "automation"}
    type="button"
    onclick={() => onselecttab("automation")}
    use:coachMaybe={variant === "desktop" ? "backlog-automation" : undefined}
  >
    {m.backlog_tab_automation()}
  </button>
  {#if docAgentEnabled}
    <!-- Doc-agent control + FF button in a right-aligned cluster -->
    <div class="action-cluster">
      <DocAgentControl
        act={docAgentAct}
        running={docAgentRunning}
        runs={docAgentRuns}
        disabled={selectedPath === null}
        coach={variant === "desktop"}
        ontrigger={ondocagent}
      />
      <button
        class="gbtn ff-btn"
        type="button"
        disabled={ffInFlight || selectedPath === null}
        onclick={onff}
        title={m.backlog_ff_main_title()}
        aria-label={m.backlog_ff_main_title()}
        use:coachMaybe={variant === "desktop" ? "backlog-ff-main" : undefined}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M1 2.5L5.5 6 1 9.5V2.5Z" fill="currentColor" />
          <path d="M6.5 2.5L11 6 6.5 9.5V2.5Z" fill="currentColor" />
        </svg>
        {m.backlog_ff_main()}
      </button>
    </div>
  {:else}
    <button
      class="gbtn ff-btn ff-btn-solo"
      type="button"
      disabled={ffInFlight || selectedPath === null}
      onclick={onff}
      title={m.backlog_ff_main_title()}
      aria-label={m.backlog_ff_main_title()}
      use:coachMaybe={variant === "desktop" ? "backlog-ff-main" : undefined}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M1 2.5L5.5 6 1 9.5V2.5Z" fill="currentColor" />
        <path d="M6.5 2.5L11 6 6.5 9.5V2.5Z" fill="currentColor" />
      </svg>
      {m.backlog_ff_main()}
    </button>
  {/if}
</div>

<style>
  /* ── tab bar (desktop) ── */
  .tab-bar {
    display: flex;
    gap: 2px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-head);
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

  .tab-btn.failing {
    color: var(--color-red);
    border-color: color-mix(in srgb, var(--color-red) 45%, transparent);
  }

  .tab-btn.failing.active {
    color: var(--color-red);
    border-color: var(--color-red);
    background: var(--color-inset);
  }

  /* ── fast-forward button ── */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* keyboard focus — flat inset amber ring (never an outer glow), per design-system */
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ff-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    white-space: nowrap;
  }

  /* Standalone ff-btn (no doc-agent) claims the auto margin itself. */
  .ff-btn-solo {
    margin-left: auto;
  }

  /* When doc-agent is enabled, cluster owns margin-left:auto so both controls push right. */
  .action-cluster {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  /* ── tab strip (mobile overlay) ──
     Sits after the fixed close button and scrolls horizontally when tabs exceed
     the available width. Scrollbar is hidden (matches ControlBar convention). */
  .overlay-tabs {
    display: flex;
    gap: 2px;
    flex: 1 1 0;
    min-width: 0;
    overflow-x: auto;
    white-space: nowrap;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .overlay-tabs::-webkit-scrollbar {
    display: none;
  }

  .overlay-tabs .tab-btn {
    min-height: 40px;
    padding: 0 12px;
    touch-action: manipulation;
    flex-shrink: 0;
  }
</style>
