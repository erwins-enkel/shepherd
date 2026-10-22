/** The closing reference for an issue: `#n` in this repo, or `owner/name#n` when the issue lives in
 *  another repo's tracker (#3245, a routed ticket). */
function issueRef(
  issueNumber: number,
  issueSlug: string | undefined,
  ownSlug: string | null,
): string {
  const foreign = !!issueSlug && issueSlug.toLowerCase() !== (ownSlug ?? "").toLowerCase();
  return foreign ? `${issueSlug}#${issueNumber}` : `#${issueNumber}`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `body` with a `Closes <ref>` line appended, or null when it already carries a closing keyword
 *  for that issue. A cross-repo issue also counts as linked by its full issue URL. Shared by the
 *  forges' `ensureIssueLink`. */
export function bodyWithIssueLink(
  body: string,
  issueNumber: number,
  issueSlug: string | undefined,
  ownSlug: string | null,
): string | null {
  const ref = issueRef(issueNumber, issueSlug, ownSlug);
  const target = ref.startsWith("#")
    ? `#${issueNumber}`
    : `(?:${escape(issueSlug!)}#${issueNumber}|https?://\\S+/${escape(issueSlug!)}/issues/${issueNumber})`;
  const pattern = new RegExp(
    `(?<![\\w/])(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+${target}\\b`,
    "i",
  );
  if (pattern.test(body)) return null;
  return body ? `${body}\n\nCloses ${ref}` : `Closes ${ref}`;
}
