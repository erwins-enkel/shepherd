<script lang="ts">
  import { tick } from "svelte";
  import type { DrainStatus, Epic, EpicAutoFixOptionId } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { basename } from "#lib/basename.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { portal } from "#lib/portal.js";
  import { anchorPopover } from "#lib/floating-anchor.js";
  import { epicAutoFix } from "#lib/epic-auto-fix.svelte.js";
  import { haltSummary, issueList, startable } from "../epic-auto-fix";
  import EpicAutoFixChooser from "./EpicAutoFixChooser.svelte";

  // #3455: the epic row's halt line — the repo's sandbox, the epic's CLI or this host keeps the
  // epic from starting on its own. "Fix" opens the halt's chooser (#3454) beside the row: a small
  // anchored, non-modal popover on desktop (no scrim — exempt per
  // .claude/rules/ui-design-system.md), a modal sheet with the scrim on the phone. Both work on
  // the repo's shared auto-fix state, as the epic's run area does.
  let {
    repoPath,
    parent,
    epic = undefined,
    drain,
    mobile = false,
  }: {
    repoPath: string;
    parent: number;
    /** The epic's record — names the children a fix starts; absent while it loads. */
    epic?: Epic;
    /** The repo's drain, holding this epic at a sandbox, CLI or host gate. */
    drain: DrainStatus;
    /** Phone layout: the chooser opens as a bottom sheet. */
    mobile?: boolean;
  } = $props();

  $effect(() => epicAutoFix.watch(repoPath, drain));
  const blockers = $derived(epicAutoFix.blockers(repoPath, parent));
  // Until the model answers, the drain's own hold names the cause.
  const summary = $derived(
    haltSummary(blockers?.causes ?? [{ code: drain.reason ?? "", detail: drain.detail ?? "" }]),
  );
  // A model without causes: a fix just cleared the halt and the drain is catching up.
  const shown = $derived(!blockers || blockers.causes.length > 0);
  const toStart = $derived(epic ? startable(epic, drain.runSummary).starting : []);
  const repoName = $derived(basename(repoPath));

  const id = $props.id();
  let open = $state(false);
  let btn = $state<HTMLButtonElement>();
  let lineEl = $state<HTMLDivElement>();
  let pop = $state<HTMLDivElement>();

  function close(refocus: boolean) {
    open = false;
    if (refocus) void tick().then(() => btn?.focus());
  }

  async function apply(option: EpicAutoFixOptionId) {
    const list = btn?.closest<HTMLElement>('[role="listbox"]');
    if (!(await epicAutoFix.apply(repoPath, parent, option, toStart))) return;
    open = false;
    await tick();
    // The line goes once the halt is fixed, and Fix with it: the list keeps the focus then.
    if (btn?.isConnected) btn.focus();
    else list?.focus({ preventScroll: true });
  }

  // Desktop: show the popover in the top layer, under the halt line as the row's own width, and
  // start on the chosen way.
  $effect(() => {
    if (!open || mobile || !lineEl || !pop) return;
    try {
      pop.showPopover();
    } catch {
      return;
    }
    const stop = anchorPopover(lineEl, pop, 6, "bottom-start");
    (
      pop.querySelector<HTMLElement>("input:checked") ??
      pop.querySelector<HTMLElement>("input:not(:disabled)")
    )?.focus();
    return stop;
  });

  // Desktop: Esc closes back onto Fix; a press outside just closes. Attached a tick after
  // opening so the opening click doesn't count as outside.
  $effect(() => {
    if (!open || mobile) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close(true);
    }
    function onPointerdown(e: PointerEvent) {
      const target = e.target as Node;
      if (!pop?.contains(target) && !btn?.contains(target)) close(false);
    }
    const tid = setTimeout(() => {
      window.addEventListener("keydown", onKeydown);
      window.addEventListener("pointerdown", onPointerdown);
    }, 0);
    return () => {
      clearTimeout(tid);
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointerdown);
    };
  });
</script>

