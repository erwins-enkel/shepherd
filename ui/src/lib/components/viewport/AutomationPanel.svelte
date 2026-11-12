<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { Session } from "#lib/types.js";
  import { repoSettingsWindow } from "#lib/repo-settings-window.svelte.js";
  import RepoSettingsBody from "../repo-settings/RepoSettingsBody.svelte";

  // The session's Automation tab: this task's autopilot override on top, the repo's full
  // settings (the same body as the repo settings window) below it, filling the rest. The override
  // is the body's lead, so a narrow tab scrolls it away with the rest.
  let {
    session,
    autopilotOn,
    ontoggleautopilot,
  }: {
    session: Session;
    /** Effective autopilot: the session override, else the repo default. */
    autopilotOn: boolean;
    /** Flips the session override to the opposite of `autopilotOn` (Viewport owns the call). */
    ontoggleautopilot: () => void;
  } = $props();

  const repoPath = $derived(session.repoPath);
</script>

<!-- the autopilot row leads the repo body: on a phone it scrolls away with the repo's head -->
{#snippet autopilotRow()}
  <div class="ap-row">
    <div class="ap-text">
      <span class="ap-title">{m.automation_session_autopilot_title()}</span>
      <span class="ap-hint">{m.automation_session_autopilot_hint()}</span>
    </div>
    <button
      class={["gbtn", "ap-toggle", { on: autopilotOn }]}
      type="button"
      aria-pressed={autopilotOn}
      aria-label={m.session_autopilot_toggle_aria()}
      onclick={ontoggleautopilot}
    >
      {autopilotOn ? m.session_autopilot_on_label() : m.session_autopilot_off_label()}
    </button>
  </div>
{/snippet}

<div class="automation">
  {#key repoPath}
    <RepoSettingsBody
      variant="tab"
      {repoPath}
      sessionId={session.id}
      planPhase={session.planPhase}
      drain={repoSettingsWindow.drainFor(repoPath)}
      globals={repoSettingsWindow.globals()}
      onsetupci={() => repoSettingsWindow.setupCi(repoPath)}
      lead={autopilotRow}
    />
  {/key}
</div>

<style>
  .automation {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--color-bg);
  }
  .ap-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px 10px 16px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-head);
    flex-shrink: 0;
  }
  .ap-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .ap-title {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  .ap-hint {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  /* .gbtn recipe (/design-system) */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-chip);
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 3px 9px;
    white-space: nowrap;
    cursor: pointer;
    flex-shrink: 0;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* ON is an active mode, not a completion: amber per the active-toolbar convention
     (DESIGN.md); green stays reserved for ready-to-merge */
  .ap-toggle.on {
    color: var(--color-amber);
    border-color: color-mix(in srgb, var(--color-amber) 55%, transparent);
  }
  @media (pointer: coarse) {
    .ap-toggle {
      min-height: var(--mobile-actionbar-hit);
      padding: 6px 12px;
      font-size: var(--fs-base);
    }
  }
</style>
