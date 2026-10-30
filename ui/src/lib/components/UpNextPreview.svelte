<script lang="ts">
  import { getUpNextBody } from "#lib/api.js";
  import { m } from "#lib/paraglide/messages.js";
  import type { Steer } from "#lib/types.js";
  import { steers } from "#lib/steers.svelte.js";
  import { repos } from "#lib/repos.svelte.js";
  import { steerAppliesToRepo } from "#lib/steer-scope.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import type { TooltipExplanation } from "#lib/tooltips/content.js";
  import { upNext } from "#lib/up-next.svelte.js";
  import { findUpNextItem, upNextKey, upNextUi } from "#lib/up-next-ui.svelte.js";
  import { UpNextStarter, type UpNextLaunchContext } from "#lib/up-next-start.svelte.js";
  import { LazyBody } from "#lib/lazy-body.svelte.js";
  import { quickStartChips, quickStartTip, type QuickStartChip } from "#lib/up-next-quick-start.js";
  import IssueDetailHead from "./issues-panel/IssueDetailHead.svelte";
  import UpNextPreviewBody from "./UpNextPreviewBody.svelte";
  import UpNextPreviewFrame from "./UpNextPreviewFrame.svelte";
  import UpNextQuickStartChip from "./UpNextQuickStartChip.svelte";
  import UpNextStartPicker from "./UpNextStartPicker.svelte";
  import UpNextSteerMenu from "./UpNextSteerMenu.svelte";

  // Reading view for the Up Next row whose title was clicked: the issue's head and rendered
  // description, with Start and the batch tick beside it — so the operator reads before
  // starting instead of leaving for GitHub. Desktop renders it in the main area beside the
  // rail panel; the phone swaps it in place of the list and passes `onback`.
  let {
    launchContext = null,
    onback = undefined,
  }: {
    launchContext?: UpNextLaunchContext | null;
    onback?: () => void;
  } = $props();

  const starter = new UpNextStarter(() => launchContext);
  const item = $derived(findUpNextItem(upNext.snapshot, upNextUi.previewKey));
  const key = $derived(item ? upNextKey(item) : null);
  const loader = new LazyBody(
    () => (item ? { repo: item.repoPath, number: item.issueRef.number } : null),
    getUpNextBody,
  );
  const tag = $derived(
    item?.kind !== "epic"
      ? null
      : item.epicParent
        ? m.issuedetail_epic_of({ parent: item.epicParent.number })
        : m.issuedetail_epic_tag(),
  );

  // Issue steers (Settings › Steers, "Show in: Backlog issues") for this row's repo, as on a
  // backlog issue. Not on an epic parent: a manual task there collides with the Epic Runner.
  const issueSteers = $derived(
    item && launchContext?.onquick && !(item.kind === "epic" && !item.epicParent)
      ? steers.list.filter((s) => s.onIssues && steerAppliesToRepo(s, repos.nameFor(item.repoPath)))
      : [],
  );

  // Quick-start chips (Settings › Coding CLI): one per CLI whose preset is on, on the Start row.
  const chips = $derived(
    quickStartChips({
      quickStarts: starter.quickStarts,
      diagnostics: starter.diagnostics,
      limits: starter.usageLimits,
      holdLikely: starter.holdLikely,
      holdPct: starter.holdPct,
      nowMs: starter.nowMs,
    }),
  );

  // As many chips / steers as fit sit inline (in Settings order); once one of either doesn't, a
  // ▾ joins Start and opens all of them. Clipped buttons stay laid out (visibility: hidden) so
  // every re-measure can read their widths. The ▾ only ever narrows the row, so showing it
  // can't make everything fit again — no flip-flop.
  let chipFit = $state(Infinity);
  let steerFit = $state(Infinity);
  const overflow = $derived(chipFit < chips.length || steerFit < issueSteers.length);

  /** Counts the leading `selector` buttons of `row` that fit its width. The buttons too are
   *  observed: a late web font widens them without resizing the row. Measured on the next
   *  frame: the ▾ a measure adds resizes the row, which inside the observer's own delivery
   *  would trip "ResizeObserver loop completed with undelivered notifications". */
  function fit(
    row: HTMLElement,
    opts: { selector: string; items: readonly unknown[]; onfit: (n: number) => void },
  ) {
    let o = opts;
    let frame = 0;
    const buttons = () => Array.from(row.querySelectorAll<HTMLElement>(o.selector));
    const measure = () => {
      let n = 0;
      for (const b of buttons()) {
        if (b.offsetLeft + b.offsetWidth > row.clientWidth) break;
        n++;
      }
      o.onfit(n);
    };
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    const observe = () => {
      ro.disconnect();
      for (const el of [row, ...buttons()]) ro.observe(el);
    };
    observe();
    measure();
    return {
      update(next: typeof opts) {
        o = next;
        observe();
        measure();
      },
      destroy() {
        cancelAnimationFrame(frame);
        ro.disconnect();
      },
    };
  }

  let startGroup = $state<HTMLElement>();
  let startBtn = $state<HTMLButtonElement>();
  let menuOpen = $state(false);
  $effect(() => {
    if (!overflow || !item) menuOpen = false;
  });

  function startWith(steer: Steer) {
    menuOpen = false;
    if (item) void starter.startWithSteer(item, steer);
  }

  function startQuick(chip: QuickStartChip) {
    menuOpen = false;
    if (item && chip.state !== "blocked") void starter.startQuick(item, chip.provider, chip.preset);
  }
  const chipTip = (chip: QuickStartChip, number: number) =>
    quickStartTip(chip, number, starter.usageLimits, starter.nowMs);

  function steerTip(s: Steer, number: number): TooltipExplanation {
    const prompt = s.text.trim();
    return {
      title: s.label,
      summary: m.upnext_preview_steer_tip_summary({ number }),
      sections: [
        {
          label: m.upnext_preview_steer_tip_prompt(),
          text: prompt.length > 280 ? `${prompt.slice(0, 280)}…` : prompt,
        },
        { label: m.upnext_preview_steer_tip_cli(), text: m.upnext_preview_steer_tip_cli_body() },
      ],
    };
  }

  // Esc closes the preview (UpNextPreviewFrame) — unless the CLI picker or the steer menu has it.
  function onescape(): boolean {
    if (starter.picker) return true;
    if (!menuOpen) return false;
    menuOpen = false;
    return true;
  }
