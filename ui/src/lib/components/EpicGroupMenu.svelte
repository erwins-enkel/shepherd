<script lang="ts">
  import { untrack } from "svelte";
  import type { DrainStatus, Epic } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { approveEpicNext, unqueueEpic, updateEpic } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { epicIssueUrl, epicMenuModel } from "./epic-menu";

  // Right-click / long-press menu of a herd epic group (its header or its session-less note). The
  // session card's CardMenu recipe: anchored, non-blocking, no scrim; dismissed on outside-click,
  // Esc or scroll; roving focus; focus back to the opener. The run actions call the API here, as
  // the epic detail's run area does. Start is offered only where it supersedes no other epic
  // (epicMenuModel), so it needs no supersede dialog.
  let {
    epic,
    drain = null,
    x,
    y,
    opener,
    onopen,
    onask,
    ondiagnose,
    onclose,
  }: {
    epic: Epic;
    /** The epic's repo drain status; its run picture decides what can start or unqueue. */
    drain?: DrainStatus | null;
    // viewport coordinates of the pointer/long-press that opened the menu
    x: number;
    y: number;
    // the element that opened the menu — focus returns here on close
    opener?: HTMLElement;
    /** Opens the epic's detail. */
    onopen?: () => void;
    /** Opens the Operator Assistant with a question about this epic typed in. */
    onask?: () => void;
    ondiagnose: () => void;
    onclose: () => void;
  } = $props();

  const model = $derived(epicMenuModel(epic, drain));
  const issueUrl = $derived(epicIssueUrl(epic));

  // Two-step arm → confirm, as CardMenu's Relaunch: starting spawns agents and spends usage,
  // ending stops the run. The first click arms (label switches to the confirm text), a second
  // within the window fires. The timer is cleared on unmount.
  const ARM_MS = 3000;
  let armed = $state<"start" | "end" | null>(null);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  function armThen(which: "start" | "end", fire: () => void) {
    clearTimeout(armTimer);
    if (armed === which) {
      armed = null;
      fire();
      return;
    }
    armed = which;
    armTimer = setTimeout(() => (armed = null), ARM_MS);
  }
  $effect(() => () => clearTimeout(armTimer));

  // Act, then close: the action reads this epic while the menu still has it (the parent drops the
  // epic with the menu). A failed request surfaces as a toast, as in the epic detail.
  function act(call: () => Promise<unknown>, failText: string, key: string) {
    const pending = call();
    onclose();
    pending.catch(() => toasts.info(failText, { alert: true, key }));
  }
  function then(fn: () => void) {
    fn();
    onclose();
  }
  function openDetails() {
    then(() => onopen?.());
  }
  function askAssistant() {
    then(() => onask?.());
  }
  function diagnose() {
    then(ondiagnose);
  }
  function openIssue() {
    const url = issueUrl;
    then(() => {
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    });
  }

  const repoPath = $derived(epic.repoPath);
  const parent = $derived(epic.parentIssueNumber);
  function approve() {
    act(() => approveEpicNext(repoPath, parent), m.epic_approve_failed(), "epic-approve-fail");
  }
  function pause() {
    act(
      () => updateEpic(repoPath, parent, { status: "paused" }),
      m.epic_update_failed(),
      "epic-update-fail",
    );
  }
  function start() {
    armThen("start", () =>
      act(
        () => updateEpic(repoPath, parent, { status: "running" }),
        m.epic_update_failed(),
        "epic-update-fail",
      ),
    );
  }
  function unqueue() {
    act(() => unqueueEpic(repoPath, parent), m.epic_unqueue_failed(), "epic-unqueue-fail");
  }
  function toggleMode() {
    act(
      () => updateEpic(repoPath, parent, { mode: model.attended ? "auto" : "attended" }),
      m.epic_update_failed(),
      "epic-update-fail",
    );
  }
  function end() {
    armThen("end", () =>
      act(
        () => updateEpic(repoPath, parent, { status: "idle" }),
        m.epic_stop_failed(),
        "epic-stop-fail",
      ),
    );
  }

  const startLabel = $derived.by(() => {
    if (model.start === "resume")
      return armed === "start" ? m.hold_cta_epic_resume_arm() : m.epicmenu_resume();
    return armed === "start" ? m.hold_cta_epic_start_arm() : m.epic_start();
  });
  const endTitle = $derived(
    model.end?.promotes == null
      ? m.epicmenu_stop_title()
      : m.epic_stop_promotes_title({ epic: model.end.promotes }),
  );

  let el = $state<HTMLDivElement>();

  // Clamp inside the viewport, measured once after mount (CardMenu's recipe: `max-content` width
  // makes the measurement independent of where the menu sits).
  let pos = $state<{ left: number; top: number } | null>(null);
  $effect(() => {
    const node = el;
    const px = x;
    const py = y;
    if (!node) return;
    untrack(() => {
      const r = node.getBoundingClientRect();
      const margin = 8;
      const left = Math.min(px, window.innerWidth - r.width - margin);
      const top = Math.min(py, window.innerHeight - r.height - margin);
      pos = { left: Math.max(margin, left), top: Math.max(margin, top) };
    });
  });
  // Open with the first item focused — once, on mount.
  $effect(() => {
    if (el) untrack(() => items()[0]?.focus());
  });

  function items(): HTMLElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLElement>(".em-item")) : [];
  }
  // Arrow / Home / End roving focus; Tab cycles like the arrows so focus stays in the open menu.
  function onNav(e: KeyboardEvent) {
    const list = items();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const fwd = (i + 1) % list.length;
    const back = (i - 1 + list.length) % list.length;
    let next: number;
    if (e.key === "ArrowDown") next = fwd;
    else if (e.key === "ArrowUp") next = back;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Tab") next = e.shiftKey ? back : fwd;
    else return;
    e.preventDefault();
    list[next]!.focus();
  }

  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") onclose();
    }
    function onPointer(e: Event) {
      if (el && !el.contains(e.target as Node)) onclose();
    }
    window.addEventListener("keydown", onKeydown);
    // capture so we beat the header's own click; scroll dismisses (the anchor moves)
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onclose, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onclose, true);
      // Every close path unmounts the menu; give focus back to the opener only when it fell to
      // <body> (an action that moved focus, e.g. into a dialog, keeps it).
      const target = opener;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });
