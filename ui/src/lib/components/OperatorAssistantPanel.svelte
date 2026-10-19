<script lang="ts">
  import type {
    AssistantPermissions,
    OperatorAssistantUnavailableReason,
    Session,
    TerminalClientInfo,
  } from "#lib/types.js";
  import type { Snippet } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { basename } from "#lib/basename.js";
  import { modelLabel } from "#lib/model-label.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { operatorAssistantExplanation } from "#lib/tooltips/explanations.js";
  import {
    assistantMode,
    assistantPanelView,
    type AssistantAction,
  } from "#lib/operator-assistant.svelte.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import type { AssistantViewReport, ViewTab } from "#lib/operator-assistant-view.js";
  import { viewFocus } from "#lib/assistant-chat.js";
  import AssistantChat from "./AssistantChat.svelte";
  import AssistantMark from "./AssistantMark.svelte";
  import Viewport from "./Viewport.svelte";

  // The Operator Assistant panel (#1446). Non-modal: docked beside the selected session on
  // desktop, a full-screen phone screen with Back. Never the `drawer` / `overlay` classes — the
  // page reads those as "a modal is open" and would stand its shortcuts down while it shows.
  // Its own warm card, so it reads as a companion beside the herd's terminals, not one more: the
  // conversation by default, the raw terminal one switch away. The terminal stays mounted (and
  // attached) under the conversation — every send rides its socket, view report included.
  // One panel per assistant: the global one, or a repo assistant (`repo`), which sees and acts on
  // that one repo and can be ended. In the dock's stack (`stacked`) the dock's strip owns Close.
  let {
    repo = null,
    stacked = false,
    switcher,
    onend,
    session,
    available,
    reason,
    pending,
    failed,
    mobile = false,
    touch = false,
    connected = true,
    attended = true,
    terminalOwners = null,
    workingBlocked = {},
    backgroundBusy = {},
    herd = [],
    typeRequest = null,
    ontyped,
    viewReport = null,
    onnavigate,
    consumeAutoFocusTerm,
    onretry,
    onresume,
    onreset,
    onclose,
    ondiagnose,
    permissions = null,
    onpermissions,
  }: {
    /** A repo assistant's repo; null = the global assistant. */
    repo?: string | null;
    /** Shown in the dock's stack: the strip above closes the dock, so no Close here. */
    stacked?: boolean;
    /** Phone: the dock's tabs, under the title row. */
    switcher?: Snippet;
    /** End this repo assistant (confirmed): archive it. Repo assistants only. */
    onend?: () => void;
    /** The assistant's live row (store.assistant); null until one is spawned. */
    session: Session | null;
    /** store.assistantAvailable: null until the bootstrap GET lands. */
    available: boolean | null;
    reason: OperatorAssistantUnavailableReason | null;
    /** The ensure / reset in flight, and the one that last failed (AssistantLifecycle). */
    pending: AssistantAction | null;
    failed: AssistantAction | null;
    mobile?: boolean;
    touch?: boolean;
    connected?: boolean;
    /** Window visible and focused: unattended, the live terminal paces its output (#3035). */
    attended?: boolean;
    terminalOwners?: Record<string, TerminalClientInfo> | null;
    workingBlocked?: Record<string, boolean>;
    backgroundBusy?: Record<string, boolean>;
    /** Live herd sessions (store.sessions): their desigs link in the assistant's terminal. */
    herd?: Session[];
    /** An "Ask the assistant" prefill, typed (not sent) once the terminal attaches. */
    typeRequest?: { text: string; tick: number } | null;
    ontyped?: (tick: number) => void;
    /** The operator's current view (#3161), handed to the assistant with each message. */
    viewReport?: AssistantViewReport | null;
    /** A desig link in the terminal was activated: select that session. */
    onnavigate?: (id: string) => void;
    /** One-shot: whether the terminal may take the keyboard when it mounts. */
    consumeAutoFocusTerm?: () => boolean;
    /** Re-run the request that failed (or re-check availability). */
    onretry: () => void;
    /** The terminal's Resume: bring the assistant back (ensure), not a per-session resume. */
    onresume: () => Promise<void>;
    /** New conversation, confirmed: archive this assistant and spawn a fresh one. */
    onreset: () => void;
    /** Close (desktop) or Back (phone). */
    onclose: () => void;
    /** Open Settings at its Diagnose section. */
    ondiagnose: () => void;
    /** What the operator lets the assistant do (store.assistantPermissions); null until known. */
    permissions?: AssistantPermissions | null;
    /** Open Settings at its Assistant section (the mode chip). */
    onpermissions?: () => void;
  } = $props();

  const view = $derived(assistantPanelView({ session, available, pending, failed }));
  const model = $derived(session?.model ? modelLabel(session.model) : null);
  const mode = $derived(permissions ? assistantMode(permissions) : null);
  const MODE_LABEL = {
    readonly: m.operator_assistant_readonly,
    asks: m.operator_assistant_mode_asks,
    acts: m.operator_assistant_mode_acts,
  };

  const UNAVAILABLE: Record<OperatorAssistantUnavailableReason, () => string> = {
    claude_missing: m.operator_assistant_unavailable_claude_missing,
    herdr_unreachable: m.operator_assistant_unavailable_herdr_unreachable,
  };
  // No reason: the node itself is fine but this Shepherd can't run agents at all (the demo).
  const unavailableText = $derived(
    reason ? UNAVAILABLE[reason]() : m.operator_assistant_unavailable_generic(),
  );
  const ERROR_TEXT = {
    ensure: m.operator_assistant_error_ensure,
    reset: m.operator_assistant_error_reset,
    close: m.operator_assistant_error_close,
  };
  const errorText = $derived(ERROR_TEXT[failed ?? "ensure"]());
  const title = $derived(repo ? basename(repo) : m.operator_assistant_title());
  // A repo assistant names its kind; in the stack the global one names its reach, so the two read
  // apart at a glance.
  const scopeText = $derived(
    repo ? m.operator_assistant_repo_kind() : stacked ? m.assistant_dock_all_repos() : null,
  );

  // Two-step arm → confirm for New conversation, like the card menu's armed actions: the first
  // click arms (the label asks), a second within the window archives this conversation. It
  // disarms on its own after the window, and when the conversation goes away under it.
  const RESET_ARM_MS = 3000;
  let resetArmed = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  function disarmReset() {
    resetArmed = false;
    clearTimeout(resetTimer);
  }
  function onResetClick() {
    if (resetArmed) {
      disarmReset();
      onreset();
      return;
    }
    resetArmed = true;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => (resetArmed = false), RESET_ARM_MS);
  }
  $effect(() => {
    if (view !== "live") disarmReset();
  });
  $effect(() => () => clearTimeout(resetTimer));

  // End (repo assistants): the same arm → confirm, so one stray click never archives it.
  let endArmed = $state(false);
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  function onEndClick() {
    if (endArmed) {
      endArmed = false;
      clearTimeout(endTimer);
      onend?.();
      return;
    }
    endArmed = true;
    clearTimeout(endTimer);
    endTimer = setTimeout(() => (endArmed = false), RESET_ARM_MS);
  }
  $effect(() => () => clearTimeout(endTimer));

  // Conversation or terminal: the operator's last pick, per device.
  const VIEW_KEY = "shepherd:operator-assistant-view";
  type PanelView = "chat" | "term";
  function readView(): PanelView {
    try {
      return localStorage.getItem(VIEW_KEY) === "term" ? "term" : "chat";
    } catch {
      return "chat";
    }
  }
  let shown = $state<PanelView>(readView());
  function show(next: PanelView) {
    shown = next;
    try {
      if (next === "term") localStorage.setItem(VIEW_KEY, "term");
      else localStorage.removeItem(VIEW_KEY);
    } catch {
      // ignore: best-effort local preference
    }
    // Follow the switch with the keyboard; on touch that would pop the soft keyboard instead.
    if (!mobile && !touch) queueMicrotask(focusTerminal);
  }

  // What the assistant would be told the operator is looking at, were they to send now.
  const TAB_LABEL: Record<ViewTab, () => string> = {
    term: m.viewport_terminal_tab,
    todo: m.viewport_todo_tab,
    activity: m.viewport_activity_tab,
    diff: m.viewport_diff_tab,
    files: m.viewport_files_tab,
    preview: m.viewport_preview_tab,
    browser: m.viewport_browser_tab,
  };
  const seen = $derived(viewFocus(viewReport, herd));
  const seesText = $derived(
    seen
      ? m.operator_assistant_sees({
          what: [seen.desig, seen.host, seen.tab && TAB_LABEL[seen.tab]()]
            .filter(Boolean)
            .join(" · "),
        })
      : m.operator_assistant_sees_nothing(),
  );

  let viewport: Viewport | undefined = $state();
  let chat: AssistantChat | undefined = $state();
  /** Hand the keyboard to the assistant (the panel was asked to open while open): the composer in
   *  the conversation, else the terminal. */
  export function focusTerminal() {
    if (shown === "chat") chat?.focus();
    else viewport?.focusTerminal();
  }
