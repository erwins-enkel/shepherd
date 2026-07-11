import type { Epic, EpicSource } from "./epic-core";
import type { ParsedEpic } from "./epic-parse";
import type { SubIssueRef } from "./forge/types";
import { MARKDOWN_TRUNCATION_WARNING } from "./epic-model";

export type EpicDiagnosisSeverity = "info" | "warning" | "error";

/** A safe repair the UI may offer inline (behind explicit confirmation). */
export type EpicDiagnosisAction = "import-structure";

export interface EpicDiagnosisFinding {
  /** stable slug — the UI maps it to an i18n message key. One of the ids below. */
  id: string;
  severity: EpicDiagnosisSeverity;
  /** interpolation params for the UI copy (numbers or pre-joined "#n, #m" strings). */
  params?: Record<string, string | number>;
  action?: EpicDiagnosisAction;
}

export interface EpicDiagnosis {
  parentIssueNumber: number;
  recognized: boolean; // children.length > 0
  source: EpicSource | null; // null when unrecognized (no children)
  findings: EpicDiagnosisFinding[];
  /** epic.warnings entries NOT already represented by a structured finding, verbatim. */
  additionalWarnings: string[];
}

export interface EpicDiagnosisInput {
  epic: Epic; // assembled epic (source/children/warnings/noDependencyEdges)
  subIssues: SubIssueRef[]; // raw native sub-issues (may be empty)
  blockedBy: Map<number, number[]>; // raw native edges: child -> blocker numbers
  parsedBody: ParsedEpic; // parseEpicBody(parent.body)
  openIssuesTruncated: boolean; // markdown-source 200-cap hit
}

/** These fragments mirror the runtime warning strings assembleEpic emits in
 *  `src/epic-model.ts:95,117,121` (the exported MARKDOWN_TRUNCATION_WARNING plus the
 *  self-loop / outside-epic ignore notes). We match on them here to de-dupe warnings
 *  already represented by a structured finding. The drift-guard test in
 *  epic-diagnosis.test.ts protects them against silent wording changes in epic-model.ts. */
const SELF_DEP_FRAGMENT = "blocked_by itself — ignored";
const OUTSIDE_EPIC_FRAGMENT = "is outside the epic — ignored";

function isStructurallyCovered(w: string): boolean {
  return (
    w === MARKDOWN_TRUNCATION_WARNING ||
    w.includes(SELF_DEP_FRAGMENT) ||
    w.includes(OUTSIDE_EPIC_FRAGMENT)
  );
}

/** Build the raw child→blockers list from the ACTIVE source's RAW edges (NOT
 *  epic.children — assembleEpic already strips self/outside edges from
 *  EpicChild.blockedBy, so the children carry none of the ones we want to surface). */
function rawEdges(input: EpicDiagnosisInput, source: EpicSource): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (source === "native") {
    for (const [child, blockers] of input.blockedBy) {
      for (const b of blockers) out.push([child, b]);
    }
  } else {
    for (const e of input.parsedBody.edges) out.push([e.dependent, e.blocker]);
  }
  return out;
}

function joinNums(nums: number[]): string {
  return [...nums]
    .sort((a, b) => a - b)
    .map((n) => `#${n}`)
    .join(", ");
}

/** Self-loop / outside-epic dependency findings, recomputed from the active source's RAW edges
 *  (deduped, ordered ascending by child then blocker). */
function edgeFindings(
  input: EpicDiagnosisInput,
  source: EpicSource,
  members: Set<number>,
): EpicDiagnosisFinding[] {
  const selfSeen = new Set<number>();
  const outsideSeen = new Set<string>();
  const selfFindings: EpicDiagnosisFinding[] = [];
  const outsideFindings: EpicDiagnosisFinding[] = [];
  const ordered = rawEdges(input, source).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [child, blocker] of ordered) {
    if (blocker === child) {
      if (selfSeen.has(child)) continue;
      selfSeen.add(child);
      selfFindings.push({ id: "self-dependency", severity: "warning", params: { child } });
    } else if (!members.has(blocker)) {
      const key = `${child}:${blocker}`;
      if (outsideSeen.has(key)) continue;
      outsideSeen.add(key);
      outsideFindings.push({
        id: "outside-epic-dependency",
        severity: "warning",
        params: { child, blocker },
      });
    }
  }
  return [...selfFindings, ...outsideFindings];
}

/** native-body-disagree — GUARDED: only for a native epic whose non-empty parsed body declares a
 *  member set differing from the native sub-issue numbers (a stale checklist vs native links). */
function nativeBodyDisagreeFinding(input: EpicDiagnosisInput): EpicDiagnosisFinding | null {
  if (input.epic.source !== "native" || input.parsedBody.members.length === 0) return null;
  const bodySet = new Set(input.parsedBody.members);
  const nativeSet = new Set(input.subIssues.map((s) => s.number));
  const onlyInBody = [...bodySet].filter((n) => !nativeSet.has(n));
  const onlyInNative = [...nativeSet].filter((n) => !bodySet.has(n));
  if (onlyInBody.length === 0 && onlyInNative.length === 0) return null;
  return {
    id: "native-body-disagree",
    severity: "warning",
    params: { onlyInBody: joinNums(onlyInBody), onlyInNative: joinNums(onlyInNative) },
  };
}

export function diagnoseEpic(input: EpicDiagnosisInput): EpicDiagnosis {
  const { epic } = input;
  const additionalWarnings = epic.warnings.filter((w) => !isStructurallyCovered(w));

  // no-children — unrecognized. Nothing else is meaningful; return early with source:null.
  if (epic.children.length === 0) {
    return {
      parentIssueNumber: epic.parentIssueNumber,
      recognized: false,
      source: null,
      findings: [{ id: "no-children", severity: "error" }],
      additionalWarnings,
    };
  }

  const source = epic.source;
  const members = new Set(epic.children.map((c) => c.number));
  const findings: EpicDiagnosisFinding[] = [];

  if (source === "markdown") {
    findings.push({ id: "markdown-source", severity: "info", action: "import-structure" });
    if (input.openIssuesTruncated) {
      findings.push({ id: "truncated-open-list", severity: "warning", action: "import-structure" });
    }
  }

  if (epic.noDependencyEdges === true) {
    const count = epic.children.filter((c) => c.state === "ready").length;
    findings.push({ id: "all-parallel", severity: "warning", params: { count } });
  }

  findings.push(...edgeFindings(input, source, members));

  const disagree = nativeBodyDisagreeFinding(input);
  if (disagree) findings.push(disagree);

  return {
    parentIssueNumber: epic.parentIssueNumber,
    recognized: true,
    source,
    findings,
    additionalWarnings,
  };
}
