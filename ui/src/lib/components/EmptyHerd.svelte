<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { CAPTURE_EXTENSION_URL } from "$lib/build-info";

  let {
    onnew,
    issueActionsUnset = false,
    onsettings = undefined,
  }: {
    // spawn the first task → existing New Task flow
    onnew: () => void;
    // no issue-scoped steer configured yet → backlog quick-launch is invisible; show a nudge
    issueActionsUnset?: boolean;
    // open Settings (nudge target); omitted → nudge is plain text, no link
    onsettings?: () => void;
  } = $props();
</script>

<div class="empty-herd">
  <div class="prompt">
    <h2 class="title micro">{m.emptyherd_title()}</h2>
    <p class="lede">{m.emptyherd_lede()}</p>
  </div>

  <button type="button" class="spawn" onclick={onnew}>
    <span aria-hidden="true">+</span>
    {m.emptyherd_spawn()}
  </button>

  <!-- Lifecycle overview: teaches the pipeline up front, before the user has any sessions to
       host the per-stage header tooltips. Condensed happy-path; reuses the shared stage
       strings so the empty state and the board headers never drift. -->
  <section class="flow">
    <h3 class="flow-heading micro">{m.emptyherd_flow_heading()}</h3>
    <ol class="flow-list">
      <li class="flow-step">
        <span class="flow-stage micro">{m.herd_stage_name_active()}</span>
        <span class="flow-desc">{m.herd_help_active()}</span>
      </li>
      <li class="flow-step">
        <span class="flow-stage micro">{m.herd_stage_name_ci_running()}</span>
        <span class="flow-desc">{m.herd_help_ci_running()}</span>
      </li>
      <li class="flow-step">
        <span class="flow-stage micro">{m.herd_stage_name_reviewing()}</span>
        <span class="flow-desc">{m.herd_help_reviewing()}</span>
      </li>
      <li class="flow-step">
        <span class="flow-stage micro">{m.herd_stage_name_your_turn()}</span>
        <span class="flow-desc">{m.herd_help_your_turn()}</span>
      </li>
      <li class="flow-step">
        <span class="flow-stage micro">{m.herd_stage_name_merged()}</span>
        <span class="flow-desc">{m.herd_help_merged()}</span>
      </li>
    </ol>
  </section>

  <dl class="verbs">
    <div class="verb">
      <dt class="micro">{m.emptyherd_verb_decommission_term()}</dt>
      <dd>{m.emptyherd_verb_decommission_desc()}</dd>
    </div>
    <div class="verb">
      <dt class="micro">{m.emptyherd_verb_archive_term()}</dt>
      <dd>{m.emptyherd_verb_archive_desc()}</dd>
    </div>
    <div class="verb">
      <dt class="micro">{m.emptyherd_verb_ready_term()}</dt>
      <dd>{m.emptyherd_verb_ready_desc()}</dd>
    </div>
  </dl>

  <p class="ext-promo">
    {m.emptyherd_extension_prompt()}
    <a
      class="ext-link"
      href={CAPTURE_EXTENSION_URL}
      target="_blank"
      rel="external noreferrer noopener"
      >{m.emptyherd_extension_link()} <span aria-hidden="true">↗</span></a
    >
  </p>

  {#if issueActionsUnset}
    <p class="nudge">
      {#if onsettings}
        <button type="button" class="nudge-link" onclick={onsettings}
          >{m.emptyherd_nudge_action()}</button
        >
        {m.emptyherd_nudge_tail()}
      {:else}
        {m.emptyherd_nudge_action()}
        {m.emptyherd_nudge_tail()}
      {/if}
    </p>
  {/if}
</div>

<style>
  .empty-herd {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 22px 16px;
    text-align: left;
  }

  .prompt {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .title {
    margin: 0;
    color: var(--color-muted);
  }

  .lede {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-base);
    line-height: 1.55;
  }

  /* amber primary: outline + inner glow, never a solid fill */
  .spawn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 44px;
    padding: 10px 14px;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    background: transparent;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    cursor: pointer;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
    transition: box-shadow 0.12s ease;
  }
  .spawn:hover {
    box-shadow: inset 0 0 24px -10px var(--color-amber);
  }
  /* keep the resting amber glow under the focus ring */
  .spawn:focus-visible {
    outline: none;
    box-shadow:
      inset 0 0 0 1px var(--color-amber),
      inset 0 0 18px -10px var(--color-amber);
  }
  .spawn span {
    font-size: var(--fs-base);
  }

  /* Lifecycle overview — a compact, numbered happy-path. Mirrors the .verbs block. */
  .flow {
    display: flex;
    flex-direction: column;
    gap: 10px;
    border-top: 1px solid var(--color-line);
    padding-top: 16px;
  }
  .flow-heading {
    margin: 0;
    color: var(--color-muted);
  }
  .flow-list {
    margin: 0;
    padding: 0 0 0 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .flow-step {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .flow-stage {
    color: var(--color-muted);
  }
  .flow-desc {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    line-height: 1.5;
  }

  .verbs {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    border-top: 1px solid var(--color-line);
    padding-top: 16px;
  }
  .verb {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .verb dt {
    margin: 0;
    color: var(--color-muted);
  }
  .verb dd {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    line-height: 1.5;
  }

  .nudge {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    line-height: 1.5;
  }
  .nudge-link {
    border: 0;
    background: none;
    padding: 0;
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--color-amber);
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .nudge-link:hover {
    color: var(--color-ink-bright);
  }
  /* bare text link — an inset ring reads wrong on a zero-padding underline, so
     use the brightened-hairline outline */
  .nudge-link:focus-visible {
    outline: 1.5px solid var(--color-line-bright);
    outline-offset: -1.5px;
  }

  /* Browser-extension promo — a quiet line + amber store link below the verbs. */
  .ext-promo {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    line-height: 1.5;
    border-top: 1px solid var(--color-line);
    padding-top: 16px;
  }
  .ext-link {
    color: var(--color-amber);
    text-decoration: underline;
    text-underline-offset: 2px;
    white-space: nowrap;
  }
  .ext-link:hover {
    color: var(--color-ink-bright);
  }
  .ext-link:focus-visible {
    outline: 1.5px solid var(--color-line-bright);
    outline-offset: 2px;
  }
</style>
