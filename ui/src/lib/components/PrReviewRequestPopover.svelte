<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { getPrReviewers, requestPrReview, type PrReviewerOptions } from "$lib/api";
  import { m } from "$lib/paraglide/messages";
  import { portal } from "$lib/portal";

  let {
    anchor,
    opener,
    sessionId,
    prNumber,
    prUrl,
    onclose,
  }: {
    anchor: DOMRect;
    opener?: HTMLElement;
    sessionId: string;
    prNumber: number;
    prUrl?: string;
    onclose: () => void;
  } = $props();

  const openedSessionId = untrack(() => sessionId);
  const openedPrNumber = untrack(() => prNumber);
  let el = $state<HTMLDivElement>();
  let selectEl = $state<HTMLSelectElement>();
  let pos = $state<{ left: number; top: number } | null>(null);
  let loading = $state(true);
  let loadError = $state(false);
  let submitting = $state(false);
  let data = $state<PrReviewerOptions | null>(null);
  let selected = $state("");
  let requestError = $state("");
  let succeededReviewer = $state("");
  let succeededReviewers = $state<string[]>([]);
  let refreshPending = $state(false);
  let loadSequence = 0;

  const sameLogin = (a: string | null | undefined, b: string | null | undefined) =>
    !!a && !!b && a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

  const visibleLogins = $derived(
    data?.logins.filter((login) => !sameLogin(login, data?.authorLogin)) ?? [],
  );
  const requestedLogins = $derived([...(data?.requestedReviewers ?? []), ...succeededReviewers]);
  const isRequested = (login: string) =>
    requestedLogins.some((requested) => sameLogin(requested, login));
  const eligibleLogins = $derived(visibleLogins.filter((login) => !isRequested(login)));
  const submitDisabled = $derived(
    loading ||
      submitting ||
      !data ||
      data.isDraft ||
      data.unavailable ||
      !selected ||
      isRequested(selected) ||
      !eligibleLogins.some((login) => sameLogin(login, selected)),
  );

  function requestErrorMessage(code: string) {
    switch (code) {
      case "review_request_forbidden":
        return m.prreview_error_forbidden();
      case "review_request_invalid_reviewer":
        return m.prreview_error_invalid_reviewer();
      case "review_request_stale":
        return m.prreview_error_stale();
      case "review_request_draft":
        return m.prreview_draft();
      case "review_request_invalid":
        return m.prreview_error_invalid();
      case "review_request_unsupported":
        return m.prreview_error_unsupported();
      case "review_request_failed":
      default:
        return m.prreview_error_failed();
    }
  }

  async function load() {
    const sequence = ++loadSequence;
    loading = true;
    loadError = false;
    requestError = "";
    try {
      const result = await getPrReviewers(openedSessionId);
      if (sequence !== loadSequence) return;
      if (result.prNumber !== openedPrNumber) {
        onclose();
        return;
      }
      data = result;
      const candidates = result.logins.filter(
        (login) =>
          !sameLogin(login, result.authorLogin) &&
          !result.requestedReviewers.some((requested) => sameLogin(requested, login)),
      );
      selected = candidates.find((login) => sameLogin(login, result.defaultReviewer)) ?? "";
      loading = false;
      await tick();
      selectEl?.focus();
    } catch {
      if (sequence !== loadSequence) return;
      data = null;
      selected = "";
      loading = false;
      loadError = true;
    }
  }

  async function submit() {
    if (submitDisabled) return;
    const reviewer = selected;
    submitting = true;
    requestError = "";
    try {
      const result = await requestPrReview(openedSessionId, openedPrNumber, reviewer);
      succeededReviewer = reviewer;
      if (!succeededReviewers.some((login) => sameLogin(login, reviewer))) {
        succeededReviewers = [...succeededReviewers, reviewer];
      }
      refreshPending = result.refreshPending === true;
    } catch (error) {
      const code = error instanceof Error ? error.message : "review_request_failed";
      requestError = requestErrorMessage(code);
    } finally {
      submitting = false;
    }
  }

  function onSelect(event: Event) {
    selected = (event.currentTarget as HTMLSelectElement).value;
    requestError = "";
  }

  $effect(() => {
    if (sessionId !== openedSessionId || prNumber !== openedPrNumber) onclose();
  });

  $effect(() => {
    if (!el) return;
    const node: HTMLDivElement = el;
    function updatePosition() {
      const rect = node.getBoundingClientRect();
      const margin = 8;
      const below = anchor.bottom + 4;
      const above = anchor.top - rect.height - 4;
      const preferredTop =
        below + rect.height + margin > window.innerHeight && above > margin ? above : below;
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      const top = Math.min(Math.max(margin, preferredTop), maxTop);
      const left = Math.min(anchor.left, window.innerWidth - rect.width - margin);
      pos = { left: Math.max(margin, left), top: Math.max(margin, top) };
    }
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(node);
    return () => observer.disconnect();
  });

  $effect(() => {
    function onKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        onclose();
      }
    }
    function onPointerdown(event: PointerEvent) {
      const target = event.target as Node;
      if (el && !el.contains(target) && !opener?.contains(target)) onclose();
    }
    function onViewportChange(event: Event) {
      if (event.type === "scroll" && el?.contains(event.target as Node)) return;
      onclose();
    }
    window.addEventListener("keydown", onKeydown, true);
    window.addEventListener("pointerdown", onPointerdown, true);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("pointerdown", onPointerdown, true);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
      const target = opener;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });

  onMount(() => {
    el?.focus();
    void load();
    return () => {
      loadSequence += 1;
    };
  });
