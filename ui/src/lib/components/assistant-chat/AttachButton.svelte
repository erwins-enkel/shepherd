<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";

  // The composer's paperclip: a file picker for images.
  let { disabled, onfiles }: { disabled: boolean; onfiles: (files: FileList) => void } = $props();

  let input: HTMLInputElement | undefined = $state();
</script>

<input
  bind:this={input}
  type="file"
  accept="image/*"
  multiple
  hidden
  onchange={(e) => {
    const t = e.currentTarget;
    if (t.files) onfiles(t.files);
    t.value = "";
  }}
/>
<button
  type="button"
  class="ac-attach"
  {disabled}
  aria-label={m.assistant_chat_attach()}
  title={m.assistant_chat_attach()}
  onclick={() => input?.click()}
  ><svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    ><path
      d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
    /></svg
  ></button
>

<style>
  /* Button recipe (/design-system .gbtn), icon-only. */
  .ac-attach {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 30px;
    padding: 4px 6px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    cursor: pointer;
  }
  .ac-attach:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .ac-attach:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .ac-attach:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .ac-attach svg {
    width: 14px;
    height: 14px;
  }
  @media (pointer: coarse) {
    .ac-attach {
      min-height: 44px;
    }
  }
</style>
