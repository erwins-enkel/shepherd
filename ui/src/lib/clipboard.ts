/**
 * Extract image files from a clipboard/drag `DataTransferItemList`.
 *
 * Used by the terminal's paste handler: xterm only pastes text, so a copied
 * screenshot (Cmd/Ctrl+V) is otherwise dropped. We pull image items out here,
 * upload them, and inject their paths — the same flow as a drag-drop.
 */
export function imageFilesFromItems(items: DataTransferItemList | null | undefined): File[] {
  const out: File[] = [];
  if (!items) return out;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/**
 * Paste handler shared by the new-task form: if the clipboard carries image
 * files (Cmd/Ctrl+V of a screenshot), swallow the paste and hand the images to
 * `onImages`, returning `true`. A plain-text paste carries no image item, so we
 * leave the event untouched and return `false` — text paste falls through.
 */
export function handleImagePaste(e: ClipboardEvent, onImages: (files: File[]) => void): boolean {
  const imgs = imageFilesFromItems(e.clipboardData?.items);
  if (imgs.length === 0) return false;
  e.preventDefault();
  onImages(imgs);
  return true;
}
