<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { getLocale } from "$lib/i18n";
  import { insertNewlineAt } from "$lib/compose";

  // Centered compose overlay: a real <textarea> (not xterm's hidden one) so
  // Android autocomplete / suggestions / double-space-period resolve natively
  // in the field. We read its value once, on explicit submit — never diffing
  // per-keystroke into the PTY — so xterm's IME duplication bug can't occur.
  // The overlay floats over the terminal with a blurred backdrop; the parent
  // mounts it on demand (mic chip) and decides how to inject the composed text.
  // Presentational: owns its own text + newline editing + dictation, emits the
  // composed string via onsend and a dismissal via onclose.
  let {
    onsend,
    onclose,
    startDictation = false,
  }: {
    onsend: (text: string) => void;
    onclose: () => void;
    // open the overlay already listening (mic-chip entry); typing-only entries
    // pass false so the keyboard comes up without recording
    startDictation?: boolean;
  } = $props();

  let value = $state("");
  let ta = $state<HTMLTextAreaElement>();
  let overlayEl = $state<HTMLDivElement>();

  // In-browser dictation via the Web Speech API (Chrome/Android, Safari/iOS).
  // This is NOT the iOS keyboard's native dictation mic — no web API can summon
  // that — but it's the standards-based equivalent: transcribes straight into
  // this field. Known gap: WebKit doesn't expose it inside an iOS home-screen
  // PWA (standalone display mode), only in the Safari browser tab. When
  // unsupported the in-overlay mic toggle hides itself and the overlay is a
  // plain type-and-send sheet — so the entry point never becomes a dead end.
  const SpeechRec: any =
    typeof window !== "undefined"
      ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition)
      : undefined;
  let speechSupported = $state(!!SpeechRec);
  let listening = $state(false);
  let recog: any = null;

  function toggleDictation() {
    if (!SpeechRec) return;
    if (listening) {
      recog?.stop();
      return;
    }
    recog = new SpeechRec();
    recog.lang = getLocale() === "de" ? "de-DE" : "en-US";
    recog.interimResults = true;
    recog.continuous = true;
    let base = value; // text already typed before dictation started
    recog.onresult = (e: any) => {
      let finalChunk = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalChunk += t;
        else interim += t;
      }
      if (finalChunk) base = (base ? base.trimEnd() + " " : "") + finalChunk.trim();
      value = interim ? (base ? base.trimEnd() + " " : "") + interim.trim() : base;
      queueMicrotask(autogrow);
    };
    recog.onend = () => {
      listening = false;
    };
    recog.onerror = () => {
      listening = false;
    };
    recog.start();
    listening = true;
  }

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
    if (startDictation && speechSupported) toggleDictation();
  });

  onDestroy(() => {
    recog?.stop();
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
    recog?.stop();
    listening = false;
    onsend(value);
    value = "";
    onclose();
  }

  function cancel() {
    recog?.stop();
    listening = false;
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

  function onKeydown(e: KeyboardEvent) {
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
    toggleDictation();
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
      placeholder={m.composebar_placeholder()}
      aria-label={m.composebar_input_aria()}
      onkeydown={onKeydown}
      oninput={autogrow}
    ></textarea>
    <div class="actions">
      {#if speechSupported}
        <button
          type="button"
          class="btn mic"
          class:listening
          aria-label={listening ? m.composebar_dictate_stop_aria() : m.composebar_dictate_aria()}
          aria-pressed={listening}
          onpointerdown={tapMic}>{m.composebar_dictate()}</button
        >
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
     the sheet stays legible. height/transform are set in JS to track the
     visual viewport so the sheet centers above the keyboard. */
  .overlay {
    position: fixed;
    left: 0;
    top: 0;
    right: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(0, 0, 0, 0.45);
    -webkit-backdrop-filter: blur(3px);
    backdrop-filter: blur(3px);
  }

  .sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    max-width: 560px;
    padding: 14px;
    /* nearly opaque so the dictated text reads clearly over the busy terminal */
    background: color-mix(in srgb, var(--color-head) 94%, transparent);
    border: 1px solid var(--color-line-bright);
    border-radius: 8px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }

  .close {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: 3px;
    color: var(--color-faint);
    font-size: 15px;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
  }
  .close:active {
    color: var(--color-ink);
    background: var(--color-inset);
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
    border-radius: 3px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    /* a touch smaller for density; under the 16px iOS no-zoom threshold, an
       accepted tradeoff since the overlay is centered and not edge-pinned */
    font-size: 14px;
    line-height: 1.4;
    overflow-y: auto;
  }
  .field::placeholder {
    color: var(--color-faint);
  }
  .field:focus {
    outline: none;
    border-color: var(--color-ink);
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
    border-radius: 3px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 15px;
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
  .btn.mic {
    font-size: 16px;
    line-height: 1;
  }
  /* while listening: highlighted + a soft pulse so it reads as "recording" */
  .btn.mic.listening {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
    animation: micPulse 1s ease-in-out infinite;
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
    .btn.mic.listening {
      animation: none;
    }
  }
</style>
