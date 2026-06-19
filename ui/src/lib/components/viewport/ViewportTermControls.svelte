<script lang="ts">
  import { composeKeystrokes } from "$lib/compose";
  import { isSwipeUp } from "../swipe";
  import ControlBar from "$lib/components/ControlBar.svelte";
  import ComposeBar from "$lib/components/ComposeBar.svelte";
  import type { ControlKey } from "$lib/controlKeys";
  import { m } from "$lib/paraglide/messages";

  let {
    mobile,
    touch,
    tab,
    send,
    notesKey,
    enter,
    uploading,
    uploadFailed,
    attachImages,
    repoPath,
  }: {
    mobile: boolean;
    touch: boolean;
    tab: string;
    send: (seq: string) => void;
    notesKey: string | null;
    enter: ControlKey;
    uploading: boolean;
    uploadFailed: boolean;
    attachImages: (files: FileList | File[]) => void;
    repoPath: string;
  } = $props();

  let fileInput = $state<HTMLInputElement>();

  // mobile compose bar submit. Routing the composed line through here (as an
  // atomic bracketed paste) instead of xterm's textarea sidesteps the Android
  // IME duplication bug. See composeKeystrokes for the byte mapping.
  const sendComposed = (text: string) => send(composeKeystrokes(text));

  // the compose overlay is summoned on demand (swipe-up from the ctrl-row gutter,
  // or the ✎ chip), reclaiming the row the old always-on input bar occupied.
  // composeDictate opens the sheet already listening — the one-tap ◉ dictate chip sets
  // it; the compose-first entries (✎, swipe-up) leave it false so the keyboard
  // comes up to type.
  let composeOpen = $state(false);
  let composeDictate = $state(false);
  let ctrlRowEl: HTMLDivElement | undefined = $state();
  function openCompose() {
    composeDictate = false; // compose-first; the ◉ dictate toggle lives inside the sheet too
    composeOpen = true;
  }
  // one-tap dictate: opens the sheet already listening (preserves Kai's original
  // affordance), a peer of the ✎ compose entry rather than a step inside it.
  // Gated on Web Speech support so the chip never becomes a dead end where it's
  // unavailable (e.g. an iOS home-screen PWA); the sheet's own ◉ toggle hides
  // itself there the same way.
  const speechSupported =
    typeof window !== "undefined" &&
    !!(
      (window as { SpeechRecognition?: unknown }).SpeechRecognition ??
      (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
    );
  function openDictate() {
    composeDictate = true;
    composeOpen = true;
  }
  // Swipe up from the ctrl-row gutter to summon the compose sheet — a bottom-edge
  // gesture, so it never competes with the terminal's vertical scrollback (which
  // lives above the row). isSwipeUp ignores chip taps and horizontal pane swipes.
  // Listeners are bound in JS (not inline on the markup) so the row stays a plain
  // static container — the chips remain the interactive elements.
  $effect(() => {
    const row = ctrlRowEl;
    if (!row) return;
    let sx = 0;
    let sy = 0;
    let dx = 0;
    let dy = 0;
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      dx = dy = 0;
    };
    const move = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      dx = e.touches[0].clientX - sx;
      dy = e.touches[0].clientY - sy;
    };
    const end = () => {
      if (isSwipeUp(dx, dy, 36)) openCompose();
      dx = dy = 0;
    };
    row.addEventListener("touchstart", start, { passive: true });
    row.addEventListener("touchmove", move, { passive: true });
    row.addEventListener("touchend", end);
    return () => {
      row.removeEventListener("touchstart", start);
      row.removeEventListener("touchmove", move);
      row.removeEventListener("touchend", end);
    };
  });
</script>

