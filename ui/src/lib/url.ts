/**
 * Return the first candidate that parses as a safe `http:`/`https:` URL, else null.
 *
 * These candidates can carry untrusted forge data (a `ReviewVerdict.url`, a git
 * remote url), so before we render an `<a href>` or navigate to one we reject any
 * non-http(s) scheme — `javascript:`, `data:`, `mailto:`, … — and unparseable strings.
 */
export function firstSafeHttpUrl(...candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    try {
      const proto = new URL(c).protocol;
      if (proto === "http:" || proto === "https:") return c;
    } catch {
      // unparseable — skip
    }
  }
  return null;
}
