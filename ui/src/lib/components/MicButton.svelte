<script lang="ts">
  import { onDestroy } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { createDictation } from "$lib/dictation.svelte";

  // Reusable dictation mic for any text field — mount it directly AFTER the field inside any
  // block container; no position:relative needed on the host. A zero-height in-flow anchor
  // hugs the field's bottom edge and the mic button is absolutely positioned against it, so it
  // floats inside the field's bottom-right corner and tracks the field's autogrow. The origin
  // and error lines render after the anchor in normal flow (below the field), OUTSIDE the
  // button's positioning context — they can never displace the button. The host should pad
  // the field's right edge while the mic is rendered so typed text never runs under it, e.g.
  //   .wrap:has(:global(.micbtn-anchor)) textarea { padding-right: 54px; }
  // Renders nothing when neither engine (Web Speech / voice-whisper plugin) is available.
  let {
    getText,
    setText,
    onTextRendered,
    inline = false,
  }: {
    /** Current field text (dictation appends after it). */
    getText: () => string;
    /** Replace the field text (live preview + final transcript). */
    setText: (text: string) => void;
    /** Fires deferred after every setText — wire the field's autogrow here. */
    onTextRendered?: () => void;
    /** In-flow toolbar variant: the button sits in normal flow (no floating anchor);
     *  the host sizes it via the .inline classes (New Task's in-field toolbar). */
    inline?: boolean;
  } = $props();

  // Closures (not the bare props) so the controller always calls the CURRENT prop value —
  // also silences state_referenced_locally, which flags capturing props at init time.
  const dict = createDictation({
    getText: () => getText(),
    setText: (t) => setText(t),
    onTextRendered: () => onTextRendered?.(),
  });

  /** Discard an in-flight recording WITHOUT uploading — hosts call this on submit;
   *  unmount (dialog close) does the same via onDestroy. */
  export function teardown() {
    dict.teardown();
  }

  onDestroy(() => dict.teardown());

  // pointerdown + preventDefault: fire instantly and never blur the field (which would
  // dismiss the mobile soft keyboard) — same rule as the compose sheet's mic.
  function tapMic(e: PointerEvent) {
    e.preventDefault();
    dict.toggle();
  }
</script>

{#if dict.micVisible}
  <div class={inline ? "micbtn-anchor inline" : "micbtn-anchor"}>
    <button
      type="button"
      class={inline ? "micbtn inline" : "micbtn"}
      class:listening={dict.listening}
      class:transcribing={dict.transcribing}
      class:error={dict.voiceError}
      disabled={dict.transcribing}
      aria-label={dict.transcribing
        ? m.micbtn_transcribing()
        : dict.listening
          ? m.micbtn_dictate_stop_aria()
          : m.micbtn_dictate_aria()}
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
  </div>
  {#if dict.voiceError}
    <div class="mic-hint" role="alert">{m.micbtn_transcribe_failed()}</div>
  {/if}
  {#if dict.originEngine}
    <div class="mic-origin">
      {dict.originEngine === "local" ? m.micbtn_origin_local() : m.micbtn_origin_web()}
    </div>
  {/if}
{/if}

<style>
  /* Zero-height anchor: sits in flow directly under the field, so `bottom` on the absolutely
     positioned button lands INSIDE the field's bottom-right corner and follows the field as
     it autogrows. Anything rendered after the anchor is outside this positioning context. */
  .micbtn-anchor {
    position: relative;
    height: 0;
  }
  /* Inline variant: in-flow inside the host's toolbar; the host provides sizing. */
  .micbtn-anchor.inline {
    position: static;
    height: auto;
    display: contents;
  }
  .micbtn.inline {
    position: static;
  }

  .micbtn {
    position: absolute;
    right: 6px;
    bottom: 6px;
    width: 44px;
    height: 44px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-lg);
    line-height: 1;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .micbtn svg {
    width: var(--icon-btn-glyph);
    height: var(--icon-btn-glyph);
    display: block;
  }
  .micbtn:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .micbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* while listening/transcribing: highlighted + a soft pulse so it reads as "working" */
  .micbtn.listening,
  .micbtn.transcribing {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
    animation: micPulse 1s ease-in-out infinite;
  }
  .micbtn.error {
    border-color: var(--color-red);
    color: var(--color-red);
  }
  .micbtn:disabled {
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
    .micbtn.listening,
    .micbtn.transcribing {
      animation: none;
    }
  }

  /* transient error line below the field when a transcription fails */
  .mic-hint {
    color: var(--color-red);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 4px 2px 0;
  }

  /* subtle origin label below the field — names which engine is capturing/transcribing this
     dictation (local Whisper vs the browser engine). Faint + neutral so it never reads as an
     error; it is provenance, NOT a plugin health badge. */
  .mic-origin {
    color: var(--color-faint);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 4px 2px 0;
  }
</style>
