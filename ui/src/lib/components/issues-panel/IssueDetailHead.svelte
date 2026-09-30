<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { relativeAge } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import type { EpicOthersFlag } from "../issues-panel";
  import IssueLabelChips from "../IssueLabelChips.svelte";
  import AssignedPill from "./AssignedPill.svelte";
  import EpicOthersPill from "./EpicOthersPill.svelte";
  import IssueDetailMenu from "./IssueDetailMenu.svelte";

  // Head of the backlog reading detail (#2617): meta line, large title, GitHub link and — for
  // an epic — the ⋯ menu holding Import structure + Diagnose. Split from IssueDetail so each
  // template stays under the complexity bar; every optional bit is a plain prop.
  let {
    tag = null,
    number,
    title,
    url,
    labels = [],
    labelColors = undefined,
    author = undefined,
    createdAt = undefined,
    blockedBy = [],
    assign = null,
    othersFlag = null,
    menu = null,
  }: {
    /** Epic tag text ("Epic" / "Epic #12"); null on a single issue. */
    tag?: string | null;
    number: number;
    title: string;
    url: string;
    labels?: string[];
    labelColors?: Record<string, string>;
    author?: string;
    createdAt?: number;
    blockedBy?: number[];
    assign?: { who: string[]; framed: boolean } | null;
    othersFlag?: EpicOthersFlag | null;
    /** Epic-only ⋯ menu actions; null → no menu. */
    menu?: { canImport: boolean; onimport: () => void; ondiagnose: () => void } | null;
  } = $props();

  let menuBtn = $state<HTMLButtonElement>();
  let menuOpen = $state(false);
  const blockedText = $derived(
    blockedBy.length
      ? m.issuerow_blocked_on({ deps: blockedBy.map((n) => `#${n}`).join(", ") })
      : "",
  );
  const age = $derived(createdAt ? relativeAge(createdAt, clock.current) : "");

  function run(action: () => void) {
    menuOpen = false;
    action();
  }
</script>

<header class="detail-head">
  <div class="meta">
    {#if tag}<span class="epic-tag">{tag}</span>{/if}
    <span class="num">#{number}</span>
    <IssueLabelChips {labels} {labelColors} />
    {#if author}<span class="faint">{m.issuerow_author_by({ login: author })}</span>{/if}
    {#if age}<span class="faint">{age}</span>{/if}
    {#if blockedText}<span class="blocked-chip">{blockedText}</span>{/if}
    {#if assign}<AssignedPill who={assign.who} framed={assign.framed} />{/if}
    <EpicOthersPill flag={othersFlag} />
  </div>
  <div class="title-row">
    <h2 class="title">{title}</h2>
    {#if menu}
      <button
        bind:this={menuBtn}
        class="more-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={m.issuedetail_more_actions()}
        title={m.issuedetail_more_actions()}
        use:coachTarget={"epic-diagnose"}
        onclick={() => (menuOpen = !menuOpen)}>⋯</button
      >
    {/if}
  </div>
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
  <a class="gh-link" href={url} target="_blank" rel="noopener noreferrer"
    >{m.issuespanel_open_on_github()} ↗</a
  >
</header>

{#if menu && menuOpen && menuBtn}
  <IssueDetailMenu
    anchor={menuBtn}
    label={m.issuedetail_more_actions()}
    items={[
      ...(menu.canImport ? [{ label: m.epic_import(), onselect: () => run(menu.onimport) }] : []),
      {
        label: m.epic_diag_open(),
        title: m.epic_diag_open_title(),
        onselect: () => run(menu.ondiagnose),
      },
    ]}
    onclose={() => (menuOpen = false)}
  />
{/if}

<style>
  .detail-head {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-family: var(--font-mono);
  }

  .meta {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
    font-size: var(--fs-meta);
  }

  .epic-tag {
    padding: 1px 5px;
    border: 1px solid var(--status-running);
    border-radius: 2px;
    background: color-mix(in oklab, var(--status-running) 12%, transparent);
    color: var(--status-running);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .num {
    color: var(--color-muted);
  }

  .faint {
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }

  /* "blocked on #N" — semantic blocked token (red), as on the former list row. */
  .blocked-chip {
    padding: 1px 5px;
    border: 1px solid var(--status-blocked);
    border-radius: 2px;
    background: color-mix(in srgb, var(--status-blocked) 14%, transparent);
    color: var(--status-blocked);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .title-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .title {
    flex: 1;
    min-width: 0;
    margin: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-2xl);
    font-weight: 600;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }

  .more-btn {
    flex: none;
    padding: 0 8px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-lg);
    line-height: 1.4;
    cursor: pointer;
  }
  .more-btn:hover,
  .more-btn[aria-expanded="true"] {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .more-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .gh-link {
    align-self: flex-start;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    text-decoration: none;
  }
  .gh-link:hover {
    color: var(--color-amber);
    text-decoration: underline;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .more-btn {
      min-width: 44px;
      min-height: 44px;
    }
  }
</style>
