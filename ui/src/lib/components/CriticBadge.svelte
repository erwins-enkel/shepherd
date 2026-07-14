<script lang="ts">
  import { reviews } from "$lib/reviews.svelte";
  import { criticChip, addressRoundInfo } from "./critic-badge";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";
  import { statusTip } from "$lib/actions/statusTip.svelte";
  import { firstSafeHttpUrl } from "$lib/url";
  import { anchorPopover } from "$lib/floating-anchor";

  // `tip` (Herd card only): swap the native title for the styled tooltip, and —
  // when a safe PR URL resolves — offer an Open-PR click-pinned dialog. `prUrl`
  // is the git.url fallback; the verdict's own url is preferred.
  let {
    sessionId,
    tip = false,
    prUrl = undefined,
  }: { sessionId: string; tip?: boolean; prUrl?: string } = $props();

  const reviewing = $derived(reviews.isReviewing(sessionId));
  const verdict = $derived(reviews.map[sessionId]);
  const chip = $derived(criticChip(verdict, reviewing));
  const round = $derived(addressRoundInfo(verdict, clock.current));
  const activity = $derived(reviews.activityFor(sessionId));

  type CriticView = { cls: string; label: string; title: string; dot: boolean };

  // Streak label/title split out so the `view` dispatcher below stays under the
  // complexity gate (the round branch carried most of the nested ternaries).
  function roundView(r: NonNullable<typeof round>): CriticView {
    const label =
      r.status === "stalled"
        ? m.criticbadge_stalled()
        : r.status === "final"
          ? m.criticbadge_final()
          : m.criticbadge_round({ round: r.round, cap: r.cap });
    const title =
      r.status === "stalled"
        ? m.criticbadge_stalled_title({ cap: r.cap })
        : r.status === "final"
          ? m.criticbadge_final_title()
          : m.criticbadge_round_title({ round: r.round, cap: r.cap });
    return {
      cls: `streak-${r.status}${reviewing ? " critic-reviewing" : ""}`,
      label,
      title,
      dot: reviewing,
    };
  }

  function reviewingView(): CriticView {
    return {
      cls: "critic-reviewing",
      label: m.criticbadge_reviewing(),
      title: activity
        ? m.criticbadge_reviewing_activity_title({ activity })
        : m.criticbadge_reviewing_title(),
      dot: true,
    };
  }

  // Which visual state renders, and its class / label / tooltip text / dot.
  // A STALLED streak yields to the reviewing view while the critic is actually re-reviewing: a
  // stall is a claim about a run that ended, and an in-flight run supersedes it. Same rule the
  // plan gate already applies (plan-gate-badge.ts: `if (reviewing)` precedes the stall branches;
  // canShowPlanStallActions requires !reviewing) and the one criticChip states for plain verdicts.
  // It also stops a STALE paint: forceReview persists a streak reset (addressRound: 0) but emits no
  // onChange until the new verdict lands, so during a forced re-review this cached verdict is the
  // last surface still claiming a stall the server already cleared. round/final keep their counter
  // — it is not stale mid-streak, and the number is the useful thing to show.
  const view = $derived.by((): CriticView | null => {
    if (round && !(round.status === "stalled" && reviewing)) return roundView(round);
    if (chip.kind === "reviewing") return reviewingView();
    if (chip.kind === "verdict")
      return {
        cls: `critic-${chip.decision}`,
        label: chip.label,
        title: verdict!.summary || m.criticbadge_title(),
        dot: false,
      };
    return null;
  });

  // Prefer the verdict's own PR url; fall back to git.url. Only a safe http(s) URL
  // enables the dialog — otherwise the chip is explanation-only.
  const openPrUrl = $derived(tip ? firstSafeHttpUrl(verdict?.url, prUrl) : null);

  // Dual-surface state for the actionable case — only one of tip / dialog is ever open.
  let surface = $state<"none" | "tip" | "dialog">("none");
  let btnEl = $state<HTMLButtonElement | null>(null);
  let tipEl = $state<HTMLElement | null>(null);
  let dialogEl = $state<HTMLElement | null>(null);
  let linkEl = $state<HTMLAnchorElement | null>(null);
  const dialogId = $props.id();

  // Show / anchor whichever surface is active.
  $effect(() => {
    const el = surface === "tip" ? tipEl : surface === "dialog" ? dialogEl : null;
    if (!btnEl || !el) return;
    try {
      el.showPopover();
    } catch {
      return;
    }
    if (surface === "dialog") linkEl?.focus();
    return anchorPopover(btnEl, el, 6);
  });

  // Dismiss on Esc / outside pointerdown / scroll / resize; return focus to the chip.
  $effect(() => {
    if (surface === "none") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      if (btnEl?.contains(t) || tipEl?.contains(t) || dialogEl?.contains(t)) return;
      close();
    }
    function onScroll() {
      close();
    }
    const tid = setTimeout(() => {
      window.addEventListener("keydown", onKey);
      window.addEventListener("pointerdown", onDown, true);
      window.addEventListener("scroll", onScroll, { capture: true, passive: true });
      window.addEventListener("resize", onScroll, { passive: true });
    }, 0);
    return () => {
      clearTimeout(tid);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  });

  function close() {
    if (surface === "dialog") btnEl?.focus();
    surface = "none";
  }
  function onEnter(e: PointerEvent) {
    if (e.pointerType === "touch" || surface === "dialog") return;
    surface = "tip";
  }
  function onLeave(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    if (surface === "tip") surface = "none";
  }
  function onFocus() {
    if (surface !== "dialog") surface = "tip";
  }
  function onBlur() {
    if (surface === "tip") surface = "none";
  }
  function onClick(e: MouseEvent) {
    e.stopPropagation();
    surface = "dialog"; // real activation → the click-pinned dialog with the link
  }