{#if shown}
  <div bind:this={lineEl} class="halt" data-epic-row-halt>
    <svg class="stop" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z" />
      <path d="M12 7.5v5.5M12 16.6h.01" />
    </svg>
    <span class="text"><span class="lead">{m.epic_row_halt_lead()}</span> {summary}</span>
    {#if blockers?.options.length}
      <!-- Inside the row's option: neither its click nor its keys may select the row or move
           the list. -->
      <button
        bind:this={btn}
        class="gbtn primary fix"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-fix` : undefined}
        onclick={(e) => {
          e.stopPropagation();
          if (open) close(false);
          else open = true;
        }}
        onkeydown={(e) => e.stopPropagation()}
        >{m.epic_row_fix()}{#if !mobile}<span aria-hidden="true"> ▾</span>{/if}</button
      >
    {/if}
  </div>

  {#if open && blockers}
    {#if mobile}
      <!-- eslint-disable-next-line svelte/no-static-element-interactions -- the scrim's only job
           is outside-tap dismissal; Escape and ✕ cover the keyboard path. -->
      <div class="scrim fix-scrim" use:portal onclick={() => close(true)} aria-hidden="true"></div>
      <div
        id={`${id}-fix`}
        class="fix-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        use:portal
        use:dialog={{ onclose: () => close(true) }}
      >
        <div class="grip" aria-hidden="true"></div>
        {@render head()}
        <div class="fix-body">
          <EpicAutoFixChooser
            {blockers}
            {repoName}
            applyLabel={toStart.length
              ? m.epic_autofix_apply_start({ issues: issueList(toStart) })
              : m.epic_autofix_apply()}
            busy={epicAutoFix.busy(repoPath)}
            onapply={apply}
            wide
            bind:picked={
              () => epicAutoFix.picked(repoPath, parent),
              (v) => epicAutoFix.pick(repoPath, parent, v)
            }
          />
        </div>
      </div>
    {:else}
      <!-- popover="manual": the top layer escapes the list's overflow; portaled out of the row so
           clicks and arrow keys inside never reach the row or the list. -->
      <div
        bind:this={pop}
        id={`${id}-fix`}
        class="fix-pop"
        role="dialog"
        aria-labelledby={`${id}-title`}
        popover="manual"
        use:portal
      >
        {@render head()}
        <EpicAutoFixChooser
          {blockers}
          {repoName}
          applyLabel={m.epic_autofix_apply()}
          busy={epicAutoFix.busy(repoPath)}
          onapply={apply}
          bind:picked={
            () => epicAutoFix.picked(repoPath, parent), (v) => epicAutoFix.pick(repoPath, parent, v)
          }
        >
          {#snippet extra()}
            <button class="gbtn" type="button" onclick={() => close(true)}
              >{m.common_cancel()}</button
            >
          {/snippet}
        </EpicAutoFixChooser>
      </div>
    {/if}
  {/if}
{/if}

{#snippet head()}
  <div class="fix-head">
    <span class="fix-title" id={`${id}-title`}>{m.epic_row_fix_title({ parent })}</span>
    <button class="close" type="button" aria-label={m.common_close()} onclick={() => close(true)}
      >✕</button
    >
  </div>
{/snippet}

<style>
  /* The row's third line: why nothing starts, and the way to fix it. */
  .halt {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    margin: 2px 0 0 24px;
    padding: 6px 8px;
    background: var(--wash-attention);
    border: 1px solid color-mix(in srgb, var(--color-red) 45%, var(--color-line));
    border-radius: 2px;
    cursor: default;
  }
  .stop {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: var(--color-red);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .text {
    flex: 1 1 170px;
    min-width: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
    overflow-wrap: anywhere;
  }
  /* Pulled toward the text colour so it keeps 4.5:1 on the red wash (as the halt card's chips). */
  .lead {
    color: color-mix(in srgb, var(--color-red) 80%, var(--color-ink-bright));
  }

  /* Canonical .gbtn recipe from /design-system (scoped copy, as in EpicRunControl). */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* On the red wash amber alone misses 4.5:1 in the light theme: pulled toward the text colour. */
  .gbtn.fix,
  .gbtn.fix:hover {
    flex: none;
    color: color-mix(in srgb, var(--color-amber) 80%, var(--color-ink-bright));
  }

  .fix-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fix-title {
    flex: 1;
    min-width: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
  }
  .close {
    flex: none;
    width: 24px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    cursor: pointer;
  }
  .close:hover,
  .close:focus-visible {
    outline: none;
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  /* Desktop: anchored, non-blocking. position:fixed + inset:auto + margin:0 so Floating UI's
     left/top place it (as IssueFilterPopover). */
  [popover].fix-pop {
    position: fixed;
    inset: auto;
    margin: 0;
    box-sizing: border-box;
    width: min(400px, calc(100vw - 16px));
    max-height: min(80vh, 560px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    color: var(--color-ink);
  }

  /* Phone: the rising bottom sheet (ReposSheet's recipe — the design system's sanctioned "sheet
     lift" shadow and 12px top radius) over the canonical scrim. */
  .fix-scrim {
    z-index: 60;
  }
  .fix-sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 61;
    box-sizing: border-box;
    max-height: 85dvh;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 10px 16px;
    padding-bottom: max(16px, env(safe-area-inset-bottom));
    background: var(--color-head);
    border-top: 1px solid var(--color-line-bright);
    border-radius: 12px 12px 0 0;
    box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.5);
    color: var(--color-ink);
  }
  .fix-sheet:focus-visible {
    outline: none;
  }
  @media (prefers-reduced-motion: no-preference) {
    .fix-sheet {
      animation: fix-sheet-rise 0.18s ease-out;
    }
  }
  @keyframes fix-sheet-rise {
    from {
      transform: translateY(12px);
      opacity: 0;
    }
  }
  .grip {
    flex: none;
    align-self: center;
    width: 36px;
    height: 3px;
    border-radius: 2px;
    background: var(--color-line-bright);
  }
  .fix-body {
    min-height: 0;
    overflow-y: auto;
  }
  .fix-sheet .fix-title {
    font-size: var(--fs-lg);
  }
  .fix-sheet .close {
    width: 44px;
    height: 44px;
    font-size: var(--fs-lg);
  }

  @media (max-width: 768px), (pointer: coarse) {
    .halt {
      margin-left: 38px;
    }
    .fix {
      min-height: 44px;
      padding: 2px 14px;
    }
  }
</style>
