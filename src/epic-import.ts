import { parseEpicBody } from "./epic-parse";
import type { GitForge } from "./forge/types";

export interface ImportResult {
  subIssuesAdded: number;
  dependenciesAdded: number;
  skipped: number;
  unresolved: number[];
}

type NativeForge = Required<
  Pick<GitForge, "addSubIssue" | "addBlockedBy" | "listSubIssues" | "listBlockedBy">
> &
  GitForge;

/** True when the forge can wire native sub-issue + blocked_by links. */
export function supportsNativeEpicLinks(forge: GitForge): forge is NativeForge {
  return !!(forge.addSubIssue && forge.addBlockedBy && forge.listSubIssues && forge.listBlockedBy);
}

function assertNativeForge(forge: GitForge): asserts forge is NativeForge {
  if (!supportsNativeEpicLinks(forge)) throw new Error("forge does not support native epic links");
}

/** Attempt to add one blocked-by edge; mutates result and unresolved in place. */
async function tryAddBlockedBy(
  forge: NativeForge,
  child: number,
  blocker: number,
  existing: Set<number>,
  unresolved: Set<number>,
  result: ImportResult,
): Promise<void> {
  if (unresolved.has(blocker)) return;
  if (existing.has(blocker)) {
    result.skipped++;
    return;
  }
  try {
    await forge.addBlockedBy(child, blocker);
    result.dependenciesAdded++;
  } catch {
    if (!unresolved.has(blocker)) {
      unresolved.add(blocker);
      result.unresolved.push(blocker);
    }
  }
}

/** Dependent child → its in-epic blockers (self-edges and non-member blockers dropped). */
function blockersByChild(
  edges: ReturnType<typeof parseEpicBody>["edges"],
  members: Set<number>,
): Map<number, number[]> {
  const byChild = new Map<number, number[]>();
  for (const e of edges) {
    if (e.blocker === e.dependent || !members.has(e.blocker)) continue;
    byChild.set(e.dependent, [...(byChild.get(e.dependent) ?? []), e.blocker]);
  }
  return byChild;
}

/** How many times {@link importEpicLinks} calls `onStep` for this body: one per member sub-issue,
 *  one per dependent child whose blockers it wires. Lets a caller size a progress bar up front. */
export function countEpicLinkSteps(body: string): number {
  const parsed = parseEpicBody(body);
  return parsed.order.length + blockersByChild(parsed.edges, new Set(parsed.members)).size;
}

async function wireDependencies(
  forge: NativeForge,
  edges: ReturnType<typeof parseEpicBody>["edges"],
  members: Set<number>,
  result: ImportResult,
  onStep?: () => void,
): Promise<void> {
  const unresolved = new Set(result.unresolved);
  for (const [child, blockers] of blockersByChild(edges, members)) {
    const existing = new Set(await forge.listBlockedBy(child));
    for (const b of blockers) {
      await tryAddBlockedBy(forge, child, b, existing, unresolved, result);
    }
    onStep?.();
  }
}

export async function importEpicLinks(
  forge: GitForge,
  parentNumber: number,
  body: string,
  /** Called after each counted step — see {@link countEpicLinkSteps}. */
  onStep?: () => void,
): Promise<ImportResult> {
  assertNativeForge(forge);
  const parsed = parseEpicBody(body);
  const members = new Set(parsed.members);
  const result: ImportResult = {
    subIssuesAdded: 0,
    dependenciesAdded: 0,
    skipped: 0,
    unresolved: [],
  };

  const existingSubs = new Set((await forge.listSubIssues(parentNumber)).map((s) => s.number));
  for (const n of parsed.order) {
    if (existingSubs.has(n)) {
      result.skipped++;
    } else {
      try {
        await forge.addSubIssue(parentNumber, n);
        result.subIssuesAdded++;
      } catch {
        if (!result.unresolved.includes(n)) result.unresolved.push(n);
      }
    }
    onStep?.();
  }

  await wireDependencies(forge, parsed.edges, members, result, onStep);
  return result;
}
