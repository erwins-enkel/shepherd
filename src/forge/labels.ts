/**
 * Shared issue-label color helpers. Hex normalization is forge-agnostic (a `#rrggbb`
 * means the same on GitHub and Gitea), so — unlike the deliberately per-forge constants
 * (e.g. MAX_WORKFLOWS) — the rule lives in ONE place and both backends import it.
 */

/** Normalize a forge-supplied hex color (with or without a leading `#`) to `#rrggbb`
 *  lowercase. Returns undefined for anything that isn't exactly 6 hex digits. */
export function normalizeHex(c: string): string | undefined {
  const s = c.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s.toLowerCase()}` : undefined;
}

/** Build a name→`#rrggbb` map from a list of labels carrying an optional forge color,
 *  skipping any label with a missing/invalid color. Returns undefined (not `{}`) when
 *  no label contributed a color, so callers can omit the field entirely. */
export function labelColorsFrom(
  labels: Array<{ name?: string | null; color?: string | null }>,
): Record<string, string> | undefined {
  const labelColors: Record<string, string> = {};
  for (const l of labels) {
    const c = l.color ? normalizeHex(l.color) : undefined;
    if (l.name && c) labelColors[l.name] = c;
  }
  return Object.keys(labelColors).length ? labelColors : undefined;
}
