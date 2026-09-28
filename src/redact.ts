// Pattern-based secret redaction for bounded technical text (error details, CI log lines) before
// it reaches persistence, the UI, or an agent prompt. Best-effort: catches common token shapes and
// `KEY=value` assignments, not arbitrary secrets.

/** Replace common credential shapes in `s` with `<redacted>`. Whitespace is left untouched. */
export function redactSecretText(s: string): string {
  return s
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g,
      "$1$2<redacted>",
    )
    .replace(
      /\b(authorization|api[_ -]?key|token|password)(\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi,
      "$1$2<redacted>",
    )
    .replace(/\bbearer\s+[^\s,;]+/gi, "Bearer <redacted>")
    .replace(/\b(?:sk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, "<redacted>")
    .replace(/:\/\/([^\s/:@]+):([^\s/@]+)@/g, "://$1:<redacted>@");
}