</script>

{#if view}
  {#snippet content()}
    {#if view.dot}<span class="rev-dot" aria-hidden="true"></span>{/if}{view.label}
  {/snippet}

  {#if !tip}
    <span class="critic-badge {view.cls}" title={view.title}>{@render content()}</span>
  {:else if !openPrUrl}
    <span
      class="critic-badge {view.cls}"
      role="img"
      aria-label={view.label}
      use:statusTip={{ text: view.title }}>{@render content()}</span
    >
  {:else}
    <!-- Actionable: hover shows the explanation (role=tooltip), click opens a
         click-pinned role=dialog with the explanation + Open PR link. -->
    <button
      bind:this={btnEl}
      type="button"
      class="critic-badge critic-trigger {view.cls}"
      aria-label={view.label}
      aria-haspopup="dialog"
      aria-expanded={surface === "dialog"}
      aria-controls={surface === "dialog" ? dialogId : undefined}
      onpointerenter={onEnter}
      onpointerleave={onLeave}
      onfocus={onFocus}
      onblur={onBlur}
      onclick={onClick}>{@render content()}</button
    >
    <div class="status-tip" role="tooltip" popover="manual" bind:this={tipEl}>{view.title}</div>
    <div
      id={dialogId}
      class="status-tip-dialog"
      role="dialog"
      aria-label={view.label}
      popover="manual"
      bind:this={dialogEl}
    >
      <span>{view.title}</span>
      <!-- eslint-disable svelte/no-navigation-without-resolve -- external, validated http(s) PR URL -->
      <a
        bind:this={linkEl}
        class="status-tip-action"
        href={openPrUrl}
        target="_blank"
        rel="noopener noreferrer"
        onclick={(e) => {
          e.stopPropagation();
          close();
        }}>{m.criticbadge_open_pr()} ↗</a
      >
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    </div>
  {/if}
{/if}

<style>
  .critic-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: nowrap;
    color: var(--color-muted);
  }
  /* Button variant reset (mirrors PrBadge's .as-button) for the actionable trigger. */
  .critic-trigger {
    position: relative;
    z-index: 1;
    appearance: none;
    margin: 0;
    font-family: inherit;
    line-height: inherit;
    background: transparent;
    cursor: pointer;
  }
  .critic-trigger:hover {
    background: var(--color-hover);
  }
  .critic-trigger:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .critic-changes_requested {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .critic-commented {
    color: var(--color-blue);
  }
  .critic-error {
    color: var(--color-faint);
  }
  /* critic actively reviewing: amber outline + pulsing dot (mirrors GitRail) */
  .critic-reviewing {
    border-color: var(--color-amber);
    color: var(--color-amber);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .rev-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: rev-pulse 1.1s ease-in-out infinite !important;
  }
  @keyframes rev-pulse {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }
  /* auto-address streak label that takes over the whole pill. hue = severity (round amber → final
     warn → stalled blocked; climbs with the ladder); the amber .rev-dot reports the orthogonal fact
     that the critic is re-reviewing RIGHT NOW.
     .streak-stalled never co-occurs with .critic-reviewing: the `view` dispatcher hands a stalled
     streak to the REVIEWING pill while a re-review is in flight, so a .rev-dot inside a stalled pill
     is unreachable. Only round/final can pair the dot with their hue. That is also why the dot is
     not simply recolored to follow currentColor: a red pill would then pulse a RED dot, and
     DESIGN.md forbids a haloed/pulsing subordinate red (the loudest red belongs to the
     blocked-agent pip — Four-Light Rule). Yielding the pill, not tinting the dot, is the fix.
     The invariant: no streak state may show a border hue that CONTRADICTS its text hue. So any
     state whose text is NOT amber must also claim the border — .critic-reviewing (0,1,0) sets an
     amber border, and a state that recolored only its text would let that amber leak through
     underneath (exactly how FINAL REVIEW came to render faint-grey inside an orange border).
     streak-round is the one state that needs no border-color: its text IS amber, so it agrees with
     the reviewing border when re-reviewing, and at rest it keeps the neutral --color-line hairline
     every badge carries — a neutral hairline is not a competing hue, so there is nothing to
     contradict. The compound selectors (.critic-badge.streak-*, 0,2,0) beat .critic-reviewing by
     specificity rather than source order — robust against stylesheet reordering. */
  .critic-badge.streak-round {
    color: var(--color-amber);
  }
  /* final allowed round in flight — caution: last chance before the streak stalls */
  .critic-badge.streak-final {
    color: var(--status-warn);
    border-color: var(--status-warn);
  }
  /* auto-address gave up at the cap — blocked, needs a human. Subordinate red: text + border
     only, never a halo/pulse/wash — the blocked-agent pip stays the loudest red (Four-Light Rule). */
  .critic-badge.streak-stalled {
    color: var(--status-blocked);
    font-weight: 600;
    border-color: var(--status-blocked);
  }
</style>
