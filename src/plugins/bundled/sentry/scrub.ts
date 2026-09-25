// PII / secret scrubbing for Sentry-sourced text before it reaches an issue body (#2464).
// Deliberately over-eager: a redacted token in a stack trace costs nothing, a leaked one does.

const SECTION_MAX = 4000;

type Rule = [RegExp, string | ((m: string) => string)];

const RULES: Rule[] = [
  // JWTs (header.payload.signature, base64url).
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, "[jwt]"],
  // Authorization-style schemes.
  [/\b(Bearer|Basic|Token)\s+[\w.~+/=-]{8,}/gi, "$1 [redacted]"],
  // key=value / key: value secrets (query strings, headers, JSON-ish dumps).
  [
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|session(?:id)?|cookie|authorization|dsn)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    "$1[redacted]",
  ],
  // DSN-ish credentials in URLs: scheme://user:pass@host or scheme://key@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1[redacted]@"],
  // Emails.
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  // URL query-string values.
  [/([?&][^=\s&#?]{1,64})=[^&#\s"']*/g, "$1=[redacted]"],
  // UUIDs.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]"],
  // IPv4.
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  // IPv6 — only when it has `::` or a hex letter, so `12:30:45` clock times survive.
  [
    /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi,
    (m) => (/::|[a-f]/i.test(m) && m.split(":").length >= 3 ? "[ip]" : m),
  ],
  // Long hex blobs (hashes, keys).
  [/\b[0-9a-f]{32,}\b/gi, "[redacted]"],
  // Long base64/base64url-ish tokens mixing letters and digits (no `/`, so paths survive).
  [/\b(?=[\w+-]*\d)(?=[\w+-]*[A-Za-z])[\w+-]{40,}={0,2}/g, "[redacted]"],
];

/** Scrub PII/secrets from `text`, strip control chars (keeps `\n`/`\t`), cap to `max` chars. */
export function scrub(text: string, max = SECTION_MAX): string {
  // eslint-disable-next-line no-control-regex
  let out = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  for (const [re, rep] of RULES) {
    out = typeof rep === "string" ? out.replace(re, rep) : out.replace(re, rep);
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
