// Deep-link builder for GitHub issue forms.
//
// GitHub field-id pre-fill works by passing field ids as query params alongside
// `template=<file>.yml`. Without the template param the field-id params are
// silently ignored — the form opens blank. Field ids map verbatim to query param
// names (e.g. `what-happened=...`).
//
// URLs longer than ~8 KB trigger HTTP 414 from GitHub's edge. We cap at 7000
// bytes to leave headroom for browser/proxy overhead.

import { version, sha, commitUrl } from "./build-info";

export type FeedbackKind = "bug" | "feature" | "feedback";

// Maps each kind to the GitHub issue-form field id that receives the user's
// free-text description.
const KIND_FIELD: Record<FeedbackKind, string> = {
  bug: "what-happened",
  feature: "proposal",
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

const MAX_URL_BYTES = 7000;
const TRUNCATION_MARKER = "\n…[truncated]";
const TRUNCATION_CHUNK = 256;

/** Builds a GitHub new-issue deep-link URL for the given kind and options. */
export function buildIssueUrl(
  kind: FeedbackKind,
  opts: { title?: string; description?: string },
): string {
  const base = `https://github.com/erwins-enkel/shepherd/issues/new`;
  const fieldId = KIND_FIELD[kind];

  function buildUrl(description: string): string {
    const params = new URLSearchParams();
    params.set("template", `${kind}.yml`);
    if (opts.title) params.set("title", opts.title);
    if (description) params.set(fieldId, description);
    params.set("environment", buildEnvironment());
    return `${base}?${params.toString()}`;
  }

  let url = buildUrl(opts.description ?? "");

  if (url.length <= MAX_URL_BYTES || !opts.description) {
    return url;
  }

  // Iteratively shorten the description until under budget.
  const original = opts.description;
  let length = original.length - TRUNCATION_CHUNK;
  while (length > 0) {
    const shortened = original.slice(0, length).trimEnd() + TRUNCATION_MARKER;
    url = buildUrl(shortened);
    if (url.length <= MAX_URL_BYTES) return url;
    length -= TRUNCATION_CHUNK;
  }

  // Last resort: drop description entirely.
  return buildUrl("");
}
