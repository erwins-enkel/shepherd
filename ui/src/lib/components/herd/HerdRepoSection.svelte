<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { HERD_STATUS_ORDER, type HerdStatus } from "../herd-status";
  import type { StageTag } from "../herd-repo-groups";
  import HerdGroup from "./HerdGroup.svelte";
  import type { HerdRowCtx } from "./HerdGroup.svelte";
  import { projectIcons } from "#lib/projectIcons.svelte.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { TooltipExplanation } from "#lib/tooltips/content.js";
  import { m } from "#lib/paraglide/messages.js";

  // One repo section of the herd's Repo layout (#4228): a one-line heading — collapse toggle
  // (chevron, project icon, name) then the repo's status counts — over its rows. A count sets
  // the GLOBAL status filter (no per-repo filter exists); a collapsed repo keeps its counts.
  let {
    name,
    iconPath,
    rows,
    aboveIds,
    counts,
    collapsed,
    ontoggle,
    onrevealsession,
    statusFilter,
    onstatusfilter,
    tagFor,
    ctx,
    touchTarget = false,
    flow = false,
  }: {
    name: string;
    iconPath: string | null;
    /** The rows rendered under this heading (epic/experiment members render in groups above). */
    rows: Session[];
    /** This repo's sessions the epic/experiment groups above render, in render order. */
    aboveIds: string[];
    /** Every listed session of the repo, rows and those above, by global status. */
    counts: Record<HerdStatus, number>;
    collapsed: boolean;
    ontoggle: () => void;
    /** Reveals + selects a row above (#4235); without it the note stays plain text. */
    onrevealsession?: (id: string) => void;
    statusFilter: HerdStatus | null;
    onstatusfilter?: (status: HerdStatus | null) => void;
    tagFor: (session: Session) => StageTag | null;
    ctx: HerdRowCtx;
    /** Phone or coarse pointer: 44px count targets. */
    touchTarget?: boolean;
    /** Phone flow: the heading is a ≥48px accordion row. */
    flow?: boolean;
  } = $props();

  const icon = $derived(iconPath ? projectIcons.iconFor(iconPath) : null);
  const shown = $derived(HERD_STATUS_ORDER.filter((s) => counts[s] > 0));
  const above = $derived(aboveIds.length);

  const aboveTip = $derived<TooltipExplanation>({
    title: m.herd_repo_above_tip_title({ count: above, repo: name }),
    summary: m.herd_repo_above_tip_summary(),
    sections: [{ label: m.herd_repo_count_tip_click_label(), text: m.herd_repo_above_tip_click() }],
  });

  const GLYPH: Record<HerdStatus, string> = { running: "●", idle: "◌", blocked: "!", merge: "●" };

  function labelOf(s: HerdStatus): string {
    if (s === "running") return m.topbar_working_label();
    if (s === "idle") return m.topbar_idle_label();
    if (s === "blocked") return m.topbar_blocked_label();
    return m.topbar_merge_label();
  }

  function summaryOf(s: HerdStatus): string {
    if (s === "running") return m.herd_repo_count_tip_running();
    if (s === "idle") return m.herd_repo_count_tip_idle();
    if (s === "blocked") return m.herd_repo_count_tip_blocked();
    return m.herd_repo_count_tip_merge();
  }

  function tipOf(s: HerdStatus): TooltipExplanation {
    const status = labelOf(s);
    return {
      title: m.herd_repo_count_tip_title({ count: counts[s], status, repo: name }),
      summary: summaryOf(s),
      sections: [
        {
          label: m.herd_repo_count_tip_click_label(),
          text:
            statusFilter === s
              ? m.herd_repo_count_tip_clear()
              : m.herd_repo_count_tip_filter({ status }),
        },
        { label: m.herd_repo_count_tip_scope_label(), text: m.herd_repo_count_tip_scope() },
      ],
    };
  }
</script>

