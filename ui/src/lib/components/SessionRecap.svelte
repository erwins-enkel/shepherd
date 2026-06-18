<script lang="ts">
  import type { Session } from "$lib/types";
  import type { RecapVerdict } from "$lib/types";
  import { recaps } from "$lib/recaps.svelte";
  import { regenerateRecap } from "$lib/api";
  import { m } from "$lib/paraglide/messages";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import VisualReview from "./VisualReview.svelte";

  let { session }: { session: Session } = $props();

  const recap = $derived(recaps.map[session.id]);

  let expanded = $state(false);
  let regenerating = $state(false);
  let regenFailed = $state(false);

  // Render the (LLM-authored) body as sanitized markdown.
  // Dynamically imported so marked/DOMPurify stay off the first-paint critical path;
  // gated on expanded so the browser-only sanitizer never runs during SSR.
  let renderedBody = $state("");
  $effect(() => {
    const body = expanded ? recap?.body : undefined;
    if (!body) {
      renderedBody = "";
      return;
    }
    let alive = true;
    Promise.all([import("marked"), import("dompurify")])
      .then(([{ marked }, { default: DOMPurify }]) => {
        if (alive)
          renderedBody = DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
      })
      .catch((err) => {
        console.warn("Recap body markdown render failed", err);
      });
    return () => {
      alive = false;
    };
  });

  const VERDICT_COLOR: Record<RecapVerdict, string> = {
    ready: "var(--color-green)",
    parked: "var(--status-done)",
    needs_attention: "var(--color-amber)",
  };

  function verdictLabel(v: RecapVerdict): string {
    if (v === "ready") return m.recap_verdict_ready();
    if (v === "parked") return m.recap_verdict_parked();
    return m.recap_verdict_needs_attention();
  }

  async function handleRegenerate() {
    regenFailed = false;
    regenerating = true;
    try {
      const result = await regenerateRecap(session.id);
      if (result && result.status === "error") regenFailed = true;
    } catch {
      regenFailed = true;
    } finally {
      regenerating = false;
    }
  }
</script>

<!-- fallow-ignore-next-line complexity -->
{#if recap && recap.state !== "empty"}
  <!-- coachTarget id "session-recap" matches FeatureAnnouncement.targetId -->
  <div class="recap-card panel" use:coachTarget={"session-recap"}>
    {#if recap.state === "generating"}
      <p class="recap-generating">{m.recap_generating()}</p>
    {:else if recap.state === "failed"}
      <div class="recap-failed-row">
        <span class="recap-label">{m.recap_failed()}</span>
        <button class="gbtn" onclick={handleRegenerate} disabled={regenerating}
          >{m.recap_retry()}</button
        >
      </div>
      {#if regenFailed}
        <p class="recap-regen-error">{m.recap_regenerate_failed()}</p>
      {/if}
    {:else if recap.state === "ready"}
      <button class="recap-header" onclick={() => (expanded = !expanded)} aria-expanded={expanded}>
        {#if recap.verdict}
          <span class="recap-verdict-chip" style:color={VERDICT_COLOR[recap.verdict]}
            >{verdictLabel(recap.verdict)}</span
          >
        {/if}
        <span class="recap-headline">{recap.headline}</span>
        <span class="recap-expand-icon" aria-hidden="true"
          >{expanded ? m.recap_collapse() : m.recap_expand()}</span
        >
      </button>
      {#if expanded}
        <div class="recap-body">
          {#if recap.blocks && recap.blocks.length > 0}
            <VisualReview blocks={recap.blocks} />
          {:else if renderedBody}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify above -->
            <div class="recap-md">{@html renderedBody}</div>
          {/if}
          {#if recap.openItems.length > 0}
            <div class="recap-open-items">
              <p class="recap-open-items-heading">{m.recap_open_items()}</p>
              <ul>
                {#each recap.openItems as item (item)}
                  <li>{item}</li>
                {/each}
              </ul>
            </div>
          {/if}
          <div class="recap-actions">
            <button class="gbtn" onclick={handleRegenerate} disabled={regenerating}
              >{m.recap_regenerate()}</button
            >
            {#if regenFailed}
              <p class="recap-regen-error">{m.recap_regenerate_failed()}</p>
            {/if}
          </div>
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .recap-card {
    margin: 0;
    padding: 6px 10px;
    font-size: var(--fs-sm);
    border-top: none;
    border-left: none;
    border-right: none;
    border-radius: 0;
    border-bottom: 1px solid var(--color-line);
  }

  .recap-generating {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--fs-sm);
  }

  .recap-failed-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .recap-label {
    color: var(--color-text-muted);
    font-size: var(--fs-sm);
    flex: 1;
  }

  .recap-header {
    display: flex;
    align-items: baseline;
    gap: 6px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
    color: var(--color-text);
    font-size: var(--fs-sm);
    width: 100%;
  }

  .recap-header:hover .recap-headline {
    text-decoration: underline;
  }

  .recap-verdict-chip {
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .recap-headline {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
  }

  .recap-expand-icon {
    font-size: var(--fs-micro);
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  .recap-body {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .recap-md {
    font-size: var(--fs-sm);
    color: var(--color-text);
    line-height: 1.5;
  }

  .recap-md :global(p) {
    margin: 0 0 6px 0;
  }

  .recap-md :global(ul),
  .recap-md :global(ol) {
    margin: 0 0 6px 0;
    padding-left: 18px;
  }

  .recap-open-items-heading {
    margin: 0 0 4px 0;
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
  }

  .recap-open-items ul {
    margin: 0;
    padding-left: 16px;
    font-size: var(--fs-sm);
    color: var(--color-text);
  }

  .recap-open-items li {
    margin-bottom: 2px;
  }

  .recap-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  .recap-regen-error {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--color-red, var(--color-amber));
  }
</style>
