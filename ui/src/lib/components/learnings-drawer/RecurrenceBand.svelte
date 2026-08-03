<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { MergeSuggestion } from "$lib/types";
  import { basename } from "../learnings-drawer";

  let {
    suggestions,
    ondismissmerge,
  }: {
    suggestions: MergeSuggestion[];
    ondismissmerge: (id: string) => void;
  } = $props();
</script>

{#if suggestions.length > 0}
  <section class="recur" aria-label={m.learnings_recur_heading()}>
    <span class="recur-title">{m.learnings_recur_heading()}</span>
    <p class="recur-lead">{m.learnings_recur_lead()}</p>
    {#each suggestions as s (s.id)}
      <article class="recur-card">
        <p class="recur-rule">{s.mergedRule}</p>
        <p class="recur-repos">
          {m.learnings_recur_repos({
            count: s.repoPaths?.length ?? 0,
            repos: (s.repoPaths ?? []).map(basename).join(", "),
          })}
        </p>
        <div class="recur-foot">
          <button
            class="ms-dismiss"
            type="button"
            onclick={() => ondismissmerge(s.id)}
            aria-label={m.learnings_recur_dismiss_aria()}
          >
            {m.learnings_dismiss()}
          </button>
        </div>
      </article>
    {/each}
  </section>
{/if}

<style>
  /* Phase 4: cross-repo recurrence band (top-level, repo-agnostic) */
  .recur {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--color-line);
    background: var(--color-head);
  }
  .recur-title {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-muted);
  }
  .recur-lead {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
  }
  .recur-card {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .recur-rule {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    line-height: 1.5;
  }
  .recur-repos {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
  }
  .recur-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }
  .ms-dismiss {
    font-size: var(--fs-base);
    padding: 4px 10px;
    cursor: pointer;
    border: 1px solid var(--color-line-bright);
    background: none;
    color: var(--color-muted);
  }
  .ms-dismiss:hover {
    color: var(--color-ink-bright);
    border-color: var(--color-ink-bright);
  }
</style>
