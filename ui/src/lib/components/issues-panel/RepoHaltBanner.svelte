<script lang="ts">
  import { tick } from "svelte";
  import type { EpicAutoBlockers, EpicAutoFixOptionId } from "#lib/types.js";
  import type { OverviewFix } from "#lib/repo-precheck.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { overviewConfirmText, type RepoHaltView } from "../repo-halt";
  import EpicAutoFixChooser from "./EpicAutoFixChooser.svelte";

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
</script>

{#if view}
  <section class="repo-halt" aria-labelledby={`${id}-title`} data-repo-halt>
    <div class="head">
      <svg class="stop" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z" />
        <path d="M12 7.5v5.5M12 16.6h.01" />
      </svg>
      <span class="body">
        <span class="title" id={`${id}-title`}>{m.repooverview_halt_title({ repo: repoName })}</span
        >
        <span class="reason">{view.reason} {affects}</span>
      </span>
      <span class="chip" data-scope={view.scope}>{view.scopeLabel}</span>
      <span class="acts">
        {#if view.autonomous != null}
          <button
            class="gbtn primary"
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
            class="gbtn"
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
        onkeydown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          close(true);
        }}
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
            <button class="gbtn" type="button" onclick={() => close(true)}
              >{m.common_cancel()}</button
            >
          {/snippet}
        </EpicAutoFixChooser>
      </div>
    {/if}
  </section>
{/if}

{#if applied}
  <p class="fixed" role="status" data-repo-halt-done>
    <span class="fixed-mark" aria-hidden="true">✓</span>
    <span>{overviewConfirmText(applied.changes, repoName, applied.parent)}</span>
    <button bind:this={undoBtn} class="link" type="button" disabled={busy} onclick={onundo}
      >{m.epic_autofix_undo()}</button
    >
  </p>
{/if}

<style>
  /* Red-washed like the epic's halt card (#3454): the reason nothing starts in this repo. */
  .repo-halt {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px;
    background: var(--wash-attention);
    border: 1px solid color-mix(in srgb, var(--color-red) 45%, var(--color-line));
    border-radius: 2px;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
  .stop {
    flex: none;
    width: 15px;
    height: 15px;
    fill: none;
    stroke: var(--color-red);
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
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
    font-size: var(--fs-meta);
  }
  /* Scope chip, pulled toward the text colour so it keeps 4.5:1 on the red wash (as the halt
     card's chips); the legend under the epics says what it means. */
  .chip {
    flex: none;
    padding: 0 6px;
    border: 1px solid color-mix(in srgb, var(--color-red) 45%, var(--color-line));
    border-radius: 2px;
    color: color-mix(in srgb, var(--color-red) 80%, var(--color-ink-bright));
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
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
    .acts .gbtn {
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
    font-size: var(--fs-meta);
    font-weight: 600;
  }

  /* The fix is applied: what it set, and the way back (as in the epic's run area). */
  .fixed {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }
  .fixed-mark {
    color: var(--status-done);
  }

  /* Text-link recipe (as EpicRunControl's .link): a real button, styled as inline text. */
  .link {
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    text-decoration: underline;
    cursor: pointer;
  }
  .link:hover:not(:disabled),
  .link:focus-visible {
    color: var(--color-amber);
    outline: none;
  }
  .link:disabled {
    cursor: progress;
  }

  /* Canonical .gbtn recipe from /design-system (scoped copy, as in RepoOverview). */
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
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:disabled {
    cursor: progress;
    opacity: 0.6;
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  @media (max-width: 768px), (max-height: 600px) {
    .gbtn,
    .link {
      min-height: 44px;
    }
    .gbtn {
      padding: 2px 14px;
    }
  }
</style>
