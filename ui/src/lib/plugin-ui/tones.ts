export type PuiTone = "neutral" | "ok" | "warn" | "error" | "info";

export const TONE_COLOR: Record<PuiTone, string> = {
  neutral: "var(--color-muted)",
  ok: "var(--color-green)",
  warn: "var(--status-warn)", // status token, NOT a --color-* token — matches PuiMeter verbatim
  error: "var(--color-red)",
  info: "var(--color-blue)",
};

/** Resolve a raw, untrusted tone prop to a CSS var, falling back to neutral. */
export function toneColor(raw: unknown): string {
  return typeof raw === "string" && raw in TONE_COLOR
    ? TONE_COLOR[raw as PuiTone]
    : TONE_COLOR.neutral;
}
