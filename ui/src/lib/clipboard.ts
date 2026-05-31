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
