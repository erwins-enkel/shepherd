/**
 * Pure logic extracted from IssuesPanel.svelte — unit-testable without a DOM.
 */

/**
 * Compute the age in whole days relative to `now` (defaults to Date.now()).
 * Returns a non-negative integer.
 */
export function issueAgeDays(createdAt: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - createdAt) / 86_400_000));
}
