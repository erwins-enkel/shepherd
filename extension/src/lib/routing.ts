import type { RoutingRule } from "./types";

/** Escape every regex metacharacter so a glob is matched literally except `*`. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve a capture's effective repo from its URL. Rules are tried in order;
 * each `pattern` is a glob (`*` = any run of chars) matched anchored and
 * case-insensitively against the full URL. The first match's `repoPath` wins;
 * with no match (or no rules) the `fallback` repo is returned. Blank-field rules
 * are skipped, and a pattern that can't compile to a RegExp is treated as a
 * no-match rather than throwing.
 */
export function resolveRepo(url: string, rules: RoutingRule[], fallback: string): string {
  for (const rule of rules) {
    if (rule.pattern.trim() === "" || rule.repoPath.trim() === "") continue;
    // Escape first, THEN open up the (now-escaped) `*` into `.*` so only the
    // glob wildcard is special — every other char is literal.
    const source = "^" + escapeRegex(rule.pattern).replace(/\\\*/g, ".*") + "$";
    try {
      if (new RegExp(source, "i").test(url)) return rule.repoPath;
    } catch {
      /* invalid pattern → no match */
    }
  }
  return fallback;
}
