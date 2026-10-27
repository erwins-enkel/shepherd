<script lang="ts">
  import type { Snippet } from "svelte";
  import type { EpicAutoBlockers, EpicAutoFixOptionId } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { autoFixScopeExplanation } from "#lib/tooltips/explanations.js";
  import { causeView, optionView } from "../epic-auto-fix";

  // #3454: what keeps an epic's children from starting unattended and the ways out (#3453) — the
  // causes with their scope chips, the fixes as one radio group, and the button that applies the
  // chosen one. The host frames it and runs the apply; the epic's run area uses it today, the epic
  // row's popover and the repo overview reuse it (#3455, #3456).
  let {
    blockers,
    repoName,
    applyLabel,
    busy = false,
    onapply,
    extra = undefined,
  }: {
    blockers: EpicAutoBlockers;
    /** The repo whose sandbox a fix writes, as the copy names it. */
    repoName: string;
    applyLabel: string;
    /** An apply is in flight — the button waits. */
    busy?: boolean;
    onapply: (option: EpicAutoFixOptionId) => void;
    /** Beside the apply button, e.g. a link to all automation settings. */
    extra?: Snippet;
  } = $props();

  const name = $props.id();
  const causes = $derived(blockers.causes.map(causeView));
  const options = $derived(blockers.options.map((o) => optionView(o, blockers, repoName)));
  let picked = $state<EpicAutoFixOptionId | null>(null);
  // The operator's pick while it is still on offer, else the model's preselection.
  const selected = $derived(
    options.find((o) => o.id === picked && o.enabled)?.id ?? blockers.preselect,
  );
</script>

<div class="autofix">
  <ul class="causes">
    {#each causes as c, i (i)}
      <li class="cause">
        <button
          class="scope"
          type="button"
          data-scope={c.scope}
          use:statusTip={{ text: autoFixScopeExplanation() }}>{c.scopeLabel}</button
        >
        <span>
          {#if c.what}<span class="what">{c.what}</span>{/if}
          {c.why}
        </span>
      </li>
    {/each}
  </ul>

  {#if options.length}
    <fieldset class="ways">
      <legend>{m.epic_autofix_legend()}</legend>
      {#each options as o (o.id)}
        <label class="way" class:selected={o.id === selected} class:disabled={!o.enabled}>
          <input
            type="radio"
            {name}
            value={o.id}
            checked={o.id === selected}
            disabled={!o.enabled}
            onchange={() => (picked = o.id)}
          />
          <span class="way-text">
            <span class="way-head">
              <span class="way-title">{o.title}</span>
              <span class="where">{o.where}</span>
            </span>
            {#if o.body}<span>{o.body}</span>{/if}
            {#if o.disabledWhy}<span>{o.disabledWhy}</span>{/if}
            {#if o.change}
              <span><span class="faint">{m.epic_autofix_changes_label()}</span> {o.change}</span>
            {/if}
            {#if o.risk}<span class="risk">{o.risk}</span>{/if}
            {#if o.checks.length}
              <span class="checks">
                {#each o.checks as chk (chk.text)}
                  <span class:fail={!chk.ok}
                    ><span aria-hidden="true">{chk.ok ? "✓" : "✕"}</span> {chk.text}</span
                  >
                {/each}
              </span>
            {/if}
            {#if o.disabledHint}<span>{o.disabledHint}</span>{/if}
          </span>
        </label>
      {/each}
    </fieldset>
  {/if}

  <div class="act">
    <button
      class="gbtn primary"
      type="button"
      disabled={busy || selected == null}
      aria-busy={busy}
      onclick={() => selected != null && onapply(selected)}>{applyLabel}</button
    >
    {@render extra?.()}
  </div>
</div>

<style>
  .autofix {
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }

  .causes {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cause {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .what {
    color: var(--color-ink-bright);
  }

  /* Scope chip: a button so its explanation is reachable by keyboard and touch. */
  .scope {
    flex: none;
    min-width: 40px;
    padding: 0 4px;
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--color-red) 45%, var(--color-line));
    border-radius: 2px;
    /* Pulled toward the text colour so it keeps 4.5:1 on the halt card's red wash. */
    color: color-mix(in srgb, var(--color-red) 80%, var(--color-ink-bright));
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-align: center;
    cursor: help;
  }
  .scope:focus-visible {
    outline: 2px solid var(--color-amber);
    outline-offset: 2px;
  }

  .ways {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  legend {
    margin-bottom: 6px;
    padding: 0;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .way {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 8px 10px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    cursor: pointer;
  }
  .way.selected {
    border-color: var(--color-amber);
    background: color-mix(in srgb, var(--color-amber) 6%, var(--color-panel));
  }
  /* Greyed by border and text colour, never by opacity — the reason must stay readable. */
  .way.disabled {
    background: transparent;
    border-style: dashed;
    color: var(--color-muted);
    cursor: not-allowed;
  }
  .way input {
    flex: none;
    margin: 3px 0 0;
    accent-color: var(--color-amber);
  }
  .way input:focus-visible {
    outline: 2px solid var(--color-amber);
    outline-offset: 2px;
  }
  .way:has(input:focus-visible) {
    border-color: var(--color-amber);
  }

  .way-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .way-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
  }
  .way-title {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
  }
  .way.disabled .way-title {
    color: var(--color-muted);
  }
  .where,
  .faint {
    color: var(--color-muted);
  }
  .risk {
    color: var(--color-warn);
  }
  /* Passed checks stay quiet (never green for "healthy"); a failed one is the reason. */
  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    color: var(--color-muted);
  }
  .checks .fail {
    color: color-mix(in srgb, var(--color-red) 80%, var(--color-ink-bright));
  }

  .act {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }

  /* Canonical .gbtn recipe from /design-system (scoped copy, as in EpicRunControl). */
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
    .scope {
      min-height: 44px;
    }
    .gbtn {
      padding: 2px 14px;
    }
    /* The chip grows to a touch target: centre it on its cause instead of hanging on the
       first line's baseline. */
    .cause {
      align-items: center;
    }
  }
</style>
