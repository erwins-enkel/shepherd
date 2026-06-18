<script lang="ts">
  import type { Session, RecapVerdict } from "$lib/types";
  import { recaps } from "$lib/recaps.svelte";
  import { formatAgo } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";
  import VisualReview from "./VisualReview.svelte";

  let { session }: { session: Session } = $props();

  const recap = $derived(recaps.map[session.id]);

  // relative "finished X ago" from archivedAt; falls back to updatedAt when an
  // archived session somehow has no archivedAt stamp. Driven by the shared 30s
  // `clock` (matching the Herd row's nowMs) so the stamp ticks while the panel stays open.
  const finishedAt = $derived(session.archivedAt ?? session.updatedAt);
  const finishedAgo = $derived(formatAgo(clock.current - finishedAt));

  // Durable recaps + this Done lens shipped with #665 (2026-06-14 09:44 +02:00).
  // A session that finished before then never got the chance to record a recap
  // row, so the empty state explains *why* rather than reading like a failure.
  // (epoch ms of the shipping commit; sessions carry no herdr-version stamp to
  // compare against, so the finish time is the signal.)
  const RECAP_FEATURE_EPOCH_MS = 1781423073000;
  const predatesRecapFeature = $derived(recap === undefined && finishedAt < RECAP_FEATURE_EPOCH_MS);

  // Render the (LLM-authored) body as sanitized markdown. Dynamically imported so
  // marked/DOMPurify stay off the first-paint critical path; gated on a ready recap
  // body so the browser-only sanitizer never runs during SSR or for an empty body.
  let renderedBody = $state("");
  $effect(() => {
    const body = recap?.state === "ready" ? recap.body : undefined;
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

  // Mirrors SessionRecap's verdict mapping (semantic, not decorative): green only for a
  // genuinely-ready verdict; a parked/done session reads slate; needs-attention amber.
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

  const hasFileTree = $derived(!!recap?.blocks?.some((b) => b.type === "file-tree"));
</script>

<section class="done-recap" aria-label={m.done_recap_panel_aria({ desig: session.desig })}>
  <header class="dr-head">
    <span class="dr-desig">{session.desig}</span>
    <span class="dr-finished">{m.done_recap_finished({ ago: finishedAgo })}</span>
    {#if session.issueNumber != null}
      <span class="dr-issue">{m.recap_issue({ n: session.issueNumber })}</span>
    {/if}
  </header>

  <div class="dr-body">
    {#if recap?.state === "ready"}
      {#if recap.verdict}
        <span class="dr-verdict" style:color={VERDICT_COLOR[recap.verdict]}
          >{verdictLabel(recap.verdict)}</span
        >
      {/if}
      {#if recap.headline}
        <p class="dr-headline">{recap.headline}</p>
      {/if}
      {#if recap.blocks && recap.blocks.length > 0}
        <VisualReview blocks={recap.blocks} />
      {:else if renderedBody}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify above -->
        <div class="dr-md">{@html renderedBody}</div>
      {/if}
      {#if recap.openItems.length > 0}
        <div class="dr-section">
          <p class="dr-section-head">{m.recap_open_items()}</p>
          <ul class="dr-list">
            {#each recap.openItems as item (item)}
              <li>{item}</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if recap.changedFiles.length > 0 && !hasFileTree}
        <div class="dr-section">
          <p class="dr-section-head">{m.recap_changed_files()}</p>
          <ul class="dr-list dr-files">
            {#each recap.changedFiles as file (file)}
              <li>{file}</li>
            {/each}
          </ul>
        </div>
      {/if}
    {:else if recap?.state === "generating"}
      <p class="dr-muted">{m.recap_generating()}</p>
    {:else if recap?.state === "failed"}
      <!-- generation ran but couldn't produce a recap — say so, don't imply it was never tried. -->
      <p class="dr-muted">{m.recap_failed()}</p>
    {:else if predatesRecapFeature}
      <!-- finished before durable recaps existed: name the reason instead of a bare "unavailable". -->
      <p class="dr-muted">{m.recap_predates_feature()}</p>
    {:else}
      <!-- empty diff or no recap row: fail-closed — never a blank card that reads as a success. -->
      <p class="dr-muted">{m.recap_unavailable()}</p>
    {/if}
  </div>
</section>

<style>
  .done-recap {
    position: relative;
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    overflow: auto;
    min-height: 0;
    flex: 1;
  }

  .dr-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-line);
  }

  .dr-desig {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    font-weight: 600;
  }

  .dr-finished {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }

  .dr-issue {
    margin-left: auto;
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }

  .dr-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
  }

  .dr-verdict {
    align-self: flex-start;
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .dr-headline {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }

  .dr-md {
    font-size: var(--fs-base);
    color: var(--color-ink);
    line-height: 1.5;
  }

  .dr-md :global(p) {
    margin: 0 0 8px 0;
  }

  .dr-md :global(ul),
  .dr-md :global(ol) {
    margin: 0 0 8px 0;
    padding-left: 18px;
  }

  .dr-md :global(a) {
    color: var(--color-amber);
  }

  .dr-section-head {
    margin: 0 0 4px 0;
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
  }

  .dr-list {
    margin: 0;
    padding-left: 16px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }

  .dr-list li {
    margin-bottom: 2px;
  }

  .dr-files {
    font-variant-numeric: tabular-nums;
    word-break: break-all;
  }

  .dr-muted {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
</style>
