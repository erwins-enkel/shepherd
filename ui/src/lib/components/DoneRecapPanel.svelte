<script lang="ts">
  import type {
    Session,
    SessionUsage,
    RecapFailureCode,
    RecapVerdict,
    SessionArchiveReason,
  } from "$lib/types";
  import { recaps } from "$lib/recaps.svelte";
  import { formatAgo } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";
  import { getSessionUsage } from "$lib/api";
  import { recapSkipHeadline, recapSkipBody } from "$lib/recap-skip";
  import VisualReview from "./VisualReview.svelte";
  import SessionStatusBar from "./SessionStatusBar.svelte";

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

  // Usage for the pinned status bar. The panel can be re-rendered onto a DIFFERENT archived
  // session without a remount, so the load is keyed on the derived id (a $derived only
  // notifies on value change, mirroring Viewport's unitId note): the effect resets usage
  // immediately on a switch and an `alive` flag drops any late response for a previous id.
  // One-shot fetch — archived usage is snapshot-backed and static, no poll.
  const unitId = $derived(session.id);
  let usage = $state<SessionUsage | null>(null);
  $effect(() => {
    const id = unitId;
    usage = null;
    let alive = true;
    getSessionUsage(id)
      .then((u) => alive && (usage = u))
      .catch(() => {}); // pane shows its explained "—" placeholder
    return () => {
      alive = false;
    };
  });

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

  function archiveReasonLabel(reason?: SessionArchiveReason | null): string {
    if (reason === "operator") return m.done_recap_archive_operator();
    if (reason === "merged") return m.done_recap_archive_merged();
    if (reason === "drain") return m.done_recap_archive_drain();
    if (reason === "relaunch") return m.done_recap_archive_relaunch();
    return m.done_recap_archive_unknown();
  }

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

  function failureHeadline(code: RecapFailureCode): string {
    if (code === "auth-unavailable") return m.recap_failure_auth_headline();
    if (code === "source-unavailable") return m.recap_failure_source_headline();
    if (code === "launch-failed") return m.recap_failure_launch_headline();
    if (code === "timed-out") return m.recap_failure_timeout_headline();
    if (code === "no-result") return m.recap_failure_no_result_headline();
    return m.recap_failure_invalid_result_headline();
  }

  function failureAction(code: RecapFailureCode): string {
    if (code === "auth-unavailable") return m.recap_failure_auth_action();
    if (code === "source-unavailable") return m.recap_failure_source_action();
    return m.recap_failure_provider_action();
  }

  const hasFileTree = $derived(!!recap?.blocks?.some((b) => b.type === "file-tree"));
</script>

<!-- fallow-ignore-next-line complexity -->
<section class="done-recap" aria-label={m.done_recap_panel_aria({ desig: session.desig })}>
  <header class="dr-head">
    <span class="dr-desig">{session.desig}</span>
    <span class="dr-finished">{m.done_recap_finished({ ago: finishedAgo })}</span>
    <span class="dr-source">{archiveReasonLabel(session.archiveReason)}</span>
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
      {#if recap.diffState === "none"}
        <p class="dr-warning" role="note">⚠ {m.recap_no_diff_warning()}</p>
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
      {#if recap.failure}
        <p class="dr-failure-headline">{failureHeadline(recap.failure.code)}</p>
        <p class="dr-failure-body">{failureAction(recap.failure.code)}</p>
        <details class="dr-details">
          <summary>{m.recap_failure_details()}</summary>
          <dl>
            <dt>{m.recap_failure_provider()}</dt>
            <dd>{recap.failure.provider}</dd>
            <dt>{m.recap_failure_model()}</dt>
            <dd>{recap.failure.model ?? m.recap_failure_default_model()}</dd>
            {#if recap.failure.detail}
              <dt>{m.recap_failure_detail()}</dt>
              <dd>{recap.failure.detail}</dd>
            {/if}
          </dl>
        </details>
      {:else if recap.skip}
        <p class="dr-muted">{m.recap_failed()}</p>
        <p class="dr-failure-headline">{recapSkipHeadline(recap.skip)}</p>
        <p class="dr-failure-body">{recapSkipBody(recap.skip)}</p>
      {:else}
        <p class="dr-muted">{m.recap_failed()}</p>
        {#if recap.headline}
          <p class="dr-failure-headline">{recap.headline}</p>
        {/if}
        {#if recap.body}
          <p class="dr-failure-body">{recap.body}</p>
        {/if}
      {/if}
    {:else if recap?.state === "empty"}
      <p class="dr-warning" role="note">⚠ {m.recap_empty_legacy()}</p>
    {:else if predatesRecapFeature}
      <!-- finished before durable recaps existed: name the reason instead of a bare "unavailable". -->
      <p class="dr-muted">{m.recap_predates_feature()}</p>
    {:else}
      <!-- no recap row: fail-closed — never a blank card that reads as a success. -->
      <p class="dr-muted">{m.recap_unavailable()}</p>
    {/if}
  </div>

  <!-- Same persistent status pane as the live viewport, pinned below the scrolling body:
       finished sessions keep their model/effort/tokens/runtime glanceable. -->
  <SessionStatusBar {session} {usage} />
</section>

<style>
  .done-recap {
    position: relative;
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    /* Scroll ownership lives in .dr-body: the panel itself must not scroll, so the
       header and the pinned status bar stay in view while the recap body scrolls. */
    overflow: hidden;
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

  .dr-finished,
  .dr-source {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }

  .dr-source::before {
    content: "·";
    margin-right: 10px;
    color: var(--color-faint);
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
    /* The sole scroll container (see .done-recap): overflowing recap content scrolls
       here while the header above and the status bar below stay pinned. */
    flex: 1;
    min-height: 0;
    overflow: auto;
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

  .dr-warning {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--status-warn);
    background: color-mix(in srgb, var(--status-warn) 8%, transparent);
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-ink);
  }

  .dr-failure-headline {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }

  .dr-failure-body {
    margin: 0;
    font-size: var(--fs-meta);
    line-height: 1.5;
    color: var(--color-ink);
    white-space: pre-wrap;
  }

  .dr-details {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }

  .dr-details summary {
    width: fit-content;
    cursor: pointer;
    color: var(--color-muted);
  }

  .dr-details summary:hover {
    color: var(--color-ink-bright);
  }

  .dr-details dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 10px;
    margin: 8px 0 0;
    padding: 8px 10px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
  }

  .dr-details dt {
    color: var(--color-faint);
  }

  .dr-details dd {
    margin: 0;
    color: var(--color-ink);
    overflow-wrap: anywhere;
  }
</style>
