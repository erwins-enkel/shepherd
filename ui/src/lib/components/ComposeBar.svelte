<script lang="ts">
  import { replySession } from "$lib/api";
  import { m } from "$lib/paraglide/messages";

  // A native <textarea> entry point for mobile. Unlike xterm's hidden helper
  // textarea — whose every keystroke is streamed straight to the PTY — this
  // field lets the browser own the edit buffer, so iOS/Android voice dictation
  // (which inserts provisional guesses and *replaces* them in place as it
  // revises) resolves to one final string. Only on send does the text go to the
  // session, as a human-style steer (herdr appends the Enter). Sending interim
  // dictation guesses into an append-only PTY is what garbled the prompt before.
  let {
    focusedId,
    registerInput,
  }: { focusedId: string; registerInput?: (el: HTMLTextAreaElement) => void } = $props();

  let text = $state("");
  let flash = $state<string | null>(null);
  let ta = $state<HTMLTextAreaElement>();

  // hand the element to the parent so tapping the terminal can focus *this*
  // safe field instead of xterm's stream-everything helper textarea
  $effect(() => {
    if (ta) registerInput?.(ta);
  });

  // grow with content up to the CSS max-height, then scroll internally
  function autosize() {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }

  function send() {
    const t = text.trim();
    if (!t) return;
    replySession(focusedId, text).catch(() => {
      flash = m.composebar_send_failed();
      setTimeout(() => (flash = null), 1500);
    });
    text = "";
    // reset height after the bound value clears
    queueMicrotask(autosize);
  }

  // Enter inserts a newline (multi-line prompts); the send button submits.
  // Don't bind Enter-to-send: soft keyboards offer no Shift+Enter for newline.
</script>

<div class="compose-bar">
  <textarea
    bind:this={ta}
    bind:value={text}
    rows="1"
    enterkeyhint="enter"
    placeholder={m.composebar_placeholder()}
    aria-label={m.composebar_input_aria()}
    oninput={autosize}
  ></textarea>
  <button
    type="button"
    class="send"
    disabled={!text.trim()}
    aria-label={m.composebar_send_aria()}
    onpointerdown={(e) => {
      e.preventDefault();
      send();
    }}>➤</button
  >
  {#if flash}<span class="flash">{flash}</span>{/if}
</div>

<style>
  .compose-bar {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 6px 10px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
  }

  textarea {
    flex: 1 1 auto;
    min-width: 0;
    resize: none;
    max-height: 96px;
    padding: 8px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.4;
    overflow-y: auto;
  }

  textarea:focus {
    outline: none;
    border-color: var(--color-ink);
  }

  textarea::placeholder {
    color: var(--color-faint);
  }

  .send {
    flex: 0 0 auto;
    width: 44px;
    height: 40px;
    background: var(--color-inset);
    border: 1px solid var(--color-amber);
    border-radius: 3px;
    color: var(--color-amber);
    font-size: 16px;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      opacity 0.08s;
  }

  .send:disabled {
    opacity: 0.4;
    border-color: var(--color-line-bright);
    color: var(--color-faint);
    cursor: default;
  }

  .send:not(:disabled):active {
    background: var(--color-line-bright);
  }

  .flash {
    align-self: center;
    color: var(--color-red);
    font-size: 11px;
    padding-left: 4px;
  }
</style>
