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
  import IssueDetailHead from "./issues-panel/IssueDetailHead.svelte";
  import UpNextPreviewBody from "./UpNextPreviewBody.svelte";
  import UpNextPreviewFrame from "./UpNextPreviewFrame.svelte";
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

  // As many steers as fit sit inline after Start (in Settings order); once one doesn't, a ▾
  // joins Start and opens all of them. Clipped buttons stay laid out (visibility: hidden) so
  // every re-measure can read their widths. The ▾ only ever narrows the row, so showing it
  // can't make everything fit again — no flip-flop.
  let steerRow = $state<HTMLElement>();
  let fitCount = $state(Infinity);
  const overflow = $derived(fitCount < issueSteers.length);
  $effect(() => {
    const row = steerRow;
    void issueSteers; // re-measure when stepping to a row with other steers
    if (!row) return;
    const buttons = Array.from(row.querySelectorAll<HTMLElement>(".unp-steer"));
    const measure = () => {
      let n = 0;
      for (const b of buttons) {
        if (b.offsetLeft + b.offsetWidth > row.clientWidth) break;
        n++;
      }
      fitCount = n;
    };
    measure();
    // The buttons too: a late web font widens them without resizing the row. Measured on the
    // next frame: the ▾ a measure adds resizes the row, which inside the observer's own
    // delivery would trip "ResizeObserver loop completed with undelivered notifications".
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    for (const el of [row, ...buttons]) ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  });

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
    <div class="unp-actions">
      <span class="unp-start" bind:this={startGroup}>
        <button
          type="button"
          class="gbtn primary"
          class:split={overflow}
          bind:this={startBtn}
          disabled={starter.starting}
          onclick={(e) => starter.request([item], e.currentTarget)}>{m.upnext_start()}</button
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
      {#if issueSteers.length > 0}
        <div class="unp-steers" bind:this={steerRow}>
          <span class="unp-steers-label" class:clipped={fitCount === 0}
            >{m.upnext_preview_steers_label()}</span
          >
          {#each issueSteers as s, i (s.id)}
            <button
              type="button"
              class="gbtn unp-steer"
              class:clipped={i >= fitCount}
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
      <label class="unp-pick">
        <input
          type="checkbox"
          checked={upNextUi.selected.has(key)}
          onchange={() => upNextUi.toggle(key)}
        />
        <span>{m.upnext_preview_select()}</span>
      </label>
    </div>
    <UpNextPreviewBody {loader} unavailable={m.issuepeek_unavailable()} />
  {/if}
</UpNextPreviewFrame>

<UpNextStartPicker {starter} />
{#if menuOpen && item && startGroup}
  <UpNextSteerMenu
    anchor={startGroup}
    number={item.number}
    steers={issueSteers}
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
  /* Basis 0: the row takes what Start and the tick leave, and never wraps onto its own line. */
  .unp-steers {
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
  }
  .unp-steers-label {
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
</style>
