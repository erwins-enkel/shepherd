<script lang="ts" module>
  import { SvelteMap } from "svelte/reactivity";

  // Per-session "start in flight" guard: keyed by session id and module-scoped so it
  // survives navigating away and back AND the remount when the header flips between
  // the compact tab-row slot and the desktop actions slot. Cleared on port-bound
  // (by ViewportTabBar — this component unmounts once a port binds), error, throw,
  // or 60s timeout. Single SvelteMap doubles as the timer store AND the
  // reactive presence check (plain Set/Map would not re-evaluate deriveds). No
  // per-instance unmount teardown: a cleared timer would strand its entry and keep ▶
  // disabled forever — each timer always runs to expiry and deletes its own entry.
  const previewStartPending = new SvelteMap<string, ReturnType<typeof setTimeout>>();

  function setPreviewPending(id: string) {
    clearPreviewPending(id); // clear any stale timer first
    const t = setTimeout(() => clearPreviewPending(id), 60_000);
    previewStartPending.set(id, t);
  }

  export function clearPreviewPending(id: string) {
    const t = previewStartPending.get(id);
    if (t !== undefined) clearTimeout(t);
    previewStartPending.delete(id);
  }
</script>

<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { startPreview as apiStartPreview } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import type { Session } from "#lib/types.js";

  let {
    session,
    variant,
  }: {
    session: Session;
    /** "tab": compact tab-row slot (tab-btn look); "icon": desktop actions cluster. */
    variant: "tab" | "icon";
  } = $props();

  // The `session` prop is re-resolved from the store whenever the sessions
  // state changes, so its reference can churn while the id stays put. Derive
  // the id: a $derived only notifies dependents when its *value* changes, so
  // effects keyed on it re-run on an actual unit switch — not on churn.
  const unitId = $derived(session.id);

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

<!-- operator-triggered dev-server start. Icon-only (▶, ▶? when armed) to keep the
     header slim — full label lives in title + aria. Anchored non-modal (no scrim) —
     dismiss on Esc + outside-click (svelte:window onpointerdown). -->
<span class="preview-start-wrap" bind:this={previewStartWrapEl}>
  <button
    class="preview-start-btn"
    class:tab-btn={variant === "tab"}
    class:icon-btn={variant === "icon"}
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

<style>
  .preview-start-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  /* compact tab-row form: mirrors ViewportTabBar's .tab-btn (separate component →
     scoped styles don't cross, so the tab look is restated here) */
  .tab-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    padding: 10px 6px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }
  /* full-strength blue at rest: the old 0.85 opacity dropped it to 4.47:1 (<AA) */
  .preview-start-btn {
    color: var(--color-blue);
    font-family: var(--font-mono);
  }
  .preview-start-btn:hover:not(:disabled) {
    color: var(--color-blue);
    border-color: color-mix(in srgb, var(--color-blue) 45%, transparent);
  }
  .preview-start-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* confirm-to-proceed cue — mirrors .decom.armed but with amber (non-destructive) */
  .preview-start-btn.armed {
    color: var(--color-amber);
    border-color: var(--color-amber);
    background: color-mix(in srgb, var(--color-amber) 12%, transparent);
  }
  /* anchored non-modal command-collection popover (no scrim). Right-anchored in
     both slots: the compact tab-row slot is pinned at the row's right edge and the
     desktop actions slot sits near the header's right edge, so a left:0 popover
     would open off-screen. Width-capped so it drops inside the (overflow:hidden)
     .viewport box instead of past the viewport edge. */
  .preview-cmd-pop {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
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
