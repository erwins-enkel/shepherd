<script lang="ts">
  import type { UpdateStatus, DeployState, DirtyStatus } from "$lib/types";
  import { applyUpdate, getUpdateDirty, StaleDirtyError } from "$lib/api";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import SvgFlockOverlay from "$lib/components/SvgFlockOverlay.svelte";

  let {
    update,
    updating = false,
    deploy = null,
    onconfirm,
    onclose,
  }: {
    update: UpdateStatus;
    updating?: boolean;
    /** set once a launched deploy reports failure → show the captured reason */
    deploy?: DeployState | null;
    onconfirm?: () => void;
    onclose?: () => void;
  } = $props();

  let submitting = $state(false);
  let error = $state<string | null>(null);
  // commit subjects truncate to one line by default; tapping a row expands it to
  // the full width so the whole message is readable — on a phone the single line
  // otherwise cuts off with an ellipsis and you never see the end
  let expanded = $state<Record<string, boolean>>({});
  const toggle = (sha: string) => (expanded[sha] = !expanded[sha]);

  const busy = $derived(submitting || updating);
  const failed = $derived(deploy?.phase === "failed");
  // while the deploy is in flight, show its captured output so the user sees
  // real progress (install → build → restart) instead of a frozen spinner
  const liveLog = $derived(busy && !failed && deploy?.log ? deploy.log : null);

  // ── dirty-repo flow ────────────────────────────────────────────────────────
  // The tracked dirty state is volatile, so we always fetch it FRESH (never from
  // the cached update status): once proactively when the dialog opens, and again
  // reactively if a deploy fails because the tree blocked the pull / drifted.
  let dirtyProbe = $state<"idle" | "pending" | "clean" | "dirty" | "error">("idle");
  let dirty = $state<DirtyStatus | null>(null);
  // two-click destructive confirm: the first click only arms (no API call)
  let arming = $state(false);
  // shown when the deploy failed because the tree changed since confirmation
  let staleHint = $state(false);

  const displayedSig = $derived(dirty?.sig ?? undefined);

  async function probe() {
    dirtyProbe = "pending";
    arming = false;
    try {
      const d = await getUpdateDirty();
      dirty = d;
      dirtyProbe = d.dirty ? "dirty" : "clean";
    } catch {
      dirty = null;
      dirtyProbe = "error"; // degrade to the normal update UI — never a stuck button
    }
  }

  // proactive: probe once when the dialog mounts on an available update
  $effect(() => {
    if (update.behind > 0 && dirtyProbe === "idle") void probe();
  });

  // reactive: a failed deploy classified dirty/stale → re-probe fresh and route
  // through the same dirty UI (with a "changed since shown" hint for stale)
  $effect(() => {
    if (failed && (deploy?.reason === "dirty" || deploy?.reason === "stale")) {
      staleHint = deploy?.reason === "stale";
      void probe();
    }
  });

  const dirtyReactive = $derived(
    failed && (deploy?.reason === "dirty" || deploy?.reason === "stale"),
  );

  type Mode = "progress" | "loading" | "clean" | "dirty" | "toolarge" | "nowclean" | "rawlog";
  const mode = $derived.by((): Mode => {
    if (busy) return "progress";
    if (dirtyReactive) {
      if (dirtyProbe === "pending" || dirtyProbe === "idle") return "loading";
      if (dirtyProbe === "error") return "rawlog"; // couldn't probe → raw log fallback
      if (dirtyProbe === "clean") return "nowclean"; // tree got cleaned meanwhile
      return dirty?.sig == null ? "toolarge" : "dirty";
    }
    if (failed) return "rawlog";
    if (dirtyProbe === "pending" || dirtyProbe === "idle") return "loading";
    if (dirtyProbe === "clean" || dirtyProbe === "error") return "clean";
    return dirty?.sig == null ? "toolarge" : "dirty";
  });

  const moreCount = $derived(dirty ? dirty.dirtyCount - dirty.dirtyFiles.length : 0);

  /** Clean/retry path: a plain (non-destructive) update. */
  async function runUpdate() {
    submitting = true;
    error = null;
    try {
      await applyUpdate(false);
      onconfirm?.(); // store marks `updating`; the page reloads once the new build is live
    } catch (e) {
      error = e instanceof Error ? e.message : m.updatemodal_update_failed();
      submitting = false;
    }
  }

  /** Destructive path, second click: send the discard with the DISPLAYED sig. */
  async function confirmDiscard() {
    submitting = true;
    error = null;
    try {
      await applyUpdate(true, displayedSig);
      onconfirm?.();
    } catch (e) {
      submitting = false;
      if (e instanceof StaleDirtyError) {
        // the tree drifted since we showed the list → re-render fresh + re-confirm
        dirty = e.dirty;
        dirtyProbe = e.dirty.dirty ? "dirty" : "clean";
        arming = false;
        staleHint = true;
      } else {
        error = e instanceof Error ? e.message : m.updatemodal_update_failed();
      }
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && !busy) onclose?.();
  }}