</script>

<UpNextPreviewFrame
  label={m.upnext_preview_aria()}
  prevLabel={m.upnext_preview_prev()}
  nextLabel={m.upnext_preview_next()}
  order={upNextUi.order}
  current={item ? key : null}
  {onback}
  {onescape}
>
  {#if item && key}
    <IssueDetailHead
      {tag}
      number={item.number}
      title={item.title}
      url={item.url}
      labels={item.labels}
      labelColors={item.labelColors}
      author={item.author ?? loader.author ?? undefined}
      createdAt={item.createdAt}
    />
    <div class="unp-actions" class:two-line={chips.length > 0}>
      <div class="unp-line">
        <span class="unp-start" bind:this={startGroup}>
          <button
            type="button"
            class="gbtn primary"
            class:split={overflow}
            bind:this={startBtn}
            disabled={starter.starting}
            onclick={(e) => starter.request([item], e.currentTarget)}
            >{chips.length > 0 ? m.upnext_start_ellipsis() : m.upnext_start()}</button
          >
          {#if overflow}
            <button
              type="button"
              class="gbtn primary unp-more"
              class:open={menuOpen}
              aria-label={m.upnext_preview_more()}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={starter.starting}
              onclick={() => (menuOpen = !menuOpen)}>▾</button
            >
          {/if}
        </span>
        {#if chips.length > 0}
          <div
            class="unp-fit unp-chips"
            use:fit={{
              selector: ".unp-chip",
              items: chips,
              onfit: (n) => (chipFit = n),
            }}
          >
            <span class="unp-fit-label" class:clipped={chipFit === 0}
              >{m.upnext_quickstart_label()}</span
            >
            {#each chips as chip, i (chip.provider)}
              <UpNextQuickStartChip
                {chip}
                tip={chipTip(chip, item.number)}
                nowMs={starter.nowMs}
                starting={starter.starting}
                onstart={() => startQuick(chip)}
                clipped={i >= chipFit}
              />
            {/each}
          </div>
        {/if}
        {#if chips.length === 0}
          {@render steerRow()}
          {@render pick()}
        {/if}
      </div>
      {#if chips.length > 0}
        <div class="unp-line">
          {@render steerRow()}
          {@render pick()}
        </div>
      {/if}
    </div>
    <UpNextPreviewBody {loader} unavailable={m.issuepeek_unavailable()} />
  {/if}
</UpNextPreviewFrame>

{#snippet steerRow()}
  {#if item && key && issueSteers.length > 0}
    <div
      class="unp-fit unp-steers"
      use:fit={{ selector: ".unp-steer", items: issueSteers, onfit: (n) => (steerFit = n) }}
    >
      <span class="unp-fit-label" class:clipped={steerFit === 0}
        >{m.upnext_preview_steers_label()}</span
      >
      {#each issueSteers as s, i (s.id)}
        <button
          type="button"
          class="gbtn unp-steer"
          class:clipped={i >= steerFit}
          aria-label={m.issuespanel_action_aria({ label: s.label })}
          disabled={starter.starting}
          use:statusTip={{
            text: steerTip(s, item.number),
            wide: true,
            stopClickPropagation: false,
            pinOnClick: false,
          }}
          onclick={() => startWith(s)}
          ><span class="unp-steer-icon" class:glyph={!s.emoji} aria-hidden="true"
            >{s.emoji || "⇥"}</span
          ><span>{s.label}</span></button
        >
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet pick()}
  {#if key}
    <label class="unp-pick">
      <input
        type="checkbox"
        checked={upNextUi.selected.has(key)}
        onchange={() => upNextUi.toggle(key)}
      />
      <span>{m.upnext_preview_select()}</span>
    </label>
  {/if}
{/snippet}

<UpNextStartPicker {starter} />
{#if menuOpen && item && startGroup}
  <UpNextSteerMenu
    anchor={startGroup}
    number={item.number}
    steers={issueSteers}
    startLabel={chips.length > 0 ? m.upnext_start_ellipsis() : undefined}
    startHint={chips.length > 0 ? m.upnext_quickstart_menu_start_hint() : undefined}
    quickStarts={chips}
    onquick={startQuick}
    nowMs={starter.nowMs}
    onmanagequickstarts={launchContext?.onmanagequickstarts
      ? () => {
          menuOpen = false;
          launchContext?.onmanagequickstarts?.();
        }
      : undefined}
    onstart={() => {
      menuOpen = false;
      if (startBtn) starter.request([item], startBtn);
    }}
    onsteer={startWith}
    onmanage={launchContext?.onmanagesteers
      ? () => {
          menuOpen = false;
          launchContext?.onmanagesteers?.();
        }
      : undefined}
    onclose={() => (menuOpen = false)}
  />
{/if}

<style>
  /* One line of the action row: Start (+ chips) on the first, steers + tick on the second. */
  .two-line {
    flex-direction: column;
    align-items: stretch;
  }
  .unp-line {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  /* Basis 0: the row takes what Start and the tick leave, and never wraps onto its own line. */
  .unp-fit {
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
  }
  .unp-fit-label {
    flex: none;
    padding-left: 10px;
    border-left: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .gbtn.unp-steer {
    flex: none;
    font-weight: normal;
    letter-spacing: 0.04em;
    white-space: nowrap;
    color: var(--color-ink);
    border-color: var(--color-line-bright);
  }
  .gbtn.unp-steer:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .unp-line > :global(.unp-pick) {
    margin-left: auto;
  }
  .unp-steer-icon {
    line-height: 1;
  }
  .unp-steer-icon.glyph {
    color: var(--color-muted);
  }
  /* Out of view and out of the tab order, but still measured. */
  .clipped {
    visibility: hidden;
  }

  /* Phone: Start spans the row and chips sit two to a row (so none is clipped). Steers that
     don't fit still fold into the ▾, as before. */
  @media (max-width: 768px), (pointer: coarse) {
    .unp-line {
      flex-wrap: wrap;
    }
    .unp-line > :global(.unp-start) {
      flex: 1 0 100%;
    }
    .unp-line > :global(.unp-start > :first-child) {
      flex: 1;
      justify-content: center;
      min-height: 44px;
    }
    .unp-chips {
      flex: 1 0 100%;
      display: grid;
      grid-template-columns: 1fr 1fr;
      overflow: visible;
    }
    .unp-chips .unp-fit-label {
      grid-column: 1 / -1;
      padding-left: 0;
      border-left: 0;
    }
  }
</style>
