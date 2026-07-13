<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { insertNewlineAt } from "$lib/compose";
  import { getCommands } from "$lib/api";
  import { createDictation } from "$lib/dictation.svelte";
  import {
    matchSlashTrigger,
    filterCommands,
    applyCommandPick,
    applyMentionPick,
    commandInvocationName,
  } from "$lib/slash";
  import type { AgentProvider, SlashCommand } from "$lib/types";
  import SlashCommandMenu from "./SlashCommandMenu.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { steers } from "$lib/steers.svelte";
  import { repos } from "$lib/repos.svelte";
  import { steerAppliesToRepo } from "$lib/steer-scope";

  // Centered compose overlay: a real <textarea> (not xterm's hidden one) so
  // Android autocomplete / suggestions / double-space-period resolve natively
  // in the field. We read its value once, on explicit submit — never diffing
  // per-keystroke into the PTY — so xterm's IME duplication bug can't occur.
  // The overlay floats over the terminal with a blurred backdrop; the parent
  // mounts it on demand (swipe-up / ✎ chip) and decides how to inject the text.
  // Presentational: owns its own text + newline editing + dictation + slash
  // picker, emits the composed string via onsend and a dismissal via onclose.
  // repoPath powers the inline slash-command picker (same /api/commands index
  // as New Task), so a leading `/` offers the session repo's commands.
  let {
    onsend,
    onclose,
    repoPath,
    agentProvider = "claude",
    startDictation = false,
  }: {
    onsend: (text: string) => void;
    onclose: () => void;
    repoPath: string;
    agentProvider?: AgentProvider;
    // open the overlay already listening (mic entry); typing-only entries pass
    // false so the keyboard comes up without recording
    startDictation?: boolean;
  } = $props();

  let value = $state("");
  let ta = $state<HTMLTextAreaElement>();
  let overlayEl = $state<HTMLDivElement>();

  // ── inline slash-command autocomplete (mirrors NewTask, opens upward) ──
  let allCommands = $state<SlashCommand[]>([]);
  let slashOpen = $state(false);
  let slashQuery = $state("");
  let slashTrigger = $state<"/" | "$" | "@">("/");
  let slashIndex = $state(0);
  const commandProvider = $derived(
    slashOpen ? (slashTrigger === "/" ? "claude" : "codex") : agentProvider,
  );
  const slashMatches = $derived(
    slashOpen ? filterCommands(allCommands, slashQuery, commandProvider) : [],
  );

  // Steer chips ignore inSteerBar by design (every steer shows here), but still
  // gate on repo binding — universal steers always show, bound ones only for a
  // matching repo.
  const availableSteers = $derived(
    steers.list.filter((s) => steerAppliesToRepo(s, repos.nameFor(repoPath), agentProvider)),
  );

  // Load the slash-command list for this session's repo (its own
  // .claude/commands + .claude/skills layer on top of the global/user ones).
  $effect(() => {
    const rp = repoPath;
    const provider = commandProvider;
    if (!rp) {
      allCommands = [];
      return;
    }
    getCommands(rp, { provider })
      .then((r) => {
        if (rp === repoPath && provider === commandProvider) allCommands = r.commands;
      })
      .catch(() => {
        if (rp === repoPath && provider === commandProvider) allCommands = [];
      });
  });

  // Open/refresh the menu from the caret, or close it once the text before the
  // caret is no longer a leading `/token`.
  function refreshSlash() {
    const caret = ta?.selectionStart ?? value.length;
    const trigger = matchSlashTrigger(value, caret);
    if (trigger) {
      slashOpen = true;
      slashQuery = trigger.query;
      slashTrigger = trigger.trigger;
      slashIndex = 0;
    } else {
      slashOpen = false;
    }
  }

  // Replace the typed `/query` token with the chosen command and hoist it to the
  // front — Claude only runs a *leading* slash command, so a command typed mid-text
  // becomes the leading command with the surrounding text as its argument. Caret
  // lands past `/name ` so the user can type arguments straight away.
  function pickCommand(cmd: SlashCommand) {
    const caret = ta?.selectionStart ?? value.length;
    const start = matchSlashTrigger(value, caret)?.start ?? 0;
    const next =
      agentProvider === "codex"
        ? applyMentionPick(value, start, caret, commandInvocationName(cmd))
        : applyCommandPick(value, start, caret, commandInvocationName(cmd));
    value = next.value;
    slashOpen = false;
    queueMicrotask(() => {
      autogrow();
      ta?.focus();
      ta?.setSelectionRange(next.caret, next.caret);
    });
  }

  // Canned steers (same presets as the SteerBar) drop into the field as an
  // editable draft rather than firing straight off — the compose sheet is a
  // "compose then Send" surface, so a steer is a starting point you can tweak.
  // Set when empty, append on a new line otherwise so a typed message is kept.
  function applySteer(text: string) {
    value = value.trim() ? value.trimEnd() + "\n" + text : text;
    slashOpen = false;
    queueMicrotask(() => {
      autogrow();
      ta?.focus();
      const end = value.length;
      ta?.setSelectionRange(end, end);
    });
  }

  // Tap-vs-drag for the horizontally-scrolling steer row (mirrors SteerBar): arm
  // on pointerdown, disarm once movement passes slop (a scroll) or the browser
  // takes the gesture, and only insert on a clean tap — so scrolling the row
  // never fires a chip.
  const STEER_SLOP = 10;
  let steerArmed: number | null = null;
  let steerSX = 0;
  let steerSY = 0;
  function steerDown(e: PointerEvent) {
    steerArmed = e.pointerId;
    steerSX = e.clientX;
    steerSY = e.clientY;
  }
  function steerMove(e: PointerEvent) {
    if (steerArmed !== e.pointerId) return;
    if (Math.abs(e.clientX - steerSX) > STEER_SLOP || Math.abs(e.clientY - steerSY) > STEER_SLOP)
      steerArmed = null;
  }
  function steerCancel(e: PointerEvent) {
    if (steerArmed === e.pointerId) steerArmed = null;
  }
  function steerTap(e: PointerEvent, text: string) {
    if (steerArmed !== e.pointerId) return;
    steerArmed = null;
    e.preventDefault();
    applySteer(text);
  }

  // Dictation (Web Speech / the local-Whisper voice plugin) lives in the shared controller —
  // $lib/dictation.svelte.ts owns the engine pick, recording, live interim preview and
  // teardown; this sheet just renders its state on the mic button and the lines below the field.
  const dict = createDictation({
    getText: () => value,
    setText: (t) => (value = t),
    onTextRendered: autogrow,
  });

  // Keep the sheet centered in the *visible* viewport — i.e. the area above the
  // soft keyboard — so the field and Send button never hide behind it. The
  // visualViewport shrinks/offsets when the keyboard opens; we mirror it onto
  // the overlay so flex-centering targets the on-screen region, not the full
  // (keyboard-occluded) window.
  function syncViewport() {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv || !overlayEl) return;
    overlayEl.style.height = `${vv.height}px`;
    overlayEl.style.transform = `translateY(${vv.offsetTop}px)`;
  }

  onMount(() => {
    syncViewport();
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.visualViewport?.addEventListener("scroll", syncViewport);
    // focus brings up the keyboard for typing; with the mic entry the user can
    // still edit the transcript inline
    ta?.focus();
    autogrow();
    // The mic dictate entry opens the sheet already listening — otherwise a local-only dictate
    // chip would open an idle sheet. The controller owns the engine pick and the probe/ready
    // sequencing (Web Speech synchronously; local once its pre-resolved status applies, still
    // inside the chip tap's getUserMedia activation window — a denial just flashes an error
    // and leaves the in-sheet mic).
    if (startDictation) dict.autoStart();
  });

  onDestroy(() => {
    dict.teardown();
    window.visualViewport?.removeEventListener("resize", syncViewport);
    window.visualViewport?.removeEventListener("scroll", syncViewport);
  });

  // grow with content (1 line → capped by CSS max-height, then scrolls)
  function autogrow() {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }

  function submit() {
    dict.teardown();
    slashOpen = false;
    onsend(value);
    value = "";
    onclose();
  }

  function cancel() {
    dict.teardown();
    onclose();
  }

  // insert a literal newline at the caret without submitting — Enter does this
  // on the soft keyboard (which has no Shift+Enter), so multi-line prompts build
  // naturally and Send is the sole submit. Escape dismisses the overlay.
  function insertNewline() {
    const start = ta?.selectionStart ?? value.length;
    const end = ta?.selectionEnd ?? value.length;
    const next = insertNewlineAt(value, start, end);
    value = next.value;
    queueMicrotask(() => {
      if (!ta) return;
      ta.selectionStart = ta.selectionEnd = next.caret;
      ta.focus();
      autogrow();
    });
  }

  // Enter inserts a newline (Send is the only submit). While the slash menu is
  // open it captures arrows/Enter/Tab/Escape to drive the picker (paired hardware
  // keyboard on a foldable/tablet; a tap on a row works regardless). Escape with
  // no menu open dismisses the whole overlay.
  function onKeydown(e: KeyboardEvent) {
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashIndex = (slashIndex + 1) % slashMatches.length;
        return;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length;
        return;
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCommand(slashMatches[slashIndex]!);
        return;
      } else if (e.key === "Escape") {
        e.preventDefault();
        slashOpen = false;
        return;
      }
    } else if (slashOpen && e.key === "Escape") {
      e.preventDefault();
      slashOpen = false;
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    insertNewline();
  }

  // pointerdown + preventDefault: fire instantly and never blur the textarea
  // (which would dismiss the mobile soft keyboard), matching ControlBar.
  function tapMic(e: PointerEvent) {
    e.preventDefault();
    // The controller stops a live session via the engine that STARTED it (not the current
    // `useLocal`, which may have flipped mid-session), else starts the engine picked now.
    dict.toggle();
  }
  function tapSend(e: PointerEvent) {
    e.preventDefault();
    submit();
  }
  // dismiss when tapping the dimmed backdrop, but not when tapping the sheet
  function tapBackdrop(e: PointerEvent) {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      cancel();
    }
  }