{#snippet ident()}
  <span class="icon" aria-hidden="true">{icon ?? "▣"}</span>
  <span class="name">{name}</span>
  {#if above > 0 && !onrevealsession}
    <span class="above">{m.herd_repo_in_groups_above({ count: above })}</span>
  {/if}
{/snippet}

<div class="repo-head" class:touch={touchTarget} class:flow-row={flow}>
  {#if rows.length > 0}
    <button type="button" class="toggle" aria-expanded={!collapsed} onclick={ontoggle}>
      <span class="chev" class:collapsed aria-hidden="true">▾</span>
      {@render ident()}
    </button>
  {:else}
    <!-- every listed session of this repo renders in a group above: nothing to fold -->
    <span class="toggle static">
      <span class="chev" aria-hidden="true"></span>
      {@render ident()}
    </span>
  {/if}
  {#if above > 0 && onrevealsession}
    <!-- outside the toggle: a button can't nest in a button -->
    <button
      type="button"
      class="above jump"
      aria-label={m.herd_repo_above_aria({ count: above, repo: name })}
      use:statusTip={{ text: aboveTip, pinOnClick: false, stopClickPropagation: false }}
      onclick={() => onrevealsession(aboveIds[0])}
    >
      {m.herd_repo_in_groups_above({ count: above })}
    </button>
  {/if}
  <span class="counts">
    {#each shown as s (s)}
      <button
        type="button"
        class="count {s}"
        class:on={statusFilter === s}
        aria-pressed={statusFilter === s}
        aria-label={m.herd_repo_count_aria({ status: labelOf(s), count: counts[s], repo: name })}
        use:statusTip={{ text: tipOf(s), pinOnClick: false, stopClickPropagation: false }}
        onclick={() => onstatusfilter?.(statusFilter === s ? null : s)}
      >
        <span class="dot" aria-hidden="true">{GLYPH[s]}</span><span class="n">{counts[s]}</span>
      </button>
    {/each}
  </span>
</div>
{#if rows.length > 0 && !collapsed}
  <HerdGroup sessions={rows} {ctx} {tagFor} withPreview {touchTarget} />
{/if}

<style>
  .repo-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 6px 4px 4px 8px;
    margin-top: 6px;
    border-top: 1px solid var(--color-line);
  }
  .repo-head:first-child {
    margin-top: 0;
  }
  .repo-head.flow-row {
    min-height: 48px;
    padding-block: 0;
  }
  .toggle {
    display: flex;
    align-items: center;
    align-self: stretch;
    gap: 7px;
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-ink);
    font: inherit;
    text-align: left;
  }
  button.toggle {
    cursor: pointer;
  }
  button.toggle:hover {
    background: var(--color-hover);
  }
  .toggle:focus-visible,
  .count:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .chev {
    flex: none;
    width: 1ch;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    transition: transform 0.12s ease;
  }
  .chev.collapsed {
    transform: rotate(-90deg);
  }
  .icon {
    flex: none;
    font-size: var(--fs-base);
    line-height: 1;
  }
  /* the name gives way first: counts never shrink or wrap */
  .name {
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .above {
    min-width: 0;
    flex-shrink: 1000;
    font-size: var(--fs-meta);
    color: var(--color-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .above.jump {
    align-self: stretch;
    padding: 0 4px;
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
  }
  .above.jump:hover {
    color: var(--color-ink);
    text-decoration: underline;
  }
  .above.jump:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .counts {
    display: flex;
    align-items: center;
    flex: none;
    gap: 2px;
  }
  .count {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-height: 24px;
    min-width: 24px;
    padding: 0 4px;
    border: 1px solid transparent;
    background: none;
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    cursor: pointer;
  }
  .touch .count {
    min-height: 44px;
    min-width: 44px;
  }
  .count:hover {
    background: var(--color-inset);
  }
  .count.on {
    background: var(--color-inset);
    border-color: var(--color-line-bright);
  }
  .dot {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .running .dot {
    color: var(--color-amber);
  }
  .blocked .dot {
    color: var(--color-red);
  }
  .merge .dot {
    color: var(--color-green);
  }
</style>
