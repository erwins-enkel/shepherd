/** How many categorical `--data-N` tokens app.css defines (`--data-1` … `--data-7`). */
export const DATA_SLOTS = 7;

/**
 * A stable categorical colour slot (1..{@link DATA_SLOTS}) for a name — the `N` in
 * `var(--data-N)`. FNV-1a over the UTF-16 code units, so the same name always lands
 * on the same hue (repo marks, label chips) without storing a colour anywhere.
 */
export function dataSlot(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % DATA_SLOTS) + 1;
}
