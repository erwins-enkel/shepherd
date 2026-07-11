<script lang="ts">
  import type { Session } from "$lib/types";
  import { planGates } from "$lib/reviews.svelte";
  import { composePlanGateTooltip, planGateChip, planGateStalledNow } from "./plan-gate-badge";
  import PlanPanel from "./PlanPanel.svelte";
  import PlanGateMenu from "./PlanGateMenu.svelte";
  import { m } from "$lib/paraglide/messages";
  import { replySession, reviewPlan } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { clock } from "$lib/now.svelte";

  // allowView (default true): whether to surface the read-only "view"/PLAN chip during
  // execution. The dense session-list surface (UnitRow) passes false so this chip
  // lives only in the per-session top bar (issue #809); see plan-gate-badge.ts.
  let {
    session,
    allowView = true,
    pulseReady = false,
    labelOverride = null,
    fallbackLabel = null,
    fallbackTitle = null,
    openPanelTick = 0,
  }: {
    session: Session;
    allowView?: boolean;
    pulseReady?: boolean;
    labelOverride?: string | null;
    fallbackLabel?: string | null;
    fallbackTitle?: string | null;
    // monotonic tick bumped by the row's "Answer" hold CTA → opens PlanPanel directly
    openPanelTick?: number;
  } = $props();

  const gate = $derived(planGates.map[session.id]);
  const reviewing = $derived(planGates.isReviewing(session.id));
  const chip = $derived(planGateChip(session, gate, reviewing, { allowView }));
  const pulseClass = $derived(pulseReady && chip.kind === "ready" ? " pg-pulse-ready" : "");
  const stalled = $derived(planGateStalledNow(session, gate, reviewing, clock.current));
  const stalledActionsVisible = $derived(stalled);

  let open = $state(false);
  let btnEl = $state<HTMLButtonElement>();
  let menu = $state<{ anchor: DOMRect; autoFocus: boolean } | null>(null);
  let busy = $state<"send" | "review" | null>(null);

  // The row's "Answer" hold CTA bumps openPanelTick → open PlanPanel directly (mirrors
  // Viewport's openPreviewTick/lastPreviewTick idiom). Bypasses toggle(), which would open
  // PlanGateMenu instead of the panel when the chip is stalled.
  let lastPanelTick = 0;
  $effect(() => {
    if (openPanelTick > 0 && openPanelTick !== lastPanelTick) {
      open = true; // open PlanPanel directly — NOT toggle()
    }
    lastPanelTick = openPanelTick;
  });

  const title = $derived(
    composePlanGateTooltip(
      chip,
      gate,
      {
        fallback: m.plangate_title(),
        planning: m.plangate_tip_planning(),
        reviewing: m.plangate_tip_reviewing(),
        changes: m.plangate_tip_changes(),
        changesStalled: m.plangate_tip_changes_stalled(),
        ready: m.plangate_tip_ready(),
        error: m.plangate_tip_error(),
        view: m.plangate_tip_view(),
      },
      { stalledActionsVisible },
    ),
  );

  function closeMenu() {
    menu = null;
  }

  function openMenu(autoFocus: boolean) {
    if (!stalled || !btnEl) return;
    menu = { anchor: btnEl.getBoundingClientRect(), autoFocus };
  }

  function toggle(e: MouseEvent) {
    e.stopPropagation();
    if (stalled) {
      if (menu) closeMenu();
      else openMenu(true);
      return;
    }
    open = true;
  }

  function findingsText(): string {
    const findings = gate?.findings ?? [];
    if (findings.length > 0) return findings.map((f, i) => `${i + 1}. ${f}`).join("\n");
    const body = gate?.body?.trim();
    return body ? body : m.plangate_repair_no_findings();
  }

  function repairDraft(): string {
    return m.plangate_repair_steer({ findings: findingsText() });
  }

  async function sendChanges(text = repairDraft()) {
    if (!gate || busy) return;
    const draft = text.trim();
    if (!draft) return;
    busy = "send";
    try {
      await replySession(session.id, draft);
      closeMenu();
      toasts.info(m.plangate_repair_sent(), { key: `plan-repair:${session.id}` });
    } catch {
      toasts.info(m.plangate_repair_send_failed(), {
        sticky: true,
        alert: true,
        key: `plan-repair:${session.id}`,
        action: { label: m.common_retry(), run: () => sendChanges(draft) },
      });
    } finally {
      busy = null;
    }
  }

  async function reviewAgain() {
    if (busy || reviewing) return;
    busy = "review";
    try {
      const status = await reviewPlan(session.id);
      if (status === "started") toasts.info(m.plangate_review_started());
      else if (status === "plan-unavailable" && !planGates.isReviewing(session.id))
        toasts.info(m.gitrail_review_plan_unavailable());
      else if (status === "skipped" && !planGates.isReviewing(session.id))
        toasts.info(m.plangate_review_skipped_stalled());
      else if (status === "error")
        toasts.info(m.gitrail_review_plan_failed(), {
          alert: true,
          key: `review-plan:${session.id}`,
        });
      if (status !== "error") closeMenu();
    } catch {
      toasts.info(m.gitrail_review_plan_failed(), {
        alert: true,
        key: `review-plan:${session.id}`,
      });
    } finally {
      busy = null;
    }
  }