</script>

<aside
  class="oap"
  class:phone={mobile}
  aria-label={repo ? m.operator_assistant_repo_aria({ repo: title }) : m.operator_assistant_title()}
>
  <header class="oap-head">
    <div class="oap-row">
      {#if mobile}
        <button
          type="button"
          class="icon-btn oap-btn oap-back"
          aria-label={m.operator_assistant_back()}
          onclick={onclose}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg
          >
        </button>
      {/if}
      <AssistantMark {repo} />
      <div class="oap-heading">
        <h2 class="oap-title">{title}</h2>
        {#if viewReport || scopeText}
          <span class="oap-sees"
            >{[scopeText, viewReport ? seesText : null].filter(Boolean).join(" · ")}</span
          >
        {/if}
      </div>
      <!-- New conversation: a glyph at rest; armed, it spells out the question it asks. -->
      <button
        type="button"
        class="icon-btn oap-btn oap-arm"
        class:armed={resetArmed}
        disabled={view !== "live"}
        aria-label={resetArmed ? m.operator_assistant_new_confirm() : m.operator_assistant_new()}
        title={resetArmed ? undefined : m.operator_assistant_new()}
        onclick={onResetClick}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg
        >
        {#if resetArmed}<span>{m.operator_assistant_new_confirm()}</span>{/if}
      </button>
      {#if repo && onend}
        <!-- End: a stop square at rest; armed, it asks. Only a repo assistant can be ended. -->
        <button
          type="button"
          class="icon-btn oap-btn oap-arm"
          class:armed={endArmed}
          disabled={pending !== null}
          aria-label={endArmed ? m.operator_assistant_end_confirm() : m.operator_assistant_end()}
          title={endArmed ? undefined : m.operator_assistant_end()}
          onclick={onEndClick}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
            aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5" /></svg
          >
          {#if endArmed}<span>{m.operator_assistant_end_confirm()}</span>{/if}
        </button>
      {/if}
      {#if !mobile && !stacked}
        <button
          type="button"
          class="icon-btn oap-btn oap-close"
          aria-label={m.operator_assistant_close()}
          onclick={onclose}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg
          >
        </button>
      {/if}
    </div>
    {#if switcher}{@render switcher()}{/if}
    <div class="oap-row oap-meta">
      <!-- The mode chip: what Settings → Assistant lets it do; a click opens that section. Absent
           until the permissions are known (bootstrap, or an older server). -->
      {#if mode}
        <button
          type="button"
          class="badge oap-mode"
          class:acts={mode === "acts"}
          use:statusTip={{
            text: operatorAssistantExplanation(permissions, true),
            stopClickPropagation: false,
            pinOnClick: false,
          }}
          use:coachTarget={"assistant-permissions"}
          onclick={() => onpermissions?.()}
        >
          {MODE_LABEL[mode]()}
        </button>
      {/if}
      {#if model}<span class="badge">{model}</span>{/if}
      {#if repo}<span class="badge oap-scope"
          >{m.operator_assistant_scope_badge({ repo: title })}</span
        >{/if}
      {#if view === "live"}
        <div class="oap-switch" role="group" aria-label={m.operator_assistant_view_aria()}>
          <button type="button" aria-pressed={shown === "chat"} onclick={() => show("chat")}
            >{m.operator_assistant_view_chat()}</button
          >
          <button type="button" aria-pressed={shown === "term"} onclick={() => show("term")}
            >{m.viewport_terminal_tab()}</button
          >
        </div>
      {/if}
    </div>
  </header>

  {#if view === "live" && session}
    <!-- Both stay mounted, stacked: the hidden one keeps its scroll, draft and live socket. -->
    <div class="oap-body">
      <div class="oap-pane" class:off={shown !== "chat"} inert={shown !== "chat"}>
        <AssistantChat
          bind:this={chat}
          sessionId={session.id}
          status={session.status}
          {mobile}
          {touch}
          prefill={shown === "chat" ? typeRequest : null}
          onprefilled={ontyped}
          consumeAutoFocus={shown === "chat" ? consumeAutoFocusTerm : undefined}
          onsend={(text) => viewport?.sendLine(text) ?? false}
          oninterrupt={() => viewport?.sendInterrupt()}
          onterminal={() => show("term")}
        />
      </div>
      <div class="oap-pane oap-term" class:off={shown !== "term"} inert={shown !== "term"}>
        <!-- Hidden, it never takes the keyboard and paces its output like an unattended window. -->
        <Viewport
          bind:this={viewport}
          variant="assistant"
          {session}
          {mobile}
          {touch}
          {connected}
          attended={attended && shown === "term"}
          {terminalOwners}
          {workingBlocked}
          {backgroundBusy}
          {herd}
          typeRequest={shown === "term" ? typeRequest : null}
          {viewReport}
          {ontyped}
          {onnavigate}
          consumeAutoFocusTerm={shown === "term" ? consumeAutoFocusTerm : () => false}
          {onresume}
        />
      </div>
    </div>
  {:else if view === "unavailable"}
    <div class="oap-state" role="status">
      <p class="oap-state-title">{m.operator_assistant_unavailable_title()}</p>
      <p>{unavailableText}</p>
      <p class="oap-hint">{m.operator_assistant_unavailable_hint()}</p>
      <div class="oap-actions">
        <button type="button" class="gbtn primary" onclick={ondiagnose}
          >{m.operator_assistant_open_diagnose()}</button
        >
        {#if reason}
          <button type="button" class="gbtn" disabled={pending !== null} onclick={onretry}
            >{m.operator_assistant_check_again()}</button
          >
        {/if}
      </div>
    </div>
  {:else if view === "error"}
    <div class="oap-state" role="alert">
      <p class="oap-state-title">{errorText}</p>
      <div class="oap-actions">
        <button type="button" class="gbtn primary" onclick={onretry}>{m.common_retry()}</button>
      </div>
    </div>
  {:else}
    <div class="oap-state" role="status">
      <p class="oap-hint">{m.operator_assistant_spawning()}</p>
    </div>
  {/if}
</aside>

<style>
  /* Flex column in both homes: the desktop grid's third track (stretched to the row) and the
     phone's main region (flex: 1 fills the screen under the hidden chrome). On desktop it is its
     own warm card — the frame that tells it apart from the session console beside it. */
  .oap {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--wash-assistant);
    border: 1px solid var(--wash-assistant-edge);
    border-radius: var(--radius-chip);
    box-shadow: var(--shadow-popover);
  }
  .oap-head {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--color-line);
  }
  .oap-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .oap-meta {
    flex-wrap: wrap;
    row-gap: 6px;
  }
  .oap-heading {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .oap-title,
  .oap-sees {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .oap-title {
    margin: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
  }
  .oap-sees {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .oap-btn {
    color: var(--color-muted);
  }
  .oap-close {
    margin-right: -4px;
  }
  .oap-arm.armed {
    width: auto;
    gap: 6px;
    padding: 0 8px;
    border-color: var(--color-amber);
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    white-space: nowrap;
  }
  /* Conversation | Terminal: a segmented switch, the pressed half lifted off the card. */
  .oap-switch {
    margin-left: auto;
    display: flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-chip);
  }
  .oap-switch button {
    padding: 3px 10px;
    border: 0;
    border-radius: 2px;
    background: none;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .oap-switch button:hover {
    color: var(--color-ink);
  }
  .oap-switch button[aria-pressed="true"] {
    background: var(--wash-assistant-bubble);
    color: var(--color-ink-bright);
  }
  .oap-switch button:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* Inline Badge recipe (/design-system): the 2px micro-label. */
  .badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    white-space: nowrap;
  }
  .oap-mode {
    background: none;
    font-family: inherit;
    line-height: inherit;
    cursor: pointer;
  }
  .oap-mode:hover,
  .oap-mode:focus-visible {
    border-color: var(--color-muted);
    color: var(--color-ink);
  }
  /* A repo assistant's reach: brighter than the info badges, it changes what it can see. */
  .oap-scope {
    border-color: var(--color-line-bright);
    color: var(--color-ink);
  }
  /* Something runs without asking: worth noticing, not alarming. */
  .oap-mode.acts {
    color: var(--color-amber);
  }
  /* Button recipe (/design-system .gbtn). */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 10px;
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
    border-color: var(--color-amber);
    color: var(--color-amber);
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  /* The conversation and the terminal share one cell; the one not shown keeps its layout (the
     terminal stays fitted, so switching back never reflows the agent's screen). */
  .oap-body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  }
  .oap-pane {
    grid-area: 1 / 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .oap-pane.off {
    visibility: hidden;
    pointer-events: none;
  }
  /* The card is the frame: the terminal drops its own. */
  .oap .oap-term :global(.viewport) {
    border: 0;
    border-radius: 0;
  }
  .oap-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 18px 14px;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.45;
  }
  .oap-state p {
    margin: 0;
  }
  .oap-state-title {
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .oap-hint {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .oap-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 4px;
  }

  /* Phone: the whole screen is the assistant — full-bleed, no card chrome (the terminal's own
     bleed would double it), thumb-sized controls. */
  .oap.phone {
    margin-inline: calc(-1 * var(--mobile-shell-pad));
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .oap.phone .oap-term :global(.viewport.phone) {
    margin-inline: 0;
  }
  .oap.phone .oap-btn {
    width: 44px;
    height: 44px;
  }
  .oap.phone .oap-back {
    margin-left: -10px;
  }
  .oap.phone .oap-arm.armed {
    width: auto;
  }
  .oap.phone .gbtn,
  .oap.phone .oap-switch button {
    min-height: 44px;
  }
</style>
