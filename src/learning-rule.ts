/** Canonical key used for exact learning-rule deduplication and prune tombstones. */
export function normalizeRule(rule: string): string {
  return rule.trim().toLowerCase().replace(/\s+/g, " ");
}
