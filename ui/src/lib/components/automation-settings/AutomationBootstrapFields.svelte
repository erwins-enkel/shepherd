<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { getLocale } from "#lib/i18n.js";
  import type { RepoBootstrapView } from "#lib/api.js";
  import { repoBootstrap } from "#lib/repo-bootstrap.svelte.js";
  import { bootstrapMissingText } from "../queue-strip";
  import "./automation-fields.css";

  // The active-bootstrap detail (#3105): the P1–P5 phase track, what still holds the drain, and
  // the operator override. The override is a deliberate two-step (arm → confirm) with its cost
  // spelled out, and once granted it stays visible with its timestamp — never a silent bypass.
  let { repoPath, view, busy }: { repoPath: string; view: RepoBootstrapView; busy: boolean } =
    $props();

  const PHASES = [
    () => m.automation_bootstrap_phase_1(),
    () => m.automation_bootstrap_phase_2(),
    () => m.automation_bootstrap_phase_3(),
    () => m.automation_bootstrap_phase_4(),
    () => m.automation_bootstrap_phase_5(),
  ];

  let arming = $state(false);
  const missing = $derived(bootstrapMissingText(view.missing.join(",")));
  const since = $derived(
    view.overrideAt == null
      ? ""
      : new Date(view.overrideAt).toLocaleString(getLocale() === "de" ? "de-DE" : "en-US"),
  );

  async function confirmOverride() {
    await repoBootstrap.setOverride(repoPath, true);
    arming = false;
  }
</script>

<div class="drain-fields bs-fields" role="group" aria-label={m.automation_bootstrap_name()}>
  <ol class="bs-phases" aria-label={m.automation_bootstrap_phases()}>
    {#each PHASES as label, i (i)}
      <li
        class={["bs-phase", { done: i + 1 < view.phase, current: i + 1 === view.phase }]}
        aria-current={i + 1 === view.phase ? "step" : undefined}
      >
        {label()}
      </li>
    {/each}
  </ol>
  {#if missing}
    <p class="bs-note">{m.automation_bootstrap_missing({ missing })}</p>
  {/if}
  {#if view.overrideAt != null}
    <p class="bs-note bs-warn" role="status">
      {m.automation_bootstrap_override_active({ time: since })}
    </p>
    <button
      class="bs-btn"
      type="button"
      disabled={busy}
      onclick={() => repoBootstrap.setOverride(repoPath, false)}
      >{m.automation_bootstrap_override_revoke()}</button
    >
  {:else if arming}
    <p class="bs-note bs-warn" role="alert">{m.automation_bootstrap_override_warn()}</p>
    <div class="bs-actions">
      <button class="bs-btn bs-danger" type="button" disabled={busy} onclick={confirmOverride}
        >{m.automation_bootstrap_override_confirm()}</button
      >
      <button class="bs-btn" type="button" onclick={() => (arming = false)}
        >{m.automation_bootstrap_override_cancel()}</button
      >
    </div>
  {:else}
    <button class="bs-btn" type="button" disabled={busy} onclick={() => (arming = true)}
      >{m.automation_bootstrap_override()}</button
    >
  {/if}
</div>

<style>
  .bs-phases {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .bs-phase {
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 6px;
    font-size: var(--fs-micro);
    color: var(--color-faint);
  }
  .bs-phase.done {
    color: var(--color-muted);
  }
  .bs-phase.current {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .bs-note {
    margin: 0;
    font-size: var(--fs-meta);
    line-height: 1.4;
    color: var(--color-ink);
  }
  .bs-warn {
    color: var(--color-amber);
  }
  .bs-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .bs-danger {
    border-color: var(--color-red);
    color: var(--color-red);
  }
</style>