</script>

{#if chip.kind !== "none"}
  <button
    bind:this={btnEl}
    type="button"
    class="pg-badge pg-{chip.kind}{pulseClass}"
    class:pg-stalled={stalled}
    {title}
    aria-haspopup={stalled ? "menu" : undefined}
    aria-expanded={stalled ? menu !== null : undefined}
    onclick={toggle}
    oncontextmenu={(e) => {
      if (!stalled) return;
      e.preventDefault();
      e.stopPropagation();
      openMenu(true);
    }}
  >
    {#if chip.kind === "reviewing"}
      <span class="rev-dot" aria-hidden="true"></span>{m.plangate_reviewing()}
    {:else if labelOverride}
      {labelOverride}
    {:else if chip.kind === "changes"}
      {m.plangate_changes({ round: chip.round, cap: chip.cap })}
    {:else if chip.kind === "ready"}
      {m.plangate_ready()}
    {:else if chip.kind === "error"}
      {m.plangate_error()}
    {:else if chip.kind === "view"}
      {m.plangate_view()}
    {:else}
      {m.plangate_planning()}
    {/if}
  </button>
{:else if fallbackLabel}
  <span
    class="pg-badge pg-changes pg-stalled pg-fallback"
    title={fallbackTitle ?? fallbackLabel}
    role="img"
    aria-label={fallbackTitle ?? fallbackLabel}>{fallbackLabel}</span
  >
{/if}

{#if menu}
  <PlanGateMenu
    anchor={menu.anchor}
    opener={btnEl}
    busy={busy !== null}
    autoFocus={menu.autoFocus}
    draftText={repairDraft()}
    onopenplan={() => {
      closeMenu();
      open = true;
    }}
    onsendchanges={sendChanges}
    onreview={reviewAgain}
    onclose={closeMenu}
  />
{/if}

{#if open}
  <PlanPanel {session} onclose={() => (open = false)} />
{/if}

<style>
  .pg-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: nowrap;
    color: var(--color-muted);
    background: transparent;
    font-family: inherit;
    cursor: pointer;
  }
  .pg-badge:hover {
    border-color: var(--color-line-bright);
  }
  .pg-changes {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .pg-stalled {
    background: color-mix(in srgb, var(--color-amber) 8%, transparent);
  }
  .pg-fallback {
    display: inline-block;
    cursor: default;
  }
  .pg-ready {
    border-color: var(--color-green);
    color: var(--color-green);
    font-weight: 600;
  }
  .pg-pulse-ready {
    position: relative;
    background: color-mix(in srgb, var(--color-green) 8%, transparent);
  }
  .pg-pulse-ready::after {
    content: "";
    position: absolute;
    inset: -3px;
    border: 1px solid color-mix(in srgb, var(--color-green) 45%, transparent);
    border-radius: 4px;
    pointer-events: none;
    opacity: 0;
    transform: scale(0.96);
    animation: pg-ready-pulse 2s ease-out infinite;
  }
  .pg-pulse-ready:hover::after,
  .pg-pulse-ready:focus-visible::after {
    animation: none;
    opacity: 0;
  }
  .pg-error {
    color: var(--color-faint);
  }
  /* read-only re-open of the signed-off plan during execution (issue #809). Lives only in
     the per-session top bar (the dense list cards opt out via allowView=false), so it can
     afford to read as a real control rather than a whisper: legible ink + a visible resting
     border. Stays NEUTRAL — green is reserved for READY, amber for in-flight; a parked,
     read-only plan is passive, so it must not borrow a semantic hue. */
  .pg-view {
    color: var(--color-ink);
    border-color: var(--color-line-bright);
    font-weight: 500;
  }
  .pg-view:hover {
    color: var(--color-ink-bright);
  }
  /* plan reviewer running now: amber outline + pulsing dot (mirrors CriticBadge) */
  .pg-reviewing {
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
    animation: pg-pulse 1.1s ease-in-out infinite !important;
  }
  @keyframes pg-pulse {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }
  @keyframes pg-ready-pulse {
    0% {
      opacity: 0.48;
      transform: scale(0.96);
    }
    70%,
    100% {
      opacity: 0;
      transform: scale(1.18);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pg-pulse-ready::after {
      animation: none;
      opacity: 0;
    }
  }
</style>
