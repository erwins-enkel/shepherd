<script lang="ts">
  import { onDestroy } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { getLocale } from "$lib/i18n";
  import { insertNewlineAt } from "$lib/compose";

  // Mobile compose bar: a real <textarea> (not xterm's hidden one) so Android
  // autocomplete / suggestions / double-space-period resolve natively in the
  // field. We read its value once, on explicit submit — never diffing
  // per-keystroke into the PTY — so xterm's IME duplication bug can't occur.
  // Presentational: owns its own text + newline editing, emits the composed
  // string via onsend. The parent decides how to inject it into the terminal.
  let { onsend }: { onsend: (text: string) => void } = $props();

  let value = $state("");
  let ta = $state<HTMLTextAreaElement>();

  // In-browser dictation via the Web Speech API (Chrome/Android, Safari/iOS).
  // This is NOT the iOS keyboard's native dictation mic — no web API can summon
  // that — but it's the standards-based equivalent: one tap starts listening and
  // transcribes straight into this field, so there's no need to open the keyboard
  // and find its mic. Known gap: WebKit doesn't expose it inside an iOS
  // home-screen PWA (standalone display mode), only in the Safari browser tab —
  // so the button hides itself when unsupported rather than appearing dead.
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

  onDestroy(() => recog?.stop());

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
    queueMicrotask(autogrow); // shrink back after the binding clears
  }

  // insert a literal newline at the caret without submitting — Enter does this
  // on the soft keyboard (which has no Shift+Enter), so multi-line prompts build
  // naturally and Send is the sole submit
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

  // Enter inserts a newline (Send is the only submit). The compose bar is
  // touch-only — desktop steers xterm directly — so there's no hardware-keyboard
  // Enter-to-submit path to preserve here.
  function onKeydown(e: KeyboardEvent) {
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
</script>

<div class="compose">
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

<style>
  .compose {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    padding: 6px 10px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
  }

  .field {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 40px;
    max-height: 120px; /* ~5 lines, then scroll */
    resize: none;
    padding: 9px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 16px; /* ≥16px stops iOS focus-zoom */
    line-height: 1.3;
    overflow-y: auto;
  }
  .field::placeholder {
    color: var(--color-faint);
  }
  .field:focus {
    outline: none;
    border-color: var(--color-ink);
  }

  .btn {
    flex: 0 0 auto;
    min-width: 44px;
    height: 40px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 14px;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  /* the primary action gets a touch more weight */
  .btn.send {
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
