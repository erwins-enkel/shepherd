<script lang="ts">
  import type { Session, GitState } from "$lib/types";
  import { elapsed, STATUS_COLOR, statusLabel } from "$lib/format";
  import StatusPip from "./StatusPip.svelte";
  import PrBadge from "./PrBadge.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";

  let {
    session,
    selected,
    nowMs,
    onselect,
    git,
  }: {
    session: Session;
    selected: boolean;
    nowMs: number;
    onselect: (id: string) => void;
    git?: GitState;
  } = $props();

  // split "TASK-07" into the constant stem ("TASK-") and disambiguating number ("07")
  // so the stem can collapse on a cramped sidebar, leaving the unit name room to breathe
  const desigParts = $derived(session.desig.match(/^(.*?)(\d+)$/));
  const desigStem = $derived(desigParts?.[1] ?? "");
  const desigNum = $derived(desigParts?.[2] ?? session.desig);

  // repo the unit works in — the last path segment of its repoPath (e.g. "community-map")
  const repoName = $derived(session.repoPath.split("/").filter(Boolean).at(-1) ?? session.repoPath);
  const repoIcon = $derived(projectIcons.iconFor(session.repoPath));
</script>

<button
  class="unit"
  class:sel={selected}
  style="--rule:{STATUS_COLOR[session.status]}"
  onclick={() => onselect(session.id)}
  type="button"
>
  <div class="pip-col">
    <StatusPip status={session.status} />
  </div>

  <div class="u-main">
    <div class="u-top">
      <span class="desig micro"><span class="desig-stem">{desigStem}</span>{desigNum}</span>
      <span class="name">{session.name}</span>
    </div>
    <div class="u-repo" title={session.repoPath}>
      <span class="repo-glyph" class:emoji={repoIcon} aria-hidden="true">{repoIcon ?? "▣"}</span
      >{repoName}
    </div>
    <div class="u-sub">
      {session.prompt}
      {#if session.status === "running"}
        <span class="car">▏</span>
      {/if}
    </div>
  </div>

  <div class="u-right">
    <PrBadge {git} />
    <span class="badge">{statusLabel(session.status)}</span>
    <span class="elapsed">{elapsed(session.createdAt, nowMs)}</span>
    <span class="meta">{session.herdrSession || "—"}</span>
  </div>
</button>

<style>
  .unit {
    position: relative;
    display: grid;
    grid-template-columns: 14px 1fr auto;
    gap: 12px;
    align-items: start;
    padding: 11px 13px 11px 14px;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    width: 100%;
  }

  :global(.unit + .unit) {
    margin-top: 2px;
  }

  .unit::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 2px;
    background: var(--rule, var(--color-faint));
  }

  .unit:hover {
    border-color: var(--color-line);
    background: var(--color-hover);
  }

  .unit.sel {
    border-color: var(--color-line-bright);
    background:
      radial-gradient(
        120% 140% at 0% 50%,
        color-mix(in srgb, var(--rule) 12%, transparent),
        transparent 70%
      ),
      var(--color-sel);
  }

  /* bracket corners on selected */
  .unit.sel::after {
    content: "";
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
    border-left: 0;
    border-top: 0;
  }

  .pip-col {
    display: flex;
    align-items: flex-start;
    padding-top: 5px;
  }

  .u-main {
    min-width: 0;
  }

  .u-top {
    display: flex;
    align-items: baseline;
    gap: 0;
    min-width: 0;
  }

  .micro {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .desig {
    margin-right: 9px;
    flex-shrink: 0;
  }

  .name {
    color: var(--color-ink-bright);
    font-weight: 500;
    letter-spacing: 0.04em;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .u-repo {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 3px;
    color: var(--color-ink);
    font-size: 11.5px;
    letter-spacing: 0.04em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    max-width: 34ch;
  }
  .repo-glyph {
    color: var(--color-amber);
    font-size: 10px;
    flex-shrink: 0;
  }
  .repo-glyph.emoji {
    font-size: 12px;
  }

  .u-sub {
    color: var(--color-muted);
    margin-top: 3px;
    font-size: 12px;
    line-height: 1.35;
    /* wrap to a 2nd line — fills the vertical space the right column
       (badge / elapsed / meta) already occupies, then ellipsis */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    max-width: 34ch;
  }

  .car {
    color: var(--color-amber);
    animation: blink 1.1s steps(1) infinite;
  }

  .u-right {
    text-align: right;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-end;
    flex-shrink: 0;
  }

  .badge {
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 2px 7px;
    border: 1px solid var(--rule);
    color: var(--rule);
    border-radius: 2px;
    white-space: nowrap;
  }

  .elapsed {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.08em;
  }

  .meta {
    color: var(--color-muted);
    font-size: 11.5px;
  }

  /* cramped sidebar (compact touch layout, narrow phones): drop the constant
     "TASK-" stem and keep just the number, handing the reclaimed width to the
     name. The wide desktop sidebar (>=300px) stays above this threshold. */
  @container herd (max-width: 270px) {
    .desig-stem {
      display: none;
    }
  }

  @media (max-width: 768px) {
    .unit {
      min-height: 44px;
    }
  }
</style>
