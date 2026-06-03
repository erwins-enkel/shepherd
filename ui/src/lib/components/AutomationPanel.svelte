<script lang="ts">
  import { untrack } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { reviews, repoConfig } from "$lib/reviews.svelte";
  import { clampCap, clampCeiling, sanitizeLabel } from "./git-rail-drain";

  let { repoPath, sessionId }: { repoPath: string; sessionId: string } = $props();

  const criticOn = $derived(repoConfig.isEnabled(repoPath));
  const autoAddressOn = $derived(repoConfig.isAutoAddressEnabled(repoPath));
  const learningsOn = $derived(repoConfig.learningsOn(repoPath));
  const autopilotOn = $derived(repoConfig.isAutopilotEnabled(repoPath));
  const autoDrainOn = $derived(repoConfig.isAutoDrainEnabled(repoPath));
  const reviewing = $derived(reviews.isReviewing(sessionId));

  // Drain config fields, seeded from stored config and re-seeded whenever the
  // section becomes visible (drain turned on) or the repo changes.
  // svelte-ignore state_referenced_locally
  let drainCap = $state(repoConfig.maxAutoFor(repoPath));
  // svelte-ignore state_referenced_locally
  let drainLabel = $state(repoConfig.autoLabelFor(repoPath));
  // svelte-ignore state_referenced_locally
  let drainCeiling = $state(repoConfig.usageCeilingFor(repoPath));
  $effect(() => {
    // Re-seed the inputs when the repo changes or the drain section (re)appears.
    // untrack the store reads so committing a field (which writes back to the
    // store) never retriggers this effect and clobbers an in-flight edit.
    const repo = repoPath;
    if (!autoDrainOn) return;
    untrack(() => {
      drainCap = repoConfig.maxAutoFor(repo);
      drainLabel = repoConfig.autoLabelFor(repo);
      drainCeiling = repoConfig.usageCeilingFor(repo);
    });
  });

  async function commitDrainCap() {
    const n = clampCap(drainCap);
    drainCap = n;
    await repoConfig.setMaxAuto(repoPath, n);
    drainCap = repoConfig.maxAutoFor(repoPath);
  }
  async function commitDrainLabel() {
    const t = sanitizeLabel(drainLabel);
    if (t === null) {
      drainLabel = repoConfig.autoLabelFor(repoPath);
      return;
    }
    drainLabel = t;
    await repoConfig.setAutoLabel(repoPath, t);
    drainLabel = repoConfig.autoLabelFor(repoPath);
  }
  async function commitDrainCeiling() {
    const n = clampCeiling(drainCeiling);
    drainCeiling = n;
    await repoConfig.setUsageCeiling(repoPath, n);
    drainCeiling = repoConfig.usageCeilingFor(repoPath);
  }
</script>

