<script lang="ts">
  import { m } from "$lib/paraglide/messages";

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
  .spawn span {
    font-size: var(--fs-base);
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
</style>