</script>

<div
  bind:this={el}
  class="epic-menu"
  role="menu"
  tabindex="-1"
  aria-label={m.epicmenu_label()}
  style="left:{pos?.left ?? x}px;top:{pos?.top ?? y}px"
  onkeydown={onNav}
>
  {#if model.approve}
    <button class="em-item" type="button" role="menuitem" tabindex="-1" onclick={approve}>
      <span class="em-icon" aria-hidden="true">→</span>{m.epic_approve_next()}
    </button>
  {/if}
  {#if model.pause}
    <button
      class="em-item"
      type="button"
      role="menuitem"
      tabindex="-1"
      title={m.epic_pause_title()}
      onclick={pause}
    >
      <span class="em-icon" aria-hidden="true">‖</span>{m.epic_pause()}
    </button>
  {/if}
  {#if model.start}
    <button
      class="em-item"
      class:armed-go={armed === "start"}
      type="button"
      role="menuitem"
      tabindex="-1"
      onclick={start}
    >
      <span class="em-icon" aria-hidden="true">{armed === "start" ? "⚠" : "▶"}</span>{startLabel}
    </button>
  {/if}
  {#if model.unqueue}
    <button
      class="em-item"
      type="button"
      role="menuitem"
      tabindex="-1"
      title={m.epic_unqueue_title()}
      onclick={unqueue}
    >
      <span class="em-icon" aria-hidden="true">⤒</span>{m.epic_unqueue()}
    </button>
  {/if}
  {#if onopen}
    <button class="em-item" type="button" role="menuitem" tabindex="-1" onclick={openDetails}>
      <span class="em-icon" aria-hidden="true">▤</span>{m.epic_sessionless_open()}
    </button>
  {/if}
  {#if onask}
    <button class="em-item" type="button" role="menuitem" tabindex="-1" onclick={askAssistant}>
      <span class="em-icon" aria-hidden="true">✦</span>{m.operator_assistant_ask()}
    </button>
  {/if}
  <button
    class="em-item"
    type="button"
    role="menuitem"
    tabindex="-1"
    title={m.epic_diag_open_title()}
    onclick={diagnose}
  >
    <span class="em-icon" aria-hidden="true">⌕</span>{m.epic_diag_open()}
  </button>
  {#if issueUrl}
    <button class="em-item" type="button" role="menuitem" tabindex="-1" onclick={openIssue}>
      <span class="em-icon" aria-hidden="true">↗</span>{m.issuemenu_open()}
    </button>
  {/if}
  <button
    class="em-item"
    type="button"
    role="menuitemcheckbox"
    aria-checked={model.attended}
    tabindex="-1"
    title={m.epicmenu_attended_title()}
    onclick={toggleMode}
  >
    <span class="em-icon" aria-hidden="true">{model.attended ? "✓" : "□"}</span
    >{m.epicmenu_attended()}
  </button>
  {#if model.end}
    <button
      class="em-item danger"
      class:armed={armed === "end"}
      type="button"
      role="menuitem"
      tabindex="-1"
      title={endTitle}
      onclick={end}
    >
      <span class="em-icon" aria-hidden="true">{armed === "end" ? "⚠" : "■"}</span>{armed === "end"
        ? m.epicmenu_stop_confirm()
        : m.epic_stop()}
    </button>
  {/if}
</div>

<style>
  /* CardMenu's popover recipe, so the epic and session menus read as one family. */
  .epic-menu {
    position: fixed;
    z-index: 60;
    min-width: 180px;
    width: max-content;
    max-width: calc(100vw - 16px);
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    /* established popover shadow (matches CardMenu) — no token exists */
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .epic-menu:focus {
    outline: none;
  }
  .em-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 8px 11px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    cursor: pointer;
  }
  .em-item:hover,
  .em-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .em-item.danger {
    color: var(--color-red);
  }
  .em-item.danger:hover,
  .em-item.danger:focus-visible {
    background: color-mix(in srgb, var(--color-red) 14%, var(--color-panel));
  }
  /* Armed stop: the danger wash marks it hot so the second click is obvious (CardMenu's .armed). */
  .em-item.armed {
    background: color-mix(in srgb, var(--color-red) 14%, var(--color-panel));
  }
  .em-item.armed:hover,
  .em-item.armed:focus-visible {
    background: color-mix(in srgb, var(--color-red) 22%, var(--color-panel));
  }
  /* Armed start/resume: not destructive, it spends usage — epic blue, as the child card's armed
     "Start epic?" (UnitRow .hold-cta). */
  .em-item.armed-go {
    color: var(--color-blue);
    background: color-mix(in srgb, var(--color-blue) 14%, var(--color-panel));
  }
  .em-item.armed-go:hover,
  .em-item.armed-go:focus-visible {
    background: color-mix(in srgb, var(--color-blue) 22%, var(--color-panel));
  }
  .em-icon {
    font-size: var(--fs-meta);
    width: 1em;
    text-align: center;
    flex-shrink: 0;
  }
</style>
