<script lang="ts">
  import { tick } from "svelte";
  import type { EpicAutoFixCauseCode } from "#lib/types.js";
  import type { OverviewFix } from "#lib/repo-precheck.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { EpicHaltView } from "../repo-halt";
  import HaltFixApplied from "./HaltFixApplied.svelte";
  import "./halt-controls.css";

  // #3456: an epic card's halt in the repo overview. Held now: every cause, the repo's and host's
  // only pointing at the banner above, the epic's own with its fix. Queued or not started: the
  // pre-check — what would hold it on start, or that only the repo's halt does and what else it
  // has. After the card's fix, what it set and Undo. Renders nothing while it has neither.
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

{#if view || applied}
  <div class="card-halt">
    {#if view?.kind === "waits"}
      <p class="line" data-epic-card-halt={view.kind}>
        <span class="hc-chip" data-scope={view.scope}>{view.scopeLabel}</span>
        <span class="text muted">
          {m.repooverview_precheck_waits()}
          {#if view.ready}
            {m.repooverview_precheck_ready()}
            <span
              >{#each view.ready as check, i (check)}{i ? " · " : ""}<span aria-hidden="true"
                  >✓</span
                >
                {check}{/each}</span
            >
          {/if}
        </span>
      </p>
    {:else if view}
      <div class="lines" class:held={view.kind === "halted"} data-epic-card-halt={view.kind}>
        {#each view.lines as line, i (i)}
          <p class="line">
            <span class={["hc-chip", !line.pointer && "hc-own"]} data-scope={line.scope}
              >{line.scopeLabel}</span
            >
            <span class="text"
              >{#if line.what}<span class="what">{line.what}</span>{/if}
              {line.text}</span
            >
            {#if line.action}
              {@const code = line.action.code}
              <button
                class="hc-gbtn"
                type="button"
                disabled={busy}
                aria-busy={busy}
                data-epic-card-fix={code}
                onclick={() => act(code)}>{line.action.label}</button
              >
            {/if}
          </p>
        {/each}
      </div>
    {/if}
    {#if applied}
      <HaltFixApplied
        fix={applied}
        {repoName}
        {busy}
        {onundo}
        bind:undoButton={undoBtn}
        data-epic-card-done
      />
    {/if}
  </div>
{/if}

<style>
  .card-halt {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 8px 6px;
    font-size: var(--fs-micro);
  }
  .lines {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* Held now: the causes framed together, as the reason this epic doesn't move. */
  .lines.held {
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
  .text.muted {
    color: var(--color-muted);
  }
  .what {
    color: var(--color-ink-bright);
  }
</style>
