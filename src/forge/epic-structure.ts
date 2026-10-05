import { mapBounded } from "../map-bounded";
import type { EpicStructure, GitForge } from "./types";

/** Concurrency cap for the per-child blocked_by fan-out. Bounds `gh api` subprocesses so a large
 *  (100-child) epic can't exhaust FDs or trip GitHub's secondary rate limits. */
const BLOCKED_BY_CONCURRENCY = 8;

/**
 * Read an epic's structure call by call: the parent, its sub-issues, then one blocked_by read per
 * child — N + 2 calls for N children. The path for forges without a one-query
 * `getEpicStructure`, and the GitHub forge's REST fallback while GraphQL is unavailable (#2807).
 */
export async function readEpicStructureByParts(
  forge: Pick<GitForge, "getIssue" | "listSubIssues" | "listBlockedBy">,
  parentNumber: number,
): Promise<EpicStructure> {
  const parent = (await forge.getIssue?.(parentNumber)) ?? null;
  const subIssues = (await forge.listSubIssues?.(parentNumber)) ?? [];
  const entries = await mapBounded(
    subIssues,
    BLOCKED_BY_CONCURRENCY,
    async (s) => [s.number, (await forge.listBlockedBy?.(s.number)) ?? []] as const,
  );
  return { parent, subIssues, blockedBy: new Map(entries) };
}
