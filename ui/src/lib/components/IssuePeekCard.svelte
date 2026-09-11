<script lang="ts">
  import type { PeekEntry } from "$lib/issue-peek.svelte";
  import { m } from "$lib/paraglide/messages";
  import { relativeAge } from "$lib/format";
  import { clock } from "$lib/now.svelte";

  // Content of the session card's issue hover-preview: number · author · age, title,
  // labels, and the start of the body. Same field set and the same chip/label recipe as
  // the backlog's IssueDetailsPopover, so the two previews read as one surface — but this
  // one is CONTENT ONLY. The floating shell (native popover, anchoring, dismissal) belongs
  // to the trigger in IssueBadge.svelte; keeping them apart is what lets a hover own the
  // lifecycle without a click-opened dialog's focus handling coming along.
  //
  // Two things can be known before the fetch lands: the number, and the title the session
  // recorded at launch. Both paint immediately so a hover is never an empty box, and the
  // fetched title wins once it arrives (an issue can be renamed after a session starts).
  let {
    number,
    fallbackTitle = null,
    entry,
  }: {
    number: number;
    /** `launchMetadata.issue.title` — the launch-time snapshot; null on rows predating it. */
    fallbackTitle?: string | null;
    /** null while the request has not been made yet — rendered like "loading". */
    entry: PeekEntry | null;
  } = $props();

  const issue = $derived(entry?.state === "ready" ? entry.issue : null);
  const title = $derived(issue?.title ?? fallbackTitle);
  // The body clamps visually to a handful of lines (see .ip-body): this is a peek, and
  // the whole issue is one click away on the forge.
  const body = $derived(issue?.body.trim() ?? "");
</script>

<div class="ip">
  <div class="ip-head">
    <span class="ip-num">#{number}</span>
    {#if issue?.author}
      <span class="ip-author">{m.issuerow_author_by({ login: issue.author })}</span>
    {/if}
    {#if issue}
      <span class="ip-age">{relativeAge(issue.createdAt, clock.current)}</span>
    {/if}
  </div>
  {#if title}
    <div class="ip-title">{title}</div>
  {/if}
  {#if issue}
    {#if issue.labels.length > 0}
      <div class="ip-labels">
        {#each issue.labels as label (label)}
          <span class="ip-chip">{label}</span>
        {/each}
      </div>
    {/if}
    <div class="ip-body">
      {#if body}{body}{:else}<span class="ip-empty">{m.issuedetails_no_body()}</span>{/if}
    </div>
  {:else}
    <div class="ip-note">
      {entry?.state === "unavailable" ? m.issuepeek_unavailable() : m.issuepeek_loading()}
    </div>
  {/if}
</div>

<style>
  .ip {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-family: var(--font-mono);
    /* The trigger sits in a badge rail that may impose uppercase/tracking — the preview
       is prose and must render verbatim (same reasoning as InfoTip's tooltip). */
    text-transform: none;
    letter-spacing: normal;
  }
  .ip-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 8px;
    font-size: var(--fs-micro);
    color: var(--color-faint);
  }
  .ip-num {
    color: var(--color-muted);
  }
  .ip-author {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 20ch;
  }
  .ip-title {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    line-height: 1.4;
    word-break: break-word;
  }
  .ip-labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .ip-chip {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 5px;
  }
  /* Clamped, never scrollable: a scroll region hanging off the pointer is fiddly, and a
     scroll gesture dismisses popovers everywhere else in Shepherd. Eight lines is the
     peek; the rest is what the click is for. */
  .ip-body {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    border-top: 1px solid var(--color-line);
    padding-top: 6px;
    display: -webkit-box;
    -webkit-line-clamp: 8;
    line-clamp: 8;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ip-empty {
    color: var(--color-faint);
    font-style: italic;
  }
  /* Loading / unavailable: one quiet line, never an alarm — the number and the launch
     title above it are already the useful part. */
  .ip-note {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    border-top: 1px solid var(--color-line);
    padding-top: 6px;
  }
</style>
