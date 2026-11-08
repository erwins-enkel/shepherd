<script lang="ts">
  import { untrack } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { automationFocus } from "#lib/automation-focus.js";
  import { clampCap, clampCeiling, sanitizeLabel } from "../git-rail-drain";
  import { checkPriorityLabel, PRIORITY_LABEL } from "#lib/list-entries.js";
  import { priorityLabelsExplanation } from "#lib/tooltips/explanations.js";
  import RepoSettingRow from "../repo-settings/RepoSettingRow.svelte";
  import ListField from "../repo-settings/ListField.svelte";
  import "./automation-fields.css";

  // The Auto-Drain "rails" (cap / label / usage ceiling). Rendered inline directly
  // beneath the Auto-Drain toggle so the dials read as belonging to that switch
  // rather than floating in an unrelated section below. `active` gates visibility
  // here (instead of an {#if} at the call site) to keep the parent's already-large
  // template flat. `epicActive` (a running epic has taken over draining) hides the
  // label field — label-drain is suspended mid-epic, so its dial is inert — while
  // the cap and usage ceiling stay editable, since both are still enforced against
  // the epic's children.
  let {
    repoPath,
    active,
    epicActive = false,
  }: { repoPath: string; active: boolean; epicActive?: boolean } = $props();

  // Per-instance prefix so the hint IDs (and the inputs' aria-describedby) stay
  // unique even if two panels mount at once (e.g. in-task popover + backlog tab).
  const uid = $props.id();

  // Seeded from stored config; re-seeded whenever the repo changes (the component
  // stays mounted across repo switches as long as Auto-Drain remains on).
  // svelte-ignore state_referenced_locally
  let drainCap = $state(repoConfig.maxAutoFor(repoPath));
  // svelte-ignore state_referenced_locally
  let drainLabel = $state(repoConfig.autoLabelFor(repoPath));
  // svelte-ignore state_referenced_locally
  let drainCeiling = $state(repoConfig.usageCeilingFor(repoPath));
  $effect(() => {
    // Re-seed when the repo changes, and once its stored config arrives (the rails can mount
    // before it loaded). The store reads are untracked so committing a field (which writes back
    // to the store) never retriggers this effect and clobbers an in-flight edit.
    const repo = repoPath;
    void repoConfig.isConfigLoaded(repo);
    untrack(() => {
      drainCap = repoConfig.maxAutoFor(repo);
      drainLabel = repoConfig.autoLabelFor(repo);
      drainCeiling = repoConfig.usageCeilingFor(repo);
    });
  });

  // The epic detail's "Allow N slots" (#2939) opens the tab here: bring the cap into view and
  // focus it. Reading `active` re-runs this when the rails appear.
  let capInput = $state<HTMLInputElement>();
  $effect(() => {
    if (active && capInput && automationFocus.take("max-auto")) {
      capInput.scrollIntoView({ block: "center" });
      capInput.focus();
    }
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
  const PRIORITY_LABEL_ERRORS = {
    empty: () => m.automation_priority_labels_err_empty(),
    duplicate: () => m.automation_priority_labels_err_duplicate(),
  };

  async function commitDrainCeiling() {
    const n = clampCeiling(drainCeiling);
    drainCeiling = n;
    await repoConfig.setUsageCeiling(repoPath, n);
    drainCeiling = repoConfig.usageCeilingFor(repoPath);
  }
</script>

{#if active}
  <div role="group" aria-label={m.automation_autodrain_name()}>
    <p class="drain-intro">
      {epicActive ? m.automation_drain_fields_intro_epic() : m.automation_drain_fields_intro()}
    </p>
    <RepoSettingRow field="maxAuto" name={m.drain_cap_label()} indent>
      {#snippet control()}
        <input
          class="afield-num"
          type="number"
          min="1"
          max="20"
          bind:this={capInput}
          bind:value={drainCap}
          aria-label={m.drain_cap_label()}
          aria-describedby="{uid}-cap"
          onchange={commitDrainCap}
        />
      {/snippet}
      {#snippet below()}
        <p id="{uid}-cap" class="drain-hint">{m.drain_cap_hint()}</p>
      {/snippet}
    </RepoSettingRow>
    {#if !epicActive}
      <RepoSettingRow field="autoLabel" name={m.drain_label_label()} indent>
        {#snippet control()}
          <input
            class="afield-num txt drain-label-input"
            type="text"
            bind:value={drainLabel}
            aria-label={m.drain_label_label()}
            aria-describedby="{uid}-label"
            onchange={commitDrainLabel}
            onblur={commitDrainLabel}
          />
        {/snippet}
        {#snippet below()}
          <p id="{uid}-label" class="drain-hint">{m.drain_label_hint()}</p>
        {/snippet}
      </RepoSettingRow>
      <!-- Like the label, the priority labels only order label-drain, which a running epic suspends. -->
      <ListField
        field="priorityLabels"
        name={m.automation_priority_labels_label()}
        explanation={priorityLabelsExplanation()}
        fixed={[PRIORITY_LABEL]}
        items={repoConfig.priorityLabelsFor(repoPath)}
        check={checkPriorityLabel}
        errors={PRIORITY_LABEL_ERRORS}
        placeholder={m.automation_priority_labels_placeholder()}
        addLabel={m.automation_priority_labels_add()}
        removeLabel={(label) => m.automation_priority_labels_remove({ label })}
        hint={m.automation_priority_labels_hint()}
        onchange={(labels) => repoConfig.setPriorityLabels(repoPath, labels)}
      />
    {/if}
    <RepoSettingRow field="usageCeilingPct" name={m.drain_ceiling_label()} indent>
      {#snippet control()}
        <input
          class="afield-num"
          type="number"
          min="0"
          max="100"
          bind:value={drainCeiling}
          aria-label={m.drain_ceiling_label()}
          aria-describedby="{uid}-ceiling"
          onchange={commitDrainCeiling}
        />
      {/snippet}
      {#snippet below()}
        <p id="{uid}-ceiling" class="drain-hint">{m.drain_ceiling_hint()}</p>
      {/snippet}
    </RepoSettingRow>
  </div>
{/if}

<style>
  /* The `.afield-num` input chrome comes from ./automation-fields.css (imported above). Only the
     field-doc copy below is local to this component. */
  /* Lead-in sentence framing the three dials as Auto-Drain's rails. */
  .drain-intro {
    margin: 0;
    padding: 4px 12px 6px 26px;
    font-size: var(--fs-meta);
    line-height: 1.45;
    color: var(--color-muted);
  }
  /* Per-field explanation: quiet, sits flush under its field so the meaning of
     each dial is legible inline rather than hidden behind a tooltip. */
  .drain-hint {
    margin: 2px 0 0;
    font-size: var(--fs-micro);
    line-height: 1.45;
    color: var(--color-faint);
  }
  /* Free-text label name, not a number: drop the `.afield-num` mono. */
  .drain-label-input {
    font-family: var(--font-sans);
  }
</style>