</script>

<div
  bind:this={el}
  use:portal
  class="review-popover"
  role="dialog"
  aria-label={m.prreview_title()}
  tabindex="-1"
  style="left:{pos?.left ?? anchor.left}px;top:{pos?.top ?? anchor.bottom + 4}px"
>
  <div class="head">
    <strong>{m.prreview_title()}</strong>
    <button type="button" class="close" aria-label={m.common_close()} onclick={onclose}>×</button>
  </div>

  {#if data?.repoSlug}
    <div class="target">
      <span>{m.prreview_target_repo()}</span>
      <strong>{data.repoSlug}</strong>
    </div>
  {/if}

  {#if loading}
    <p class="state" aria-live="polite">{m.prreview_loading()}</p>
  {:else if loadError}
    <div class="state error" role="alert">
      <span>{m.prreview_load_failed()}</span>
      <button type="button" class="gbtn" onclick={load}>{m.common_retry()}</button>
    </div>
  {:else if data}
    {#if data.source === "assignees"}
      <p class="hint">{m.prreview_source_assignees()}</p>
    {/if}
    {#if data.isDraft}
      <p class="state warning">{m.prreview_draft()}</p>
    {/if}
    {#if data.unavailable}
      <p class="state error" role="alert">{m.prreview_unavailable()}</p>
    {:else if visibleLogins.length === 0}
      <p class="state">{m.prreview_no_candidates()}</p>
    {:else}
      <label for="pr-reviewer">{m.roles_reviewer_label()}</label>
      <select id="pr-reviewer" bind:this={selectEl} value={selected} onchange={onSelect}>
        <option value="">{m.prreview_select_placeholder()}</option>
        {#each visibleLogins as login (login.toLocaleLowerCase())}
          <option value={login} disabled={isRequested(login)}>
            {isRequested(login) ? m.prreview_already_requested({ login }) : login}
          </option>
        {/each}
      </select>
      {#if eligibleLogins.length === 0}
        <p class="state">{m.prreview_no_candidates()}</p>
      {/if}
    {/if}

    {#if requestError}
      <p class="state error" role="alert">{requestError}</p>
    {:else if succeededReviewer}
      <p class="state success" role="status">
        {refreshPending
          ? m.prreview_success_refresh_pending({ reviewer: succeededReviewer })
          : m.prreview_success({ reviewer: succeededReviewer })}
      </p>
    {/if}
  {/if}

  {#if prUrl || data}
    <div class="actions">
      {#if prUrl}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
        <a class="gbtn" href={prUrl} target="_blank" rel="noopener noreferrer"
          >{m.prbadge_open_pr()}</a
        >
      {/if}
      {#if data}
        <button
          type="button"
          class="gbtn primary"
          disabled={submitDisabled}
          aria-busy={submitting}
          onclick={submit}
        >
          {submitting ? m.prreview_submitting() : m.prreview_title()}
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .review-popover {
    position: fixed;
    z-index: 61;
    width: min(340px, calc(100vw - 16px));
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    box-shadow: var(--shadow-popover);
    color: var(--color-ink);
    max-height: calc(100vh - 16px);
    overflow-y: auto;
  }
  .review-popover:focus {
    outline: none;
  }
  .head,
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .head {
    justify-content: space-between;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-base);
    cursor: pointer;
  }
  .close:hover {
    color: var(--color-amber);
  }
  .close:focus-visible,
  .gbtn:focus-visible,
  select:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .target {
    display: grid;
    gap: 2px;
    min-width: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .target strong {
    overflow-wrap: anywhere;
    color: var(--color-ink-bright);
  }
  label {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  select {
    width: 100%;
    box-sizing: border-box;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
  }
  select:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .hint,
  .state {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.45;
  }
  .state.error {
    color: var(--color-red);
  }
  .state.warning {
    color: var(--color-amber);
  }
  .state.success {
    color: var(--color-green);
  }
  .state.error:has(.gbtn) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .actions {
    justify-content: flex-end;
    margin-top: 2px;
  }
  .gbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    line-height: 1.4;
    padding: 5px 9px;
    text-decoration: none;
    cursor: pointer;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
</style>
