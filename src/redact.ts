// Pattern-based secret redaction for bounded technical text (error details, CI log lines) before
// it reaches persistence, the UI, or an agent prompt. Best-effort: catches common token shapes and
// `KEY=value` assignments, not arbitrary secrets.

/** Shorter values are never registered: substring-matching a 1–3 char value would mangle
 *  unrelated text, and a secret that short protects nothing anyway. */
const MIN_KNOWN_SECRET_LENGTH = 4;

/** Exact secret values the operator stored (per-repo agent secrets), longest first so a value
 *  nested inside another never gets replaced first and leaves the longer one's tail in clear. */
let knownSecretValues: string[] = [];

/** Replace the registry of exact secret values that every redaction pass scrubs. */
export function setKnownSecretValues(values: string[]): void {
  knownSecretValues = [...new Set(values)]
    .filter((v) => typeof v === "string" && v.length >= MIN_KNOWN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of a registered secret value in `s` with `<redacted>`. */
export function redactKnownSecretValues(s: string): string {
  let out = s;
  for (const v of knownSecretValues) if (out.includes(v)) out = out.split(v).join("<redacted>");
  return out;
}

/** Replace registered secret values and common credential shapes in `s` with `<redacted>`.
 *  Whitespace is left untouched. */
export function redactSecretText(s: string): string {
  // Token literals match dot-joined continuations too: App installation tokens are `ghs_` +
  // base64url segments joined by `.`, so stopping at the first `.` would leave most in clear.
  return redactKnownSecretValues(s)
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g,
      "$1$2<redacted>",
    )
    .replace(
      /\b(authorization|api[_ -]?key|token|password)(\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi,
      "$1$2<redacted>",
    )
    .replace(/\bbearer\s+[^\s,;]+/gi, "Bearer <redacted>")
    .replace(
      /\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*\b/gi,
      "<redacted>",
    )
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<redacted>")
    .replace(/:\/\/([^\s/:@]+):([^\s/@]+)@/g, "://$1:<redacted>@");
}
