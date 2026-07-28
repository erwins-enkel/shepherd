<script lang="ts">
  // #1944: the surface for a REFUSED critic spawn.
  //
  // Why this exists separately from the pip adornment on CriticBadge: a refusal means there is NO
  // review of the current head. When the session has no prior verdict at all, `criticChip` returns
  // `{kind:"none"}`, CriticBadge's `view` is null, and its whole template is gated on `{#if view}`
  // — so the pip had nothing to attach to and a refused FIRST review was exactly as silent as the
  // E2BIG this PR fixes. Worse, `headAlreadySettled` then suppresses re-attempts for that head, so
  // there was no way back either.
  //
  // So a refusal gets its own chip rather than an adornment, and the chip carries the Retry that
  // clears the notice + its suppression key. A `clamped` notice keeps the pip instead: there IS a
  // verdict there, it is just formed on a truncated prompt.
  //
  // Self-guarding (renders nothing without a failed notice) so CriticBadge can mount it
  // unconditionally and gain no template branch of its own.
  import { spawnNotices } from "$lib/reviews.svelte";
  import { retrySpawnNotice } from "$lib/api";
  import { anchorPopover } from "$lib/floating-anchor";
  import { m } from "$lib/paraglide/messages";

  let { sessionId }: { sessionId: string } = $props();

  const notice = $derived(
    (() => {
      const n = spawnNotices.for(sessionId, "review");
      return n?.severity === "failed" ? n : null;
    })(),
  );

  let open = $state(false);
  let busy = $state(false);
  let outcome = $state<"done" | "error" | null>(null);
  let btnEl = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLElement | null>(null);
  const popId = $props.id();

  // Anchored, NOT aria-modal: a small popover tethered to its trigger does not seize the app, so
  // per the design system it takes no scrim — it dismisses on outside-click / Esc instead.
  $effect(() => {
    if (!open || !btnEl || !popEl) return;
    try {
      popEl.showPopover();
    } catch {
      return;
    }
    return anchorPopover(btnEl, popEl, 6);
  });

  $effect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      if (btnEl?.contains(t) || popEl?.contains(t)) return;
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
    if (open) btnEl?.focus();
    open = false;
    try {
      popEl?.hidePopover();
    } catch {
      /* already hidden */
    }
  }

  async function retry() {
    if (busy) return;
    busy = true;
    outcome = null;
    try {
      await retrySpawnNotice(sessionId, "review");
      outcome = "done";
    } catch {
      outcome = "error";
    } finally {
      busy = false;
    }
  }
</script>

{#if notice}
  <button
    bind:this={btnEl}
    type="button"
    class="csf-badge"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={open ? popId : undefined}
    aria-label={m.spawnnotice_review_failed_title()}
    onclick={(e) => {
      e.stopPropagation();
      open = !open;
    }}>{m.spawnnotice_review_failed_badge()}</button
  >
  <div
    id={popId}
    class="csf-pop"
    role="dialog"
    aria-label={m.spawnnotice_review_failed_title()}
    popover="manual"
    bind:this={popEl}
  >
    <p class="csf-title">{m.spawnnotice_review_failed_title()}</p>
    <p class="csf-detail">{notice.detail}</p>
    <p class="csf-action">{m.spawnnotice_review_failed_action()}</p>
    <button type="button" class="csf-retry" onclick={retry} disabled={busy}>
      {busy ? m.spawnnotice_retrying() : m.spawnnotice_retry()}
    </button>
    {#if outcome === "done"}
      <p class="csf-note" role="status">{m.spawnnotice_retry_queued()}</p>
    {:else if outcome === "error"}
      <p class="csf-note err" role="alert">{m.spawnnotice_retry_failed()}</p>
    {/if}
  </div>
{/if}

<style>
  /* Reads as a blocker, matching the red pip the clamped/failed adornment uses elsewhere. */
  .csf-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--status-blocked);
    border-radius: 2px;
    white-space: nowrap;
    color: var(--status-blocked);
    background: color-mix(in srgb, var(--status-blocked) 8%, transparent);
    font-family: inherit;
    cursor: pointer;
  }
  .csf-pop {
    position: fixed;
    margin: 0;
    inset: auto;
    max-width: 34ch;
    padding: 8px 10px;
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    background: var(--color-panel);
    color: var(--color-ink);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .csf-title {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--status-blocked);
    margin: 0;
  }
  .csf-detail {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    margin: 0;
  }
  .csf-action {
    font-size: var(--fs-meta);
    margin: 0;
  }
  .csf-retry {
    align-self: flex-start;
    font-size: var(--fs-meta);
    font-family: inherit;
    padding: 3px 10px;
    margin-top: 2px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink);
    cursor: pointer;
  }
  .csf-retry:hover:not(:disabled) {
    color: var(--color-ink-bright);
  }
  .csf-retry:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .csf-note {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }
  .csf-note.err {
    color: var(--status-blocked);
  }
</style>
