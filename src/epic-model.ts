import { parseEpicBody } from "./epic-parse";
import { deriveChildState, type Epic, type EpicChild, type EpicRun } from "./epic-core";
import { epicIntegrationBranch } from "./epic-branch";
import type { SubIssueRef } from "./forge/types";

const ACTIVE_LABEL = "shepherd:active"; // mirror src/drain-core.ts

export interface AssembleSession {
  id: string;
  issueNumber: number | null;
  prNumber: number | null;
}
/** Per-member resolved facts, sourced natively (sub-issues) or from capped listIssues (markdown). */
interface Resolved {
  title: string;
  url: string;
  body: string;
  closed: boolean;
  claimed: boolean;
}
export interface AssembleInput {
  repoPath: string;
  run: EpicRun;
  parent: { number: number; title: string; body: string };
  subIssues: SubIssueRef[]; // native: carries closed/labels/body per child
  blockedBy: Map<number, number[]>;
  openIssues: { number: number; body: string; labels: string[] }[]; // markdown fallback only (200-capped)
  openIssuesTruncated: boolean; // listIssues() hit the 200 cap
  sessions: AssembleSession[];
  /** Child #s whose PR was squash-merged into the epic integration branch (persisted
   *  by the drain). Satisfies dependencies even though the issue is still open. */
  integrated: Set<number>;
  /** #645 divergence detection inputs (all pure — the drain reads forge/store and passes
   *  them in; assembleEpic does NO I/O). */
  /** The pinned canonical integration-branch name (`epic_run.integrationBranch`). Drives
   *  signals (a)/(b)/(c): a freshly-derived name, a child's recorded merge base, or a stray
   *  host branch is "divergent" iff it differs from this. */
  persistedBranch: string;
  /** Per integrated-child recorded merge base (`epic_integrated.mergedBase`). A child whose
   *  base is non-null and `!== persistedBranch` merged into the WRONG epic branch → warn (b).
   *  Null/absent entries (legacy rows) never fire. */
  integratedBases?: Map<number, string>;
  /** Stray `epic/*` host branches that reference the parent number but are NOT the pinned
   *  branch (computed + throttled in drain.buildEpic). Each surfaces a warning (c). */
  divergentBranches?: string[];
}

interface ResolvedGraph {
  order: number[];
  resolved: Map<number, Resolved>;
  edges: Map<number, number[]>;
  warnings: string[];
}

function resolveNative(input: AssembleInput): ResolvedGraph {
  const order = input.subIssues.map((s) => s.number);
  const resolved = new Map<number, Resolved>();
  for (const s of input.subIssues) {
    resolved.set(s.number, {
      title: s.title,
      url: s.url,
      body: s.body,
      closed: s.closed,
      claimed: s.labels.includes(ACTIVE_LABEL),
    });
  }
  const edges = new Map<number, number[]>(input.blockedBy);
  return { order, resolved, edges, warnings: [] };
}

function resolveMarkdown(input: AssembleInput): ResolvedGraph {
  const parsed = parseEpicBody(input.parent.body);
  const openByNum = new Map(input.openIssues.map((i) => [i.number, i]));
  const resolved = new Map<number, Resolved>();
  for (const n of parsed.members) {
    const o = openByNum.get(n);
    // markdown: a member absent from the (capped) open list is treated closed
    resolved.set(n, {
      title: `#${n}`,
      url: "",
      body: o?.body ?? "",
      closed: !o,
      claimed: !!o?.labels.includes(ACTIVE_LABEL),
    });
  }
  const edges = new Map<number, number[]>();
  for (const e of parsed.edges)
    edges.set(e.dependent, [...(edges.get(e.dependent) ?? []), e.blocker]);
  const warnings = input.openIssuesTruncated
    ? [
        "markdown epic: open-issue list truncated at 200 — closed-state of children beyond the cap may be wrong (premature-spawn risk); add native sub-issue links to make gating safe",
      ]
    : [];
  return { order: parsed.order, resolved, edges, warnings };
}

export function assembleEpic(input: AssembleInput): Epic {
  const native = input.subIssues.length > 0;
  const graph = native ? resolveNative(input) : resolveMarkdown(input);
  const { order, resolved, edges } = graph;
  const warnings = [...graph.warnings];

  const members = new Set(order);
  const done = new Set(
    order.filter((n) => resolved.get(n)?.closed === true || input.integrated.has(n)),
  );
  const sessByIssue = new Map<number, AssembleSession>();
  for (const s of input.sessions) if (s.issueNumber != null) sessByIssue.set(s.issueNumber, s);

  const children: EpicChild[] = order.map((number, idx) => {
    const blockedBy = (edges.get(number) ?? []).filter((b) => {
      if (b === number) {
        warnings.push(`#${number} blocked_by itself — ignored`);
        return false;
      }
      if (!members.has(b)) {
        warnings.push(`#${number} blocked_by #${b} is outside the epic — ignored`);
        return false;
      }
      return true;
    });
    const r = resolved.get(number)!;
    const sess = sessByIssue.get(number) ?? null;
    const child: EpicChild = {
      number,
      title: r.title,
      url: r.url,
      order: idx,
      body: r.body,
      blockedBy,
      state: "blocked",
      sessionId: sess?.id ?? null,
      prNumber: sess?.prNumber ?? null,
      issueClosed: r.closed,
      integrationMerged: input.integrated.has(number),
      claimed: r.claimed,
    };
    child.state = deriveChildState(child, done);
    return child;
  });

  // ── #645 epic-branch divergence warnings ──────────────────────────────────
  // (a) title drift: the live title now derives a different canonical name than the pinned one.
  const canonical = epicIntegrationBranch(input.parent.number, input.parent.title);
  if (canonical !== input.persistedBranch) {
    warnings.push(
      `epic branch pinned to \`${input.persistedBranch}\`; current title derives \`${canonical}\` (title edited — children stay on the pinned branch)`,
    );
  }
  // (b) integrated-child drift: a child squash-merged into a branch other than the pinned one.
  if (input.integratedBases) {
    for (const [n, base] of input.integratedBases) {
      if (base && base !== input.persistedBranch) {
        warnings.push(
          `child #${n} merged into \`${base}\`, not the pinned \`${input.persistedBranch}\``,
        );
      }
    }
  }
  // (c) host-branch drift: a stray epic/* ref references this epic but isn't the pinned branch.
  for (const b of input.divergentBranches ?? []) {
    warnings.push(
      `divergent epic branch \`${b}\` references epic #${input.parent.number} but is not the pinned \`${input.persistedBranch}\``,
    );
  }

  return {
    repoPath: input.repoPath,
    parentIssueNumber: input.parent.number,
    parentTitle: input.parent.title,
    source: native ? "native" : "markdown",
    children,
    warnings,
    run: input.run,
  };
}
