<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { InjectableRule } from "$lib/types";
  import {
    injectionBadge,
    showIneffective,
    helpRate,
    isUnprovenTrialRule,
  } from "../learnings-drawer";
  import type { LearningsCtx } from "./ctx";

  let {
    rule,
    enabled,
    ctx,
  }: {
    rule: InjectableRule;
    enabled: boolean;
    ctx: LearningsCtx;
  } = $props();

  const badge = $derived(injectionBadge(rule, enabled));
  const isEditing = $derived(ctx.editingScope === rule.id);
  const isUnprovenTrial = $derived(isUnprovenTrialRule(rule));
</script>

<article class="irule">
  <p class="itext">{rule.rule}</p>
  <div class="ifoot">
    <span class="chip" class:promoted={rule.status === "promoted"}>
      {rule.status === "promoted" ? m.learnings_status_promoted() : m.learnings_status_active()}
    </span>
    {#if badge === "injected"}
      <span class="badge ok">✓ {m.learnings_injected_badge()}</span>
    {:else if badge === "scoped"}
      <span class="badge scoped" title={m.learnings_scoped_title()}>
        ◎ {m.learnings_scoped_badge()}
      </span>
    {:else if badge === "over-budget"}
      <span class="badge warn" title={m.learnings_overbudget_title()}>
        ⊘ {m.learnings_overbudget_badge()}
      </span>
    {:else}
      <span class="badge off">⊘ {m.learnings_injection_disabled_badge()}</span>
    {/if}
    {#if showIneffective(rule)}
      <span class="badge bad" title={m.learnings_ineffective_title()}>
        ⚠ {m.learnings_ineffective_badge({ count: rule.ineffectiveCount })}
      </span>
    {/if}
    {#if isUnprovenTrial}
      <span class="badge trial" title={m.learnings_trial_title()}
        >⚗ {m.learnings_trial_badge()}</span
      >
    {/if}
    {#if helpRate(rule) !== null}
      {@const hr = helpRate(rule)!}
      <span class="help-rate">{m.learnings_help_rate({ helped: hr.helped, pulls: hr.pulls })}</span>
    {/if}
    <span class="spacer"></span>
    <div class="iactions">
      {#if showIneffective(rule)}
        <button
          class="optimize"
          type="button"
          onclick={() => ctx.onoptimize(rule.id)}
          aria-label={m.learnings_optimize_aria()}
        >
          {m.learnings_optimize()}
        </button>
      {/if}
      {#if rule.status === "active"}
        {#if isUnprovenTrial}
          <button
            class="revert-trial"
            type="button"
            onclick={() => ctx.onreverttrial(rule.id, "proposed")}
            aria-label={m.learnings_revert_trial_aria()}
          >
            {m.learnings_revert_trial()}
          </button>
        {/if}
        <!-- Change 9: de-emphasised Dismiss with margin-left gap from Promote -->
        <button class="dismiss dismiss-muted" onclick={() => ctx.ondismiss(rule.id)}>
          {m.learnings_dismiss()}
        </button>
        <button
          class="promote"
          onclick={() => ctx.onpromote(rule.id)}
          aria-label={m.learnings_promote_aria()}
        >
          {m.learnings_promote()}
        </button>
      {:else if rule.status === "promoted" && rule.promotedPrUrl}
        <a class="prlink" href={rule.promotedPrUrl} target="_blank" rel="noopener external">
          {m.learnings_promoted_pr()}
        </a>
      {/if}
    </div>
  </div>
  <!-- #842: glob scope — which files this rule applies to (empty = always). -->
  <div class="iscope">
    {#if isEditing}
      <input
        class="scope-input"
        type="text"
        value={ctx.scopeDraft}
        oninput={(e) => ctx.onScopeInput(e.currentTarget.value)}
        placeholder={m.learnings_scope_placeholder()}
        aria-label={m.learnings_scope_input_aria()}
      />
      <button class="scope-save" type="button" onclick={() => ctx.onScopeSave(rule.id)}>
        {m.common_save()}
      </button>
      <button class="scope-cancel" type="button" onclick={() => ctx.onScopeCancel()}>
        {m.common_cancel()}
      </button>
    {:else}
      <span class="scope-label">{m.learnings_scope_label()}</span>
      {#if rule.scopeGlobs.length > 0}
        {#each rule.scopeGlobs as g (g)}<code class="scope-glob">{g}</code>{/each}
      {:else}
        <span class="scope-always">{m.learnings_scope_always()}</span>
      {/if}
      <button class="scope-edit" type="button" onclick={() => ctx.onScopeOpen(rule)}>
        {m.learnings_scope_edit()}
      </button>
    {/if}
  </div>
</article>

<style>
  .irule {
    border: 1px solid var(--color-line);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .itext {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    line-height: 1.5;
  }
  .ifoot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  /* Action group stays together as one flex item so it wraps as a unit
     (never fragmenting Optimize/Dismiss/Promote across lines) when the
     badge row runs out of room in the narrow drawer. */
  .iactions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .chip {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 2px 6px;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
  }
  .chip.promoted {
    border-color: var(--color-green);
    color: var(--color-green);
  }
  .badge {
    font-size: var(--fs-meta);
    padding: 2px 6px;
    border: 1px solid var(--color-line);
  }
  .badge.ok {
    border-color: var(--color-green);
    color: var(--color-green);
  }
  .badge.warn {
    border-color: var(--color-amber);
    color: var(--color-amber);
    cursor: help;
  }
  .badge.bad {
    border-color: var(--color-red, var(--color-amber));
    color: var(--color-red, var(--color-amber));
    cursor: help;
  }
  .badge.off {
    color: var(--color-muted);
  }
  .badge.scoped {
    border-color: var(--color-blue);
    color: var(--color-blue);
    cursor: help;
  }
  .badge.trial {
    border-color: var(--status-done);
    color: var(--status-done);
    cursor: help;
  }
  .help-rate {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .spacer {
    flex: 1;
  }
  .dismiss {
    font-size: var(--fs-base);
    padding: 5px 12px;
    cursor: pointer;
    border: 1px solid var(--color-line-bright);
    background: none;
    color: var(--color-muted);
  }
  /* Change 9: de-emphasised Dismiss on active rules — muted + gap from Promote */
  .dismiss-muted {
    color: var(--color-muted);
    border-color: var(--color-line);
    margin-right: 4px;
  }
  .promote {
    font-size: var(--fs-base);
    padding: 5px 12px;
    cursor: pointer;
    border: 1px solid var(--color-green);
    background: none;
    color: var(--color-green);
  }
  .prlink {
    font-size: var(--fs-base);
    color: var(--color-green);
    text-decoration: none;
  }
  /* Per-rule "Optimize" — headline action for a flagged rule, styled primary-ish
     like .promote but in the amber "needs attention" hue that flags the rule. */
  .optimize {
    font-size: var(--fs-base);
    padding: 5px 12px;
    cursor: pointer;
    border: 1px solid var(--color-amber);
    background: none;
    color: var(--color-amber);
  }
  .iscope {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .scope-label {
    color: var(--color-muted);
  }
  .scope-glob {
    padding: 1px 5px;
    border: 1px solid var(--color-line-bright);
    color: var(--color-blue);
    background: color-mix(in srgb, var(--color-blue) 10%, var(--color-head));
  }
  .scope-always {
    color: var(--color-muted);
    font-style: italic;
  }
  .revert-trial {
    font-size: var(--fs-base);
    padding: 5px 12px;
    cursor: pointer;
    border: 1px solid var(--color-line-bright);
    background: none;
    color: var(--color-muted);
  }
  .revert-trial:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-ink-bright);
  }
  .scope-edit,
  .scope-save,
  .scope-cancel {
    font-size: var(--fs-meta);
    background: none;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    padding: 2px 7px;
    cursor: pointer;
  }
  .scope-edit:hover,
  .scope-save:hover,
  .scope-cancel:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-ink-bright);
  }
  .scope-input {
    flex: 1 1 12rem;
    min-width: 0;
    font-size: var(--fs-meta);
    padding: 2px 6px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink-bright);
  }
</style>