<div class="auto-pop" role="dialog" aria-label={m.automation_panel_title()}>
  <div class="auto-head">{m.automation_panel_title()}</div>

  <!-- Code review -->
  <div class="auto-group">{m.automation_group_review()}</div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">🔍 {m.automation_critic_name()}</div>
      <div class="auto-desc">{m.automation_critic_desc()}</div>
    </div>
    <button
      class={["sw", { on: criticOn, reviewing }]}
      type="button"
      role="switch"
      aria-checked={criticOn}
      aria-busy={reviewing}
      aria-label={m.automation_critic_name()}
      onclick={() => repoConfig.toggle(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  <div class={["auto-row", { disabled: !criticOn }]}>
    <div class="auto-meta">
      <div class="auto-name">🤖 {m.automation_autoaddress_name()}</div>
      <div class="auto-desc">
        {criticOn ? m.automation_autoaddress_desc() : m.automation_autoaddress_needs_critic()}
      </div>
    </div>
    <button
      class={["sw", { on: autoAddressOn && criticOn }]}
      type="button"
      role="switch"
      aria-checked={autoAddressOn && criticOn}
      disabled={!criticOn}
      aria-label={m.automation_autoaddress_name()}
      onclick={() => repoConfig.toggleAutoAddress(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>

  <!-- Agent behavior -->
  <div class="auto-group">{m.automation_group_behavior()}</div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">🎓 {m.automation_learnings_name()}</div>
      <div class="auto-desc">{m.automation_learnings_desc()}</div>
    </div>
    <button
      class={["sw", { on: learningsOn }]}
      type="button"
      role="switch"
      aria-checked={learningsOn}
      aria-label={m.automation_learnings_name()}
      onclick={() => repoConfig.toggleLearnings(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">🛫 {m.automation_autopilot_name()}</div>
      <div class="auto-desc">{m.automation_autopilot_desc()}</div>
    </div>
    <button
      class={["sw", { on: autopilotOn }]}
      type="button"
      role="switch"
      aria-checked={autopilotOn}
      aria-label={m.automation_autopilot_name()}
      onclick={() => repoConfig.toggleAutopilot(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>

  <!-- Work queue -->
  <div class="auto-group">{m.automation_group_queue()}</div>
  <div class="auto-row">
    <div class="auto-meta">
      <div class="auto-name">🚰 {m.automation_autodrain_name()}</div>
      <div class="auto-desc">{m.automation_autodrain_desc()}</div>
    </div>
    <button
      class={["sw", { on: autoDrainOn }]}
      type="button"
      role="switch"
      aria-checked={autoDrainOn}
      aria-label={m.automation_autodrain_name()}
      onclick={() => repoConfig.toggleAutoDrain(repoPath)}
    >
      <span class="knob"></span>
    </button>
  </div>
  {#if autoDrainOn}
    <div class="drain-fields">
      <label class="drain-field">
        <span class="drain-label">{m.drain_cap_label()}</span>
        <input
          class="num"
          type="number"
          min="1"
          max="20"
          bind:value={drainCap}
          aria-label={m.drain_cap_label()}
          onchange={commitDrainCap}
        />
      </label>
      <label class="drain-field">
        <span class="drain-label">{m.drain_label_label()}</span>
        <input
          class="num"
          type="text"
          bind:value={drainLabel}
          aria-label={m.drain_label_label()}
          onchange={commitDrainLabel}
          onblur={commitDrainLabel}
        />
      </label>
      <label class="drain-field">
        <span class="drain-label">{m.drain_ceiling_label()}</span>
        <input
          class="num"
          type="number"
          min="0"
          max="100"
          bind:value={drainCeiling}
          aria-label={m.drain_ceiling_label()}
          onchange={commitDrainCeiling}
        />
      </label>
    </div>
  {/if}
</div>

<style>
  /* anchored by the parent's positioning context (GitRail's .git-rail-wrap is
     position: relative); this component must be mounted inside such a wrapper */
  .auto-pop {
    position: absolute;
    top: 100%;
    right: 8px;
    z-index: 20;
    margin-top: 4px;
    width: 320px;
    max-width: 90vw;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    color: var(--color-ink);
    overflow: hidden;
  }
  .auto-head {
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    padding: 10px 12px 4px;
  }
  .auto-group {
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-amber);
    padding: 8px 12px 4px;
  }
  .auto-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--color-line);
  }
  .auto-row.disabled {
    opacity: 0.45;
  }
  .auto-meta {
    min-width: 0;
  }
  .auto-name {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--color-ink-bright);
  }
  .auto-desc {
    font-size: 11px;
    color: var(--color-muted);
    margin-top: 2px;
  }
  /* switch: track + knob, green when on, amber pulse while reviewing */
  .sw {
    flex: 0 0 auto;
    margin-top: 2px;
    width: 30px;
    height: 17px;
    border-radius: 9px;
    border: 1px solid var(--color-line);
    background: var(--color-faint);
    position: relative;
    cursor: pointer;
    padding: 0;
    transition: background 0.12s;
  }
  .sw:disabled {
    cursor: not-allowed;
  }
  .sw .knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--color-slate);
    transition:
      left 0.12s,
      background 0.12s;
  }
  .sw.on {
    background: var(--color-green);
  }
  .sw.on .knob {
    left: 15px;
    background: var(--color-inset);
  }
  .sw.reviewing {
    background: var(--color-amber);
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: sw-pulse 1.1s ease-in-out infinite !important;
  }
  @keyframes sw-pulse {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 1;
    }
  }
  .drain-fields {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px 12px 22px;
    border-top: 1px solid var(--color-line);
    background: var(--color-panel);
  }
  .drain-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .drain-label {
    font-size: 11px;
    color: var(--color-ink);
    white-space: nowrap;
  }
  .num {
    flex: 0 0 auto;
    width: 90px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 3px 6px;
    text-align: right;
  }
</style>
