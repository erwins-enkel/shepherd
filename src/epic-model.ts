import { parseEpicBody } from "./epic-parse";
import { deriveChildState, type Epic, type EpicChild, type EpicRun } from "./epic-core";
import { epicIntegrationBranch } from "./epic-branch";
import type { SubIssueRef } from "./forge/types";

const ACTIVE_LABEL = "shepherd:active"; // mirror src/drain-core.ts

/** The markdown 200-cap / premature-spawn warning assembleEpic emits (resolveMarkdown). Exported so
 *  the epic-diagnosis passthrough filter can de-dupe it against its structured `truncated-open-list`
 *  finding without string-duplication. */
export const MARKDOWN_TRUNCATION_WARNING =
  "markdown epic: open-issue list truncated at 200 — closed-state of children beyond the cap may be wrong (premature-spawn risk); add native sub-issue links to make gating safe";

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
  openIssues: { number: number; title: string; url: string; body: string; labels: string[] }[]; // markdown fallback only (200-capped)
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
  /** (Task 2) children parked at retire because their PR targets a base other than the pinned
   *  epic branch (`epic_base_mismatch`, read in drain.buildEpic). Each surfaces an actionable,
   *  remedy-naming warning — the epic is BLOCKED until the operator re-targets the PR. */
  baseMismatches?: { childNumber: number; actualBase: string; prNumber: number | null }[];
  /** #1757: false when the repo's forge cannot create branches (no `ensureBranch` — Gitea, local).
   *  Such an epic runs WITHOUT an integration branch: every child bases on the default branch and
   *  merges straight into it, one at a time (the epic still progresses — a merged child closes its
   *  issue, and done-ness is `integrationMerged || issueClosed` — but there is no atomic epic
   *  landing PR). That degrade used to be a server-side console.warn only; surface it so the
   *  operator can see the epic is not running the way the epic model implies. Undefined/true ⇒ no
   *  warning (GitHub, and every existing caller/test). */
  integrationBranchSupported?: boolean;
}

/** #1757 — see {@link AssembleInput.integrationBranchSupported}. Server-authored epic warning text,
 *  like the other strings in this file (not UI chrome; surfaced verbatim in the epic payload). */
export const NO_INTEGRATION_BRANCH_WARNING =
  "This forge cannot create branches, so this epic is running WITHOUT an integration branch: each child is based on the default branch and merges directly into it (no atomic epic landing PR).";

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
      title: o?.title ?? `#${n}`,
      url: o?.url ?? "",
      body: o?.body ?? "",
      closed: !o,
      claimed: !!o?.labels.includes(ACTIVE_LABEL),
    });
  }
  const edges = new Map<number, number[]>();
  for (const e of parsed.edges)
    edges.set(e.dependent, [...(edges.get(e.dependent) ?? []), e.blocker]);
  const warnings = input.openIssuesTruncated ? [MARKDOWN_TRUNCATION_WARNING] : [];
  return { order: parsed.order, resolved, edges, warnings };
}

export function assembleEpic(input: AssembleInput): Epic {
  const native = input.subIssues.length > 0;
  const graph = native ? resolveNative(input) : resolveMarkdown(input);
  // Defense-in-depth: children are keyed by number in EpicPanel's {#each}, so a duplicate in
  // `order` (from any source) would throw each_key_duplicate and crash the panel on mount. The
  // markdown parser already dedupes members; this guards the native path (repeated subIssue
  // number) and any future source. First-seen wins; `members`/`done` derive from `order` below.
  const { resolved, edges } = graph;
  const order = [...new Set(graph.order)];
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

  warnings.push(...divergenceWarnings(input));
  // #1757: forge can't create branches → this epic has no integration branch at all. Explicitly
  // `=== false` so every existing caller (which omits the flag) is unaffected.
  if (input.integrationBranchSupported === false) warnings.push(NO_INTEGRATION_BRANCH_WARNING);

  // Zero-edges legibility signal (#1447): ≥2 ready children and no surviving dependency
  // edges (post-filter, so self-loop / outside-epic edges — already warned above — don't
  // count as ordering) → every open child derives to `ready` and drains in parallel.
  const readyCount = children.filter((c) => c.state === "ready").length;
  const totalEdges = children.reduce((sum, c) => sum + c.blockedBy.length, 0);
  const noDependencyEdges = readyCount >= 2 && totalEdges === 0;

  return {
    repoPath: input.repoPath,
    parentIssueNumber: input.parent.number,
    parentTitle: input.parent.title,
    source: native ? "native" : "markdown",
    children,
    warnings,
    noDependencyEdges,
    run: input.run,
  };
}

/** #645 epic-branch divergence warnings (pure — the drain reads forge/store and passes the inputs
 *  in). (a) live title now derives a different canonical name than the pinned branch; (b) an
 *  integrated child squash-merged into a non-pinned base; (c) a stray host `epic/*` ref references
 *  this epic; (Task 2) a child parked at retire because its PR targets the wrong base — the warning
 *  names the exact remedy (`gh pr edit … --base <pinned>`) and the epic is blocked until fixed. */
function divergenceWarnings(input: AssembleInput): string[] {
  const out: string[] = [];
  const pinned = input.persistedBranch;
  // (a) title drift
  const canonical = epicIntegrationBranch(input.parent.number, input.parent.title);
  if (canonical !== pinned) {
    out.push(
      `epic branch pinned to \`${pinned}\`; current title derives \`${canonical}\` (title edited — children stay on the pinned branch)`,
    );
  }
  // (b) integrated-child drift
  for (const [n, base] of input.integratedBases ?? []) {
    if (base && base !== pinned) {
      out.push(`child #${n} merged into \`${base}\`, not the pinned \`${pinned}\``);
    }
  }
  // (c) host-branch drift
  for (const b of input.divergentBranches ?? []) {
    out.push(
      `divergent epic branch \`${b}\` references epic #${input.parent.number} but is not the pinned \`${pinned}\``,
    );
  }
  // (Task 2) base-mismatch
  for (const mm of input.baseMismatches ?? []) out.push(baseMismatchWarning(mm, pinned));
  return out;
}

/** (Task 2) One actionable base-mismatch warning: names the wrong base + the exact `gh pr edit`
 *  remedy (omitted when the PR number is unknown) and that the epic is blocked until re-targeted. */
function baseMismatchWarning(
  mm: { childNumber: number; actualBase: string; prNumber: number | null },
  pinned: string,
): string {
  const pr = mm.prNumber != null ? ` #${mm.prNumber}` : "";
  const edit =
    mm.prNumber != null ? ` — re-target it (gh pr edit ${mm.prNumber} --base ${pinned})` : "";
  const target = mm.actualBase ? `targets \`${mm.actualBase}\`` : "targets an unknown base";
  return `child #${mm.childNumber} PR${pr} ${target}, not the epic branch \`${pinned}\`${edit} — epic blocked until fixed`;
}
