<script lang="ts" module>
  /** An image for the next assistant message; `path` null = still uploading. */
  export type Attachment = { id: number; file: File; path: string | null; failed: boolean };
</script>

<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import AttachmentChip from "../new-task/AttachmentChip.svelte";

  let {
    attachments,
    coarse,
    onremove,
  }: {
    attachments: readonly Attachment[];
    coarse: boolean;
    onremove: (id: number) => void;
  } = $props();
</script>

<div class="ac-attachments">
  {#each attachments as a (a.id)}
    <span class="ac-attachment" class:ac-failed={a.failed}>
      <AttachmentChip
        name={a.file.name || m.assistant_chat_attachment_image()}
        previewFile={a.file}
        {coarse}
        onremove={() => onremove(a.id)}
      />
      {#if a.path === null && !a.failed}
        <span class="ac-uploading" role="status">{m.assistant_chat_attachment_uploading()}</span>
      {/if}
    </span>
  {/each}
</div>

<style>
  .ac-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .ac-attachment {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
  }
  .ac-failed :global(.chip) {
    border-color: var(--color-red);
  }
  .ac-uploading {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
  }
</style>
