/** Coerce an untrusted prop to a finite number, else fallback. */
export function coerceNumber(raw: unknown, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce to a positive max (>= 1); used for meter/gauge/bar denominators. */
export function coerceMax(raw: unknown, fallback: number): number {
  return Math.max(1, coerceNumber(raw, fallback));
}

/** Coerce a label/caption: non-empty trimmed string, else null. */
export function coerceText(raw: unknown): string | null {
  return raw != null && String(raw).trim() !== "" ? String(raw) : null;
}