>
  {#if busy}
    <SvgFlockOverlay placement="backdrop" />
  {/if}
  <div
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={m.updatemodal_available()}
    use:dialog={{ onclose: () => !busy && onclose?.() }}
  >
    {#if busy}
      <SvgFlockOverlay placement="sheet" />
    {/if}
    <div class="card-content">
      <div class="chead">
        <span class="micro">{m.updatemodal_available()}</span>
        {#if !busy}
          <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
            >✕</button
          >
        {/if}
      </div>

      <div class="summary">
        <span class="count">{update.behind}</span>
        <span class="micro"
          >{update.behind === 1 ? m.updatemodal_commits_one() : m.updatemodal_commits_other()}</span
        >
        {#if update.current && update.latest}
          <span class="shas micro">{update.current} → {update.latest}</span>
        {/if}
      </div>

      <div class="commits">
        {#each update.commits as c (c.sha)}
          <button
            type="button"
            class="commit"
            class:expanded={expanded[c.sha]}
            aria-expanded={!!expanded[c.sha]}
            title={c.subject}
            onclick={() => toggle(c.sha)}
          >
            <span class="row">
              <span class="sha">{c.sha}</span>
              <span class="subject">{c.subject}</span>
            </span>
          </button>
        {/each}
      </div>

      {#if mode === "progress"}
        <div class="status" aria-live="polite">{m.updatemodal_status()}</div>
        {#if liveLog}
          <div class="loghead micro">{m.updatemodal_deploy_log()}</div>
          <!-- The concise .status line above is the polite announcement; the raw log
               stays silent so a fast-appending stream doesn't re-announce every line. -->
          <pre class="log">{liveLog}</pre>
        {/if}
      {/if}

      {#if mode === "dirty" || mode === "toolarge"}
        <div class="dirty">
          <div class="dirty-title err">{m.updatemodal_dirty_title()}</div>
          <p class="dirty-body">{m.updatemodal_dirty_body()}</p>
          {#if staleHint}
            <p class="dirty-stale">{m.updatemodal_dirty_stale()}</p>
          {/if}
          {#if dirty && dirty.dirtyFiles.length}
            <div class="loghead micro">{m.updatemodal_dirty_files_head()}</div>
            <ul class="files">
              {#each dirty.dirtyFiles as f (f)}
                <li>{f}</li>
              {/each}
              {#if moreCount > 0}
                <li class="more">{m.updatemodal_dirty_files_more({ count: moreCount })}</li>
              {/if}
            </ul>
          {/if}
          {#if mode === "toolarge"}
            <p class="dirty-hint">{m.updatemodal_dirty_too_large()}</p>
          {:else if arming}
            <div class="confirm">
              <span class="confirm-q"
                >{m.updatemodal_discard_confirm({ count: dirty?.dirtyCount ?? 0 })}</span
              >
            </div>
          {/if}
        </div>
      {/if}

      {#if mode === "nowclean"}
        <div class="status">{m.updatemodal_now_clean()}</div>
      {/if}

      {#if mode === "rawlog"}
        <div class="failure">
          <div class="err">
            {m.updatemodal_deploy_failed()}
            {#if deploy?.exitCode != null}
              <span class="code">{m.updatemodal_exit_code({ code: deploy.exitCode })}</span>
            {/if}
          </div>
          {#if deploy?.log}
            <div class="loghead micro">{m.updatemodal_deploy_log()}</div>
            <pre class="log">{deploy.log}</pre>
          {/if}
        </div>
      {/if}

      {#if error}<div class="err">{error}</div>{/if}

      <div class="actions">
        {#if !busy}
          <button
            type="button"
            class="later"
            onclick={() => (arming ? (arming = false) : onclose?.())}
          >
            {arming ? m.common_close() : m.updatemodal_later()}
          </button>
        {/if}

        {#if mode === "dirty"}
          {#if arming}
            <button type="button" class="run danger" onclick={confirmDiscard} disabled={busy}>
              {m.updatemodal_discard_confirm_yes()}
            </button>
          {:else}
            <button type="button" class="run danger" onclick={() => (arming = true)}>
              {m.updatemodal_discard_and_update()}
            </button>
          {/if}
        {:else if mode === "toolarge"}
          <!-- no destructive action offered; the operator resolves it manually -->
        {:else}
          <button
            type="button"
            class="run"
            onclick={runUpdate}
            disabled={busy || mode === "loading"}
          >
            {busy
              ? m.updatemodal_updating()
              : mode === "rawlog" || mode === "nowclean"
                ? m.updatemodal_retry()
                : m.updatemodal_update_now()}
          </button>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
    padding: 16px;
  }
  .card {
    position: relative;
    box-sizing: border-box;
    z-index: 1;
    width: min(520px, 100%);
    max-height: 80dvh;
    display: flex;
    flex-direction: column;
    gap: 0;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 18px 18px 16px;
    overflow-x: clip;
    box-shadow: inset 0 0 30px -16px var(--color-amber);
  }
  .card-content {
    position: relative;
    z-index: 1;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: 0;
    left: 0;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: 0;
    right: 0;
    border-left: 0;
    border-top: 0;
  }
  .chead {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-base);
  }
  .summary {
    display: flex;
    align-items: baseline;
    gap: 9px;
  }
  .summary .count {
    color: var(--color-amber);
    font-size: var(--fs-2xl);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .summary .shas {
    margin-left: auto;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .commits {
    /* shrinkable flex child: without min-height the list refuses to shrink
       below its content and 16 commits push the actions off-screen */
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .commit {
    display: block;
    width: 100%;
    margin: 0;
    padding: 2px 0;
    background: transparent;
    border: 0;
    text-align: left;
    font-family: inherit;
    font-size: var(--fs-base);
    color: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .commit .row {
    display: flex;
    gap: 9px;
    align-items: flex-start;
  }
  .commit:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: 2px;
  }
  .commit .sha {
    color: var(--color-amber);
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .commit .subject {
    color: var(--color-ink-bright);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* tapped open → wrap the full subject across the available width */
  .commit.expanded .subject {
    white-space: normal;
    word-break: break-word;
  }
  /* touch devices: roomier rows so a single commit is easy to hit and read */
  @media (pointer: coarse) {
    .commit {
      padding: 8px 0;
    }
    .commit .row {
      min-height: 28px;
      align-items: center;
    }
    .commit.expanded .row {
      align-items: flex-start;
    }
    .commits {
      gap: 0;
    }
    .commit + .commit {
      border-top: 1px solid var(--color-line);
    }
  }
  .status {
    color: var(--color-amber);
    font-size: var(--fs-base);
  }
  .err {
    color: var(--color-red);
    font-size: var(--fs-base);
  }
  .failure,
  .dirty {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .failure .code {
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
    margin-left: 6px;
  }
  .dirty-title {
    font-weight: 600;
  }
  .dirty-body,
  .dirty-hint,
  .dirty-stale {
    margin: 0;
    font-size: var(--fs-base);
    line-height: 1.45;
    color: var(--color-ink);
  }
  .dirty-hint {
    color: var(--color-muted);
  }
  .dirty-stale {
    color: var(--color-amber);
  }
  .files {
    margin: 0;
    list-style: none;
    padding: 8px 10px;
    max-height: 160px;
    overflow: auto;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-family: var(--font-mono, monospace);
    font-size: var(--fs-meta);
    line-height: 1.5;
    white-space: pre;
  }
  .files .more {
    color: var(--color-faint);
    white-space: normal;
  }
  .confirm {
    padding: 8px 10px;
    border: 1px solid var(--color-red);
    background: var(--color-inset);
  }
  .confirm-q {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }
  .loghead {
    color: var(--color-muted);
  }
  .log {
    flex: 1 1 96px;
    margin: 0;
    min-height: 96px;
    max-height: 200px;
    overflow: auto;
    padding: 8px 10px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .later {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    padding: 8px 14px;
    cursor: pointer;
    letter-spacing: 0.06em;
  }
  .run {
    background: transparent;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    font-weight: 600;
    padding: 8px 16px;
    cursor: pointer;
    letter-spacing: 0.06em;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  /* destructive variant: same recipe, danger hue (traffic-light semantics) */
  .run.danger {
    border-color: var(--color-red);
    color: var(--color-red);
    box-shadow: inset 0 0 18px -10px var(--color-red);
  }
  .run:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
    box-shadow: none;
  }
  /* phones: rise as a full-height sheet (same pattern as NewTask) so the
     commit list gets the whole screen and scrolls internally while the
     actions stay pinned and thumb-reachable above the home indicator */
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
      padding: 0;
    }
    .card {
      width: 100%;
      max-height: none;
      height: 100dvh;
      border: 0;
      /* safe-area top: standalone-PWA status bar / Dynamic Island */
      padding: calc(16px + env(safe-area-inset-top)) 16px calc(14px + env(safe-area-inset-bottom));
      /* fallback when even fully-shrunk content exceeds the viewport
         (landscape phones): scroll the card rather than clip the actions */
      overflow-y: auto;
      animation: sheet-up 0.18s ease-out;
    }
    .card-content {
      min-height: 100%;
    }
    .bracket::before,
    .bracket::after {
      display: none;
    }
    .x {
      min-width: 44px;
      min-height: 44px;
      margin: -14px -14px -10px 0; /* keep the glyph optically in the corner */
    }
    .commits {
      flex-grow: 1; /* fill the sheet so the list, not a void, owns the space */
    }
    .later,
    .run {
      min-height: 44px;
      flex: 1; /* two thumb-width targets instead of two slivers at the edge */
    }
    .actions {
      margin-top: auto; /* pin to the bottom even when few commits */
    }
  }
  @keyframes sheet-up {
    from {
      transform: translateY(12px);
      opacity: 0.6;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style>
