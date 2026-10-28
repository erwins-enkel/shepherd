<script lang="ts">
  import { tick } from "svelte";
  import type { EpicAutoBlockers, EpicAutoFixOptionId } from "#lib/types.js";
  import type { OverviewFix } from "#lib/repo-precheck.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { RepoHaltView } from "../repo-halt";
  import EpicAutoFixChooser from "./EpicAutoFixChooser.svelte";
  import HaltFixApplied from "./HaltFixApplied.svelte";
  import "./halt-controls.css";

  // #3456: a halt in the repo's settings or on this host, said once at the top of the repo
  // overview instead of on every epic: what holds, how many epics it holds, "Switch to
  // Autonomous" when the model reports that effective here, and "Other choice …" opening the
  // chooser (#3454) inline — the reading pane has room, so no popover or sheet. After a fix, what
  // it set and Undo take its place.
  let {
    view,
    repoName,
    target = null,
    applied = null,
    busy = false,
    onautonomous,
    onapply,
    onundo,
  }: {
    /** The banner; null while nothing in the repo or on this host holds. */
    view: RepoHaltView | null;
    repoName: string;
    /** The model of the epic whose ways the chooser offers (`view.target`). */
    target?: EpicAutoBlockers | null;
    /** A fix applied from the banner, until Undo. */
    applied?: OverviewFix | null;
    busy?: boolean;
    onautonomous: () => Promise<boolean>;
    onapply: (option: EpicAutoFixOptionId) => Promise<boolean>;
    onundo: () => void;
  } = $props();

  const id = $props.id();
  let open = $state(false);
  let picked = $state<EpicAutoFixOptionId | null>(null);
  let otherBtn = $state<HTMLButtonElement>();
  let undoBtn = $state<HTMLButtonElement>();

  const affects = $derived(
    view?.affected === 1
      ? m.repooverview_halt_affects_one()
      : m.repooverview_halt_affects_many({ count: view?.affected ?? 0 }),
  );

  // Another epic's ways start from its own preselection.
  const targetParent = $derived(view?.target ?? null);
  $effect.pre(() => {
    void targetParent;
    picked = null;
  });

  function close(refocus: boolean) {
    open = false;
    if (refocus) void tick().then(() => otherBtn?.focus());
  }

  /** A fix went through: the banner may be gone, so the focus moves to its Undo. */
  async function done(ok: boolean) {
    if (!ok) return;
    open = false;
    await tick();
    undoBtn?.focus();
  }

  function onChooserKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    close(true);
  }
</script>

{#if view}
  <section class="hc-card" aria-labelledby={`${id}-title`} data-repo-halt>
    <div class="head">
      <svg class="hc-stop" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z" />
        <path d="M12 7.5v5.5M12 16.6h.01" />
      </svg>
      <span class="body">
        <span class="title" id={`${id}-title`}>{m.repooverview_halt_title({ repo: repoName })}</span
        >
        <span class="reason">{view.reason} {affects}</span>
      </span>
      <span class="hc-chip hc-own" data-scope={view.scope}>{view.scopeLabel}</span>
      <span class="acts">
        {#if view.autonomous != null}
          <button
            class="hc-gbtn hc-primary"
            type="button"
            disabled={busy}
            aria-busy={busy}
            data-repo-halt-autonomous
            onclick={async () => done(await onautonomous())}
            >{m.repooverview_halt_autonomous()}</button
          >
        {/if}
        {#if target?.options.length}
          <button
            bind:this={otherBtn}
            class="hc-gbtn"
            type="button"
            aria-expanded={open}
            aria-controls={open ? `${id}-choose` : undefined}
            onclick={() => (open ? close(false) : (open = true))}
            >{m.repooverview_halt_other()}</button
          >
        {/if}
      </span>
    </div>

    {#if open && target}
      <!-- Escape closes the inline chooser; the keys belong to the controls inside it. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        id={`${id}-choose`}
        class="choose"
        role="group"
        aria-labelledby={`${id}-choose-title`}
        onkeydown={onChooserKey}
      >
        <span class="choose-title" id={`${id}-choose-title`}
          >{m.epic_row_fix_title({ parent: view.target })}</span
        >
        <EpicAutoFixChooser
          blockers={target}
          {repoName}
          applyLabel={m.epic_autofix_apply()}
          {busy}
          onapply={async (option) => done(await onapply(option))}
          bind:picked
        >
          {#snippet extra()}
            <button class="hc-gbtn" type="button" onclick={() => close(true)}
              >{m.common_cancel()}</button
            >
          {/snippet}
        </EpicAutoFixChooser>
      </div>
    {/if}
  </section>
{/if}

{#if applied}
  <HaltFixApplied
    fix={applied}
    {repoName}
    {busy}
    {onundo}
    bind:undoButton={undoBtn}
    data-repo-halt-done
  />
{/if}

<style>
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
  .body {
    display: flex;
    flex: 1 1 260px;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .title {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .reason {
    color: var(--color-ink);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  /* Narrow run panel: the two ways share a row of their own instead of stacking. */
  @container run-panel (max-width: 560px) {
    .acts {
      flex-basis: 100%;
    }
    .acts > button {
      flex: 1 1 auto;
    }
  }

  .choose {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px solid var(--color-line);
  }
  .choose-title {
    color: var(--color-ink-bright);
    font-weight: 600;
  }
</style>
