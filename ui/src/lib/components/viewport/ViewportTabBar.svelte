<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { dialog } from "$lib/a11yDialog";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { startPreview as apiStartPreview } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { Session } from "$lib/types";

  type Tab = "term" | "todo" | "activity" | "diff" | "files" | "preview";

  let {
    tab = $bindable(),
    session,
    previewPort,
    todoExists,
    hasFiles,
    hasPreview,
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
    compact: boolean;
    headerFolded: boolean;
    vpBodyId: string;
    tabId: (t: Tab) => string;
    foldRegionId: string;
  } = $props();

  // The `session` prop is re-resolved from the store whenever the sessions
  // state changes, so its reference can churn while the id stays put. Derive
  // the id: a $derived only notifies dependents when its *value* changes, so
  // effects keyed on it re-run on an actual unit switch — not on churn.
  const unitId = $derived(session.id);

  // ── start preview ──────────────────────────────────────────────────────────
  // Per-session "start in flight" guard: keyed by session id so it survives
  // navigating away and back. Cleared on port-bound, error, throw, or 60s timeout.
  // Single SvelteMap (from svelte/reactivity) doubles as the timer store AND the
  // reactive presence check — SvelteMap proxies .has()/.set()/.delete() so derived
  // values re-evaluate correctly (plain Set/Map would not).
  const previewStartPending = new SvelteMap<string, ReturnType<typeof setTimeout>>();
  // Teardown: clear all outstanding 60s guard timers so they can't fire after unmount.
  $effect(() => () => {
    for (const t of previewStartPending.values()) clearTimeout(t);
  });
  // Command-collection popover: shown when the server says it can't auto-detect.
  let previewCommandOpen = $state(false);
  let previewCommandDraft = $state("");
  // Ref for outside-click dismissal of the start-wrap (button + command popover).
  let previewStartWrapEl = $state<HTMLElement | null>(null);
  // Two-step confirm for working-agent start: first click arms, second confirms.
  let previewArmed = $state(false);
  let previewArmTimer: ReturnType<typeof setTimeout> | undefined;
  // Disarm + close popover on unit switch; clean up arm timer on unmount.
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    unitId;
    previewArmed = false;
    previewCommandOpen = false;
    clearTimeout(previewArmTimer);
  });
  $effect(() => () => clearTimeout(previewArmTimer));

  // Clear the pending flag for a session (port bound via WS event).
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    previewPort; // re-run whenever previewPort changes for this session
    if (previewPort != null && previewStartPending.has(unitId)) {
      clearPreviewPending(unitId);
    }
  });

  function setPreviewPending(id: string) {
    clearPreviewPending(id); // clear any stale timer first
    const t = setTimeout(() => clearPreviewPending(id), 60_000);
    previewStartPending.set(id, t);
  }

  function clearPreviewPending(id: string) {
    const t = previewStartPending.get(id);
    if (t !== undefined) clearTimeout(t);
    previewStartPending.delete(id);
  }

  const isPreviewStartPending = $derived(previewStartPending.has(unitId));

  async function handleStartPreview(command?: string) {
    let result;
    try {
      result = await apiStartPreview(session.id, command);
    } catch {
      clearPreviewPending(session.id);
      toasts.info(m.viewport_preview_start_failed(), {
        alert: true,
        key: `preview-start-fail-${session.id}`,
      });
      return;
    }

    if ("needCommand" in result) {
      // Server can't auto-detect: open the command input popover.
      // use:dialog handles focus-in via queueMicrotask on mount.
      previewCommandDraft = command ?? "";
      previewCommandOpen = true;
      return;
    }

    if ("alreadyBound" in result) {
      toasts.info(m.viewport_preview_already_bound());
      return;
    }

    if (result.mode === "local" && result.alreadyRunning) {
      toasts.info(m.viewport_preview_already_running());
      return;
    }

    // Process detection is dead/stale on this host (#1912): the start proceeded, but
    // the preview can never bind, so the pending guard would just expire silently.
    // Alert (pointing at Diagnose) and arm NO guard instead of a "started" toast.
    if (result.probesUnavailable) {
      toasts.info(m.viewport_preview_start_no_detection(), {
        alert: true,
        key: `preview-no-detection-${session.id}`,
      });
      return;
    }

    if (result.mode === "agent_setup") {
      setPreviewPending(session.id);
      toasts.info(m.viewport_preview_setup_sent({ name: session.name }));
      return;
    }

    // ok: local script started or directive sent. Set pending guard.
    setPreviewPending(session.id);
    toasts.info(
      result.mode === "local"
        ? m.viewport_preview_start_local({ name: session.name, command: result.command })
        : m.viewport_preview_start_sent({ name: session.name, command: result.command }),
    );
  }

  async function onStartPreviewClick() {
    if (isPreviewStartPending) return; // re-entrancy guard

    // Two-step confirm when the agent is actively working: first click arms the
    // button into a confirm state; second click (within 3s) proceeds. Mirrors
    // the decommission arm and GitRail merge arm patterns. Raw status by design
    // (gates an action, not a render) — see displayStatus for the display flag.
    if (session.status === "running") {
      if (!previewArmed) {
        previewArmed = true;
        clearTimeout(previewArmTimer);
        previewArmTimer = setTimeout(() => (previewArmed = false), 3000);
        return;
      }
      clearTimeout(previewArmTimer);
      previewArmed = false;
      // Re-check pending at the moment of the confirming click.
      if (isPreviewStartPending) return;
    }

    await handleStartPreview();
  }

  async function submitPreviewCommand() {
    const cmd = previewCommandDraft.trim();
    if (!cmd) return;
    previewCommandOpen = false;
    await handleStartPreview(cmd);
  }

  function onPreviewCommandKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submitPreviewCommand();
    }
    // Esc is handled by use:dialog (closes + restores focus to Start button).
  }

  // Outside-click dismiss for the command popover + arm state.
  function onWindowPointerdownPreview(e: PointerEvent) {
    if (!previewCommandOpen && !previewArmed) return;
    if (previewStartWrapEl && !previewStartWrapEl.contains(e.target as Node)) {
      previewCommandOpen = false;
      previewArmed = false;
      clearTimeout(previewArmTimer);
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerdownPreview} />

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
      class:active={tab === "activity"}
      role="tab"
      id={tabId("activity")}
      aria-selected={tab === "activity"}
      aria-controls={vpBodyId}
      use:coachTarget={"activity-tab"}
      onclick={() => (tab = "activity")}>{m.viewport_activity_tab()}</button
    >
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
  {:else if session && !session.archivedAt}
    <!-- no preview yet: offer operator-triggered start. Icon-only (▶, ▶? when
         armed) to keep the header slim — full label lives in title + aria.
         Anchored non-modal (no scrim) — dismiss on Esc + outside-click
         (svelte:window onpointerdown). -->
    <span class="preview-start-wrap" bind:this={previewStartWrapEl}>
      <button
        class="tab-btn preview-start-btn"
        class:armed={previewArmed}
        type="button"
        disabled={isPreviewStartPending}
        title={previewArmed
          ? m.viewport_preview_start_confirm_working()
          : `${m.viewport_preview_start()}\n${m.viewport_preview_start_note()}`}
        aria-label={previewArmed
          ? m.viewport_preview_start_confirm_working()
          : m.viewport_preview_start()}
        onclick={onStartPreviewClick}
        ><span aria-hidden="true">{previewArmed ? "▶?" : "▶"}</span></button
      >
      {#if previewCommandOpen}
        <span
          class="preview-cmd-pop"
          role="dialog"
          aria-label={m.viewport_preview_command_prompt()}
          use:dialog={{ onclose: () => (previewCommandOpen = false) }}
        >
          <span class="pcp-label">{m.viewport_preview_command_prompt()}</span>
          <input
            class="pcp-input"
            type="text"
            bind:value={previewCommandDraft}
            placeholder={m.viewport_preview_command_placeholder()}
            onkeydown={onPreviewCommandKey}
          />
          <button class="pcp-send gbtn" type="button" onclick={submitPreviewCommand}
            >{m.viewport_preview_command_send()}</button
          >
        </span>
      {/if}
    </span>
  {/if}
</div>

<style>
  .tab-group {
    display: flex;
    gap: 2px;
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
  /* keep the preview slot (Preview tab / Start control) pinned + always visible */
  .tab-group.mobile .preview-start-wrap,
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

  /* ── start-preview affordance ── */
  .preview-start-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .tab-btn.preview-start-btn {
    color: var(--color-blue);
    opacity: 0.85;
  }
  .tab-btn.preview-start-btn:hover:not(:disabled) {
    opacity: 1;
    color: var(--color-blue);
  }
  .tab-btn.preview-start-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* confirm-to-proceed cue — mirrors .decom.armed but with amber (non-destructive) */
  .tab-btn.preview-start-btn.armed {
    color: var(--color-amber);
    border-color: var(--color-amber);
    background: color-mix(in srgb, var(--color-amber) 12%, transparent);
  }
  /* anchored non-modal command-collection popover (no scrim) */
  .preview-cmd-pop {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    white-space: nowrap;
    min-width: 220px;
  }
  /* phone: the preview slot is pinned at the row's right edge, so a left:0
     popover would open rightward off-screen — flip it to right-anchored and
     width-cap it so it drops inside the (overflow:hidden) .viewport box instead
     of past the viewport edge. It lives in the pinned .preview-start-wrap, not
     the .tab-scroll scroller, so the strip's overflow-x:auto never clips it. */
  .tab-group.mobile .preview-cmd-pop {
    left: auto;
    right: 0;
    max-width: calc(100vw - 16px);
  }
  .pcp-label {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    letter-spacing: 0.04em;
  }
  .pcp-input {
    background: var(--color-bg);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 3px 7px;
    width: 100%;
    outline: none;
  }
  .pcp-input:focus {
    border-color: var(--color-blue);
  }
  .pcp-send {
    align-self: flex-end;
  }
</style>
