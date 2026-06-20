<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { Learning } from "$lib/types";
  import type { LearningsCtx } from "./ctx";

  let {
    rule,
    ctx,
  }: {
    rule: Learning;
    ctx: LearningsCtx;
  } = $props();
</script>

<article class="retired-rule">
  <p class="retired-text">{rule.rule}</p>
  <p class="retired-reason">
    {m.learnings_retired_reason({
      helped: rule.helpfulCount,
      pulls: rule.injectedCount,
      flagged: rule.ineffectiveCount,
    })}
  </p>
  <div class="retired-foot">
    <span class="spacer"></span>
    <button
      class="restore"
      type="button"
      aria-label={m.learnings_restore_aria()}
      onclick={() => ctx.onrestore(rule.id)}
    >
      {m.learnings_restore()}
    </button>
  </div>
</article>

<style>
  .retired-rule {
    border: 1px solid var(--color-line);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    opacity: 0.7;
  }
  .retired-text {
    font-size: var(--fs-base);
    color: var(--status-done);
    line-height: 1.5;
  }
  .retired-reason {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
  }
  .retired-foot {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spacer {
    flex: 1;
  }
  .restore {
    font-size: var(--fs-base);
    padding: 4px 10px;
    cursor: pointer;
    border: 1px solid var(--color-line-bright);
    background: none;
    color: var(--color-muted);
  }
  .restore:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-ink-bright);
  }
</style>
