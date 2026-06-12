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

function assertNativeForge(forge: GitForge): asserts forge is NativeForge {
  if (!forge.addSubIssue || !forge.addBlockedBy || !forge.listSubIssues || !forge.listBlockedBy)
    throw new Error("forge does not support native epic links");
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

async function wireDependencies(
  forge: NativeForge,
  edges: ReturnType<typeof parseEpicBody>["edges"],
  members: Set<number>,
  result: ImportResult,
): Promise<void> {
  const unresolved = new Set(result.unresolved);
  const byChild = new Map<number, number[]>();
  for (const e of edges) {
    if (e.blocker === e.dependent || !members.has(e.blocker)) continue;
    byChild.set(e.dependent, [...(byChild.get(e.dependent) ?? []), e.blocker]);
  }
  for (const [child, blockers] of byChild) {
    const existing = new Set(await forge.listBlockedBy(child));
    for (const b of blockers) {
      await tryAddBlockedBy(forge, child, b, existing, unresolved, result);
    }
  }
}

export async function importEpicLinks(
  forge: GitForge,
  parentNumber: number,
  body: string,
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
      continue;
    }
    try {
      await forge.addSubIssue(parentNumber, n);
      result.subIssuesAdded++;
    } catch {
      if (!result.unresolved.includes(n)) result.unresolved.push(n);
    }
  }

  await wireDependencies(forge, parsed.edges, members, result);
  return result;
}
