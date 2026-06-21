function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Operational archetypes excluded from per-task usage accounting: the merge-train
 *  session and /impeccable audits. Mirrors scripts/usage-report.ts's former
 *  isExcludedArchetype so snapshot, aggregation, and the report can never diverge. */
export function isOperationalArchetype(row: { name: string; prompt: string }): boolean {
  if (row.name === "merge-train") return true;
  if (norm(row.prompt).startsWith("/impeccable")) return true;
  return false;
}
