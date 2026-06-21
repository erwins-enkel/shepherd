// Deep-link builder for GitHub issue forms.
//
// GitHub field-id pre-fill works by passing field ids as query params alongside
// `template=<file>.yml`. Without the template param the field-id params are
// silently ignored — the form opens blank. Field ids map verbatim to query param
// names (e.g. `what-happened=...`).
//
// URLs longer than ~8 KB trigger HTTP 414 from GitHub's edge. We cap the URL
// at 7000 characters to leave headroom for browser/proxy overhead. The cap is
// byte-accurate because a GitHub deep-link URL is all-ASCII (URLSearchParams
// percent-encodes every non-ASCII byte), so one char == one byte here.

import { version, sha, commitUrl, REPO_URL } from "./build-info";

export type FeedbackKind = "bug" | "feature" | "feedback";

// Maps each kind to the GitHub issue-form field id that receives the user's
// free-text description. Each is the form's REQUIRED field — routing the
// description elsewhere would leave the required field blank and GitHub would
// block submission.
const KIND_FIELD: Record<FeedbackKind, string> = {
  bug: "what-happened",
  feature: "problem",
  feedback: "feedback",
};

/** Returns a lean, SSR-safe multi-line environment block. */
export function buildEnvironment(): string {
  const lines: string[] = [`- Shepherd: v${version} (${sha})`, `- Commit: ${commitUrl}`];
  if (typeof navigator !== "undefined") {
    lines.push(`- User agent: ${navigator.userAgent}`);
    if (navigator.language) {
      lines.push(`- Locale: ${navigator.language}`);
    }
  }
  if (typeof window !== "undefined") {
    lines.push(`- Viewport: ${window.innerWidth}×${window.innerHeight}`);
  }
  return lines.join("\n");
}

const MAX_URL_CHARS = 7000;
const TRUNCATION_MARKER = "\n…[truncated]";
const TRUNCATION_CHUNK = 256;
// Hard bound on the title so a pasted, oversized title can't blow the URL past
// MAX_URL_CHARS on its own (the description-shortening loop never trims title).
// 256 is well under GitHub's stored-title limit; the issue form's title is a
// short summary anyway.
const MAX_TITLE_CHARS = 256;

/** Builds a GitHub new-issue deep-link URL for the given kind and options. */
export function buildIssueUrl(
  kind: FeedbackKind,
  opts: { title?: string; description?: string },
): string {
  const base = `${REPO_URL}/issues/new`;
  const fieldId = KIND_FIELD[kind];

  const rawTitle = opts.title ?? "";
  const title =
    rawTitle.length > MAX_TITLE_CHARS
      ? rawTitle.slice(0, MAX_TITLE_CHARS).trimEnd() + "…"
      : rawTitle;

  function buildUrl(description: string): string {
    const params = new URLSearchParams();
    params.set("template", `${kind}.yml`);
    if (title) params.set("title", title);
    if (description) params.set(fieldId, description);
    params.set("environment", buildEnvironment());
    return `${base}?${params.toString()}`;
  }

  let url = buildUrl(opts.description ?? "");

  if (url.length <= MAX_URL_CHARS || !opts.description) {
    return url;
  }

  // Iteratively shorten the description until under budget.
  const original = opts.description;
  let length = original.length - TRUNCATION_CHUNK;
  while (length > 0) {
    const shortened = original.slice(0, length).trimEnd() + TRUNCATION_MARKER;
    url = buildUrl(shortened);
    if (url.length <= MAX_URL_CHARS) return url;
    length -= TRUNCATION_CHUNK;
  }

  // Last resort: drop description entirely.
  return buildUrl("");
}
