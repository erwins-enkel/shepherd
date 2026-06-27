<script lang="ts">
  import type { Session, RecapVerdict } from "$lib/types";
  import { recaps } from "$lib/recaps.svelte";
  import { formatAgo } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";
  import VisualReview from "./VisualReview.svelte";

  let {
    session,
    onbringback,
  }: {
    session: Session;
    onbringback?: (id: string) => void;
  } = $props();

  // Two-step arm → confirm for Bring back: mirroring CardMenu's relaunchArmed pattern.
  // First click arms (label switches to confirm text, danger-wash applied); only a
  // second click within the window fires onbringback. Auto-disarms after ~3s.
  // Timer cleared on destroy so a dangling timer never fires after panel teardown.
  const BRING_BACK_ARM_MS = 3000;
  let bringBackArmed = $state(false);
  let bringBackTimer: ReturnType<typeof setTimeout> | undefined;
  function onBringBackClick() {
    if (bringBackArmed) {
      clearTimeout(bringBackTimer);
      bringBackArmed = false;
      onbringback?.(session.id);
      return;
    }
    bringBackArmed = true;
    clearTimeout(bringBackTimer);
    bringBackTimer = setTimeout(() => (bringBackArmed = false), BRING_BACK_ARM_MS);
  }
  $effect(() => () => clearTimeout(bringBackTimer));

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

<!-- fallow-ignore-next-line complexity -->
<section class="done-recap" aria-label={m.done_recap_panel_aria({ desig: session.desig })}>
  <header class="dr-head">
    <span class="dr-desig">{session.desig}</span>
    <span class="dr-finished">{m.done_recap_finished({ ago: finishedAgo })}</span>
    {#if onbringback}
      <div class="dr-actions">
        <button type="button" class="gbtn" class:armed={bringBackArmed} onclick={onBringBackClick}
          >{bringBackArmed ? m.donerecap_bringback_confirm() : m.donerecap_bringback()}</button
        >
      </div>
    {/if}
    {#if session.issueNumber != null}
      {#if session.issueUrl}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
        <a class="dr-issue dr-issue-link" href={session.issueUrl} target="_blank" rel="noopener"
          >{m.recap_issue({ n: session.issueNumber })}</a
        >
      {:else}
        <span class="dr-issue">{m.recap_issue({ n: session.issueNumber })}</span>
      {/if}
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

  /* Action cluster: sits right after the muted stamps; the issue link's auto margin
     pushes them both to the right edge, keeping the header layout intact. */
  .dr-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* Bring-back button: canonical .gbtn recipe from the design system (token-only). */
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
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* Armed state mirrors CardMenu's armed danger-wash so the second click reads as hot. */
  .gbtn.armed {
    border-color: var(--color-red);
    color: var(--color-red);
    background: color-mix(in srgb, var(--color-red) 14%, var(--color-panel));
  }
  .gbtn.armed:hover {
    background: color-mix(in srgb, var(--color-red) 22%, var(--color-panel));
  }

  .dr-issue {
    margin-left: auto;
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }

  /* Clickable variant when the Done payload carries a forge issue URL. Amber accent
     matches the panel's markdown links (.dr-md a); underline on hover signals interactivity. */
  .dr-issue-link {
    color: var(--color-amber);
    text-decoration: none;
  }

  .dr-issue-link:hover {
    text-decoration: underline;
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