</script>

<div
  class="overlay"
  bind:this={overlayEl}
  role="dialog"
  aria-modal="true"
  aria-label={m.composebar_overlay_aria()}
  tabindex="-1"
  use:dialog={{ onclose: cancel }}
  onpointerdown={tapBackdrop}
>
  <div class="sheet">
    <button
      type="button"
      class="close"
      aria-label={m.common_close()}
      onpointerdown={(e) => {
        e.preventDefault();
        cancel();
      }}>✕</button
    >
    <div class="field-wrap">
      <textarea
        bind:this={ta}
        bind:value
        class="field"
        rows="1"
        inputmode="text"
        enterkeyhint="enter"
        autocapitalize="sentences"
        autocomplete="on"
        spellcheck="true"
        data-1p-ignore
        placeholder={m.composebar_placeholder()}
        aria-label={m.composebar_input_aria()}
        onkeydown={onKeydown}
        oninput={() => {
          autogrow();
          refreshSlash();
        }}
        onblur={() => (slashOpen = false)}></textarea>
      {#if slashOpen}
        <SlashCommandMenu
          commands={slashMatches}
          activeIndex={slashIndex}
          provider={commandProvider}
          placement="up"
          onpick={pickCommand}
          onhover={(i) => (slashIndex = i)}
        />
      {/if}
    </div>
    {#if availableSteers.length > 0}
      <div class="steers">
        {#each availableSteers as s (s.id)}
          <button
            type="button"
            class="steer-chip"
            title={s.text}
            onpointerdown={steerDown}
            onpointermove={steerMove}
            onpointercancel={steerCancel}
            onpointerup={(e) => steerTap(e, s.text)}>{s.label}</button
          >
        {/each}
      </div>
    {/if}
    {#if dict.voiceError}
      <div class="voice-hint" role="alert">{m.composebar_transcribe_failed()}</div>
    {/if}
    {#if dict.originEngine}
      <div class="voice-origin">
        {dict.originEngine === "local" ? m.composebar_origin_local() : m.composebar_origin_web()}
      </div>
    {/if}
    <div class="actions">
      {#if dict.micVisible}
        <button
          type="button"
          class="btn mic"
          class:listening={dict.listening}
          class:transcribing={dict.transcribing}
          disabled={dict.transcribing}
          aria-label={dict.transcribing
            ? m.composebar_transcribing()
            : dict.listening
              ? m.composebar_dictate_stop_aria()
              : m.composebar_dictate_aria()}
          aria-pressed={dict.listening}
          onpointerdown={tapMic}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <path d="M12 19v3" />
            <path d="M8 22h8" />
          </svg>
        </button>
      {/if}
      <button
        type="button"
        class="btn send"
        aria-label={m.composebar_send_aria()}
        onpointerdown={tapSend}>{m.composebar_send()}</button
      >
    </div>
  </div>
</div>

<style>
  /* full-screen blurred backdrop — the terminal shimmers through, dimmed, while
     the sheet stays legible. height/transform are set in JS to track the visual
     viewport so the sheet sits flush above the soft keyboard. align-items:flex-end
     anchors the sheet to the bottom edge (a rising bottom sheet), not the center. */
  .overlay {
    position: fixed;
    left: 0;
    top: 0;
    right: 0;
    z-index: 50;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: var(--color-scrim);
    -webkit-backdrop-filter: blur(3px);
    backdrop-filter: blur(3px);
  }

  .sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
    /* nearly opaque so the composed text reads clearly over the busy terminal */
    background: color-mix(in srgb, var(--color-head) 94%, transparent);
    border-top: 1px solid var(--color-line-bright);
    border-radius: 12px 12px 0 0;
    box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.5);
    /* rise from the bottom edge when summoned */
    animation: sheetRise 0.18s ease-out;
  }
  @keyframes sheetRise {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sheet {
      animation: none;
    }
  }

  .close {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: 2px;
    color: var(--color-faint);
    font-size: var(--fs-lg);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
  }
  .close:active {
    color: var(--color-ink);
    background: var(--color-inset);
  }
  .close:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* anchors the slash-command menu (positioned absolute) to the field */
  .field-wrap {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
  }

  .field {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 64px; /* starts a touch taller, then autogrows with content */
    max-height: 40vh; /* generous in the overlay, then scroll */
    margin-top: 4px;
    resize: none;
    padding: 10px 12px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    /* 16px — the iOS no-zoom minimum, so focusing the field never zooms the
       page (kept at the threshold on desktop too for steering legibility) */
    font-size: var(--fs-lg);
    line-height: 1.4;
    overflow-y: auto;
  }
  .field::placeholder {
    color: var(--color-faint);
  }
  .field:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }

  /* canned-steer row: scrolls horizontally so the presets never crowd the
     field or the Send button; hidden scrollbar like the SteerBar */
  .steers {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    white-space: nowrap;
    min-width: 0;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .steers::-webkit-scrollbar {
    display: none;
  }
  .steer-chip {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 12px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    cursor: pointer;
    touch-action: pan-x;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .steer-chip:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .steer-chip:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .actions {
    display: flex;
    align-items: stretch;
    gap: 8px;
  }

  .btn {
    flex: 0 0 auto;
    min-width: 44px;
    height: 44px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-lg);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  /* Send is the primary action — full width, weighted */
  .btn.send {
    flex: 1 1 auto;
    background: var(--color-line-bright);
  }
  .btn:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .btn.mic {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    line-height: 1;
  }
  .btn.mic svg {
    width: var(--icon-btn-glyph);
    height: var(--icon-btn-glyph);
    display: block;
  }
  /* while listening/transcribing: highlighted + a soft pulse so it reads as "working" */
  .btn.mic.listening,
  .btn.mic.transcribing {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
    animation: micPulse 1s ease-in-out infinite;
  }
  .btn.mic:disabled {
    cursor: default;
    opacity: 0.7;
  }
  @keyframes micPulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .btn.mic.listening,
    .btn.mic.transcribing {
      animation: none;
    }
  }

  /* transient error line above the action row when a transcription fails */
  .voice-hint {
    color: var(--color-red);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    padding: 0 2px;
  }

  /* subtle origin label above the action row — names which engine is capturing/transcribing
     this dictation (local Whisper vs the browser engine). Faint + neutral so it never competes
     with the field and never reads as an error; it is provenance, NOT a plugin health badge. */
  .voice-origin {
    color: var(--color-faint);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    padding: 0 2px;
  }
</style>
