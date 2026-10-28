<script lang="ts">
  import { tick } from "svelte";
  import type { EpicAutoFixCauseCode } from "#lib/types.js";
  import type { OverviewFix } from "#lib/repo-precheck.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { overviewConfirmText, type EpicHaltView } from "../repo-halt";

  // #3456: an epic card's halt in the repo overview. Held now: every cause, the repo's and host's
  // only pointing at the banner above, the epic's own with its fix. Queued or not started: the
  // pre-check — what would hold it on start, or that only the repo's halt does and what else it
  // has. After the card's fix, what it set and Undo.
  let {
    view,
    repoName,
    applied = null,
    busy = false,
    onaction,
    onundo,
  }: {
    view: EpicHaltView | null;
    repoName: string;
    /** A fix applied from this card, until Undo. */
    applied?: OverviewFix | null;
    busy?: boolean;
    onaction: (code: EpicAutoFixCauseCode) => Promise<boolean>;
    onundo: () => void;
  } = $props();

  let undoBtn = $state<HTMLButtonElement>();

  /** The fix went through: its button may be gone, so the focus moves to its Undo. */
  async function act(code: EpicAutoFixCauseCode) {
    if (!(await onaction(code))) return;
    await tick();
    undoBtn?.focus();
  }
</script>

{#if view}
  <div class="card-halt" class:held={view.kind === "halted"} data-epic-card-halt={view.kind}>
    {#if view.kind === "waits"}
      <p class="line">
        <span class="chip" data-scope={view.scope}>{view.scopeLabel}</span>
        <span class="text muted">
          {m.repooverview_precheck_waits()}
          {#if view.ready}
            {m.repooverview_precheck_ready()}
            <span class="ready"
              >{#each view.ready as check, i (check)}{i ? " · " : ""}<span aria-hidden="true"
                  >✓</span
                >
                {check}{/each}</span
            >
          {/if}
        </span>
      </p>
    {:else}
      {#each view.lines as line, i (i)}
        <p class="line">
          <span class="chip" class:own={!line.pointer} data-scope={line.scope}
            >{line.scopeLabel}</span
          >
          <span class="text"
            >{#if line.what}<span class="what">{line.what}</span>{/if}
            {line.text}</span
          >
          {#if line.action}
            {@const code = line.action.code}
            <button
              class="gbtn"
              type="button"
              disabled={busy}
              aria-busy={busy}
              data-epic-card-fix={code}
              onclick={() => act(code)}>{line.action.label}</button
            >
          {/if}
        </p>
      {/each}
    {/if}
  </div>
{/if}

{#if applied}
  <p class="fixed" role="status" data-epic-card-done>
    <span class="fixed-mark" aria-hidden="true">✓</span>
    <span>{overviewConfirmText(applied.changes, repoName, applied.parent)}</span>
    <button bind:this={undoBtn} class="link" type="button" disabled={busy} onclick={onundo}
      >{m.epic_autofix_undo()}</button
    >
  </p>
{/if}

<style>
  .card-halt {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--fs-micro);
  }
  /* Held now: the causes framed together, as the reason this epic doesn't move. */
  .card-halt.held {
    padding: 6px 8px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    margin: 0;
  }
  .text {
    flex: 1 1 220px;
    min-width: 0;
    color: var(--color-ink);
    overflow-wrap: anywhere;
  }
  .text.muted,
  .ready {
    color: var(--color-muted);
  }
  .what {
    color: var(--color-ink-bright);
  }

  /* Scope chip: neutral where the card only points at the banner, red where the cause is this
     epic's own. The legend under the epics says what each scope means. */
  .chip {
    flex: none;
    min-width: 40px;
    padding: 0 4px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    letter-spacing: 0.08em;
    text-align: center;
  }
  .chip.own {
    border-color: color-mix(in srgb, var(--color-red) 45%, var(--color-line));
    color: color-mix(in srgb, var(--color-red) 80%, var(--color-ink-bright));
  }

  /* The fix is applied: what it set, and the way back (as in the epic's run area). */
  .fixed {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-micro);
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
    font-size: var(--fs-micro);
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
