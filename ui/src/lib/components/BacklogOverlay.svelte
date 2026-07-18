<script lang="ts">
  import type { BacklogPayload, DrainStatus, Epic, Issue, PullRequest, Steer } from "$lib/types";
  import { MediaQuery } from "svelte/reactivity";
  import { m } from "$lib/paraglide/messages";
  import { dialog } from "$lib/a11yDialog";
  import { backlogLayout, clampModalWidth, clampModalHeight } from "$lib/backlog-layout.svelte";
  import { createResizeDrag } from "$lib/resize-drag";
  import BacklogView from "./BacklogView.svelte";

  let {
    payload,
    mobile,
    onissue,
    onquick = undefined,
    oninject = undefined,
    onpr,
    onadopt,
    onlaunchtrain,
    onclose,
    epics = undefined,
    inTrainPrs = new Set(),
    target = null,
    drain = undefined,
    onaddclone,
    onaddfork,
    onaddnewproject,
    selectPath = null,
  }: {
    payload: BacklogPayload | null;
    mobile: boolean;
    onissue: (repoPath: string, issue: Issue) => void;
    onquick?: (repoPath: string, issue: Issue, action: Steer) => void;
    oninject?: (repoPath: string, issue: Issue, steer: Steer) => void;
    onpr: (repoPath: string, pr: PullRequest) => void;
    onadopt: (repoPath: string, prompt: string) => void;
    onlaunchtrain: (repoPath: string, prs: PullRequest[]) => void;
    onclose: () => void;
    /** "+ Add repo" menu actions, forwarded to BacklogView's repos panel. */
    onaddclone: () => void;
    onaddfork: () => void;
    onaddnewproject: () => void;
    /** Repo to auto-select after a successful add (forwarded to BacklogView). */
    selectPath?: string | null;
    /** Live epic record from the store, threaded to BacklogView → IssuesPanel. */
    epics?: Record<string, Epic>;
    /** PR identity keys (`${repoPath}#${number}`) owned by a running merge train,
     *  threaded to BacklogView → PrsPanel → PrRow for the in-train badge + merge lock. */
    inTrainPrs?: Set<string>;
    /** EPIC-badge target (repo + issue), forwarded to BacklogView to drive
     *  selection + epic expansion. */
    target?: { repoPath: string; issueNumber: number } | null;
    /** Live drain status keyed by repoPath (store.drain), forwarded to BacklogView →
     *  Automation tab. This overlay is reachable while tasks run, so without it the
     *  Automation tab's epic banner + drain-cap would be stale here. */
    drain?: Record<string, DrainStatus>;
  } = $props();

  // ── Desktop modal resize (issue #1787) ──────────────────────────────────────
  // Shared drag lifecycle (createResizeDrag) mirrors the Herd sidebar splitter:
  // pointer capture, a threshold, live setModal on move, commit on up,
  // double-click reset. Gated on !mobile && fine-pointer so the mobile
  // full-screen sheet and touch tablets are untouched. The .card is flex-centered
  // by .overlay, so a 1:1 delta would move the bottom-right corner at half speed —
  // onDrag doubles the delta per axis so the corner tracks the pointer 1:1.
  const coarse = new MediaQuery("(pointer: coarse)");
  const resizable = $derived(!mobile && !coarse.current);
  const resized = $derived(
    resizable && backlogLayout.width !== null && backlogLayout.height !== null,
  );
  const sizeStyle = $derived(
    resized ? `--repos-w:${backlogLayout.width}px;--repos-h:${backlogLayout.height}px` : undefined,
  );

  let cardEl = $state<HTMLElement>();
  let modalResizing = $state(false);

  const startModalResize = createResizeDrag<{ x: number; y: number; w: number; h: number }>({
    axis: "both",
    onActive: (a) => (modalResizing = a),
    onStart: (e) => {
      if (!resizable || !cardEl) return null;
      const r = cardEl.getBoundingClientRect();
      return { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    },
    onDrag: (e, c) =>
      backlogLayout.setModal(
        clampModalWidth(c.w + 2 * (e.clientX - c.x), window.innerWidth),
        clampModalHeight(c.h + 2 * (e.clientY - c.y), window.innerHeight),
      ),
    onCommit: () => backlogLayout.commitModal(),
    onReset: () => backlogLayout.resetModal(),
  });
</script>

<div
  class="overlay"
  class:mobile
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="card"
    class:mobile
    class:resized
    class:resizing={modalResizing}
    bind:this={cardEl}
    style={sizeStyle}
    role="dialog"
    aria-modal="true"
    aria-label={m.actionbar_backlog()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.actionbar_backlog()}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>
    <div class="body">
      <BacklogView
        {payload}
        {mobile}
        {onissue}
        {onquick}
        {oninject}
        {onpr}
        {onadopt}
        {onlaunchtrain}
        {onaddclone}
        {onaddfork}
        {onaddnewproject}
        {selectPath}
        {epics}
        {inTrainPrs}
        {target}
        {drain}
      />
    </div>
    {#if resizable}
      <!-- Bottom-right resize grip (issue #1787). Drag to resize the modal,
           double-click to reset — see startModalResize. Rendered only on
           fine-pointer desktop; never on the mobile full-screen sheet. role
           mirrors the Herd splitter (no ideal ARIA role for a 2D grip). -->
      <div
        class="resize-corner"
        class:dragging={modalResizing}
        role="separator"
        aria-label={m.repos_resize_modal()}
        title={m.repos_resize_modal()}
        onpointerdown={startModalResize}
      ></div>
    {/if}
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
    z-index: 20;
    padding: 24px;
  }
  .overlay.mobile {
    padding: 0;
  }
  .card {
    /* Default (issue #1787): fill most of a wide desktop viewport — the old
       min(960px, 94vw) cap left large monitors mostly unused. */
    width: 90vw;
    height: 88vh;
    position: relative;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* Operator-chosen size (issue #1787). --repos-w/-h are clamped px from the
     corner drag; min(stored, calc(100vw/vh - 48px)) is the reactive clamp-on-
     restore — the -48px leaves the .overlay's 24px padding on each side free so
     the card edge / close button can't be clipped when the viewport shrinks.
     min-width/min-height keep the shell usable if a stored value is tiny. */
  .card.resized {
    width: min(var(--repos-w), calc(100vw - 48px));
    height: min(var(--repos-h), calc(100vh - 48px));
    min-width: 640px;
    min-height: 460px;
  }
  /* During an active drag: kill text selection + force the resize cursor. */
  .card.resizing {
    user-select: none;
    cursor: nwse-resize;
  }
  .card.mobile {
    width: 100%;
    max-height: none;
    height: 100%;
    border: 0;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .chead {
    display: flex;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid var(--color-line);
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 2px 6px;
  }
  .x:hover {
    color: var(--color-amber);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* Bottom-right resize grip (issue #1787): a restrained ~16px hit target with a
     diagonal hairline (::after) that brightens on hover/focus/drag — detectable
     without decorative color, matching the Herd splitter's treatment. */
  .resize-corner {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    z-index: 5;
    touch-action: none;
  }
  .resize-corner::after {
    content: "";
    position: absolute;
    right: 3px;
    bottom: 3px;
    width: 7px;
    height: 7px;
    border-right: 2px solid var(--color-line-bright);
    border-bottom: 2px solid var(--color-line-bright);
    opacity: 0.5;
    transition: opacity 0.12s ease;
  }
  .resize-corner:hover::after,
  .resize-corner:focus-visible::after,
  .resize-corner.dragging::after {
    opacity: 1;
  }
  .resize-corner:focus-visible {
    outline: none;
  }
</style>