{#if (mobile || touch) && tab === "term"}
  <div class="ctrl-row" bind:this={ctrlRowEl} data-swipe-ignore>
    <!-- Esc frozen on the left edge; Tab/Space + arrows + ^-keys scroll in the
         middle; attach/dictate/Enter frozen on the right. Tab/Space ride along
         in the scroll well so the frozen edge stays one button wide — on a
         portrait phone a wider frozen cluster squeezed the scroll window to ~2
         keys. There's no compose chip — swipe up from this row to summon the
         compose sheet. -->
    <ControlBar onkey={(seq) => send(seq)} include={["cancel"]} scroll={false} />
    <ControlBar onkey={(seq) => send(seq)} include={["edit", "nav", "signal"]} />
    <!-- only while Claude's prompt offers it: a pulsing "add notes" key. There's
         no keyboard on a phone to press the letter, so this is the sole way into
         the dialog's notes branch; it pulses to catch the eye and vanishes once
         the prompt does -->
    {#if notesKey}
      <button
        type="button"
        class="notes"
        aria-label={m.viewport_notes_aria({ key: notesKey })}
        onpointerup={(e) => {
          e.preventDefault();
          if (notesKey) send(notesKey);
        }}>✎ {notesKey.toUpperCase()}</button
      >
    {/if}
    <button
      type="button"
      class="attach"
      class:failed={uploadFailed}
      title={uploadFailed ? m.viewport_upload_failed() : m.viewport_attach_image()}
      onclick={() => fileInput?.click()}
      aria-label={m.viewport_attach_image()}
    >
      {#if uploading}
        <svg
          class="spin"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path
            d="M21 3v5h-5"
          /></svg
        >
      {:else if uploadFailed}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><path
            d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
          /><path d="M12 9v4" /><path d="M12 17h.01" /></svg
        >
      {:else}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path
            d="M12 3v12"
          /></svg
        >
      {/if}
    </button>
    {#if speechSupported}
      <button
        type="button"
        class="dictate"
        title={m.composebar_dictate_aria()}
        aria-label={m.composebar_dictate_aria()}
        onpointerdown={(e) => {
          e.preventDefault();
          openDictate();
        }}>{m.composebar_dictate()}</button
      >
    {/if}
    <button
      type="button"
      class="enter"
      aria-label={enter.aria}
      onpointerup={(e) => {
        e.preventDefault();
        send(enter.seq);
      }}>{enter.label}</button
    >
  </div>
  {#if composeOpen}
    <ComposeBar
      onsend={sendComposed}
      onclose={() => (composeOpen = false)}
      {repoPath}
      startDictation={composeDictate}
    />
  {/if}
  <input
    bind:this={fileInput}
    type="file"
    accept="image/*"
    multiple
    hidden
    onchange={(e) => {
      const t = e.currentTarget;
      if (t.files) attachImages(t.files);
      t.value = "";
    }}
  />
{/if}

<style>
  /* one unified bar across the whole row (scroll palette + pinned actions) */
  .ctrl-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-right: 10px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
  }
  .ctrl-row .dictate,
  .ctrl-row .attach,
  .ctrl-row .enter {
    flex: 0 0 auto;
    min-width: 44px;
    height: 44px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-size: var(--fs-lg);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .ctrl-row .dictate:active,
  .ctrl-row .attach:active,
  .ctrl-row .enter:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .ctrl-row .attach.failed {
    border-color: var(--color-red);
    color: var(--color-red);
  }
  .ctrl-row .attach {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .ctrl-row .attach svg {
    width: var(--fs-lg);
    height: var(--fs-lg);
    display: block;
  }
  /* Enter — primary affirmative action. Amber outline-ghost (transparent fill,
     amber border + text, inset amber glow) per the design-system primary recipe.
     Four-Light Rule: green is reserved for READY agent state; primary buttons
     are never solid-filled — always outline + inset glow. Mirrors EmptyHerd .spawn. */
  .ctrl-row .enter {
    font-family: var(--font-mono);
    font-size: var(--fs-xl);
    color: var(--color-amber);
    border-color: var(--color-amber);
    background: transparent;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .ctrl-row .enter:active {
    background: var(--color-hover);
    border-color: var(--color-amber);
    box-shadow: inset 0 0 22px -10px var(--color-amber);
  }
  /* "add notes" affordance — only mounted while Claude's prompt offers it. Amber
     (the same attention hue as the running pip) plus a soft halo pulse so it's
     noticed on a phone where there's no keyboard to press the key directly. The
     global prefers-reduced-motion guard stills the animation. */
  .ctrl-row .notes {
    flex: 0 0 auto;
    min-width: 44px;
    height: 44px;
    padding: 0 10px;
    border-radius: 2px;
    font-family: var(--font-mono);
    font-size: var(--fs-lg);
    letter-spacing: 0.04em;
    white-space: nowrap;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    color: var(--color-amber);
    border: 1px solid color-mix(in srgb, var(--color-amber) 60%, var(--color-line-bright));
    background: color-mix(in srgb, var(--color-amber) 16%, var(--color-inset));
    animation: notes-pulse 1.5s ease-in-out infinite;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .ctrl-row .notes:active {
    background: color-mix(in srgb, var(--color-amber) 32%, var(--color-inset));
    border-color: var(--color-amber);
  }
  @keyframes notes-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
    50% {
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-amber) 30%, transparent);
    }
  }
</style>
