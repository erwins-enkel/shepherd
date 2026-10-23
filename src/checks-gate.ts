/**
 * No-CI gate helpers. A GitHub repo that defines ZERO workflows has no CI to wait on, so its
 * head commit's `statusCheckRollup` is permanently empty and rolls up to `checks: "none"` — which
 * every `checks === "success"` gate would otherwise treat identically to "CI hasn't gone green
 * yet" and block forever (no auto-review, no auto-merge, never surfaced as awaiting-merge).
 *
 * `checks: "none"` is therefore ambiguous: a no-CI repo (terminal — review/merge now) vs. a CI
 * repo whose checks haven't registered yet (a transient pre-CI race — keep waiting). We resolve it
 * with the repo's count of workflows that run on a PR head (#3221: `pull_request`, `push`, … —
 * a `schedule`/`workflow_dispatch`-only file never reports a check, see workflow-triggers.ts): a
 * CI repo has at least one, a no-CI repo has none. Scoped to GitHub on purpose — the workflow glob is `.github/workflows`-only (Gitea uses
 * `.gitea/workflows`), and LocalForge already auto-greens its pseudo-PRs, so other forges keep the
 * strict green gate.
 */
import type { ChecksState, ForgeKind } from "./forge/types";
import { countPrCiWorkflows } from "./workflow-triggers";

/** True when `forgeKind` is GitHub AND no workflow runs on a PR head ⇒ no CI to wait on. */
export function repoHasNoCi(forgeKind: ForgeKind, prCiWorkflows: number): boolean {
  return forgeKind === "github" && prCiWorkflows === 0;
}

/** Whether a PR's CI is "cleared" for an autonomous action (review / merge / surface): green CI
 *  always clears; a no-CI repo's terminal `checks:"none"` clears too. A CI repo's transient
 *  `"none"` does NOT (its `noCi` is false because a workflow on disk runs on PRs), so it keeps waiting. */
export function checksCleared(checks: ChecksState, noCi: boolean): boolean {
  return checks === "success" || (noCi && checks === "none");
}

/** #3104: an autonomous merge into the default branch (epic auto-land) is held when the repo has
 *  no CI and the PR therefore carries no checks at all — `checksCleared` lets that PR through, but
 *  nothing verified it. The operator lifts the hold by adding CI or opting in (`mergeWithoutCi`). */
export function noCiMergeHeld(
  checks: ChecksState,
  noCi: boolean,
  mergeWithoutCi: boolean,
): boolean {
  return noCi && checks === "none" && !mergeWithoutCi;
}

const CACHE_TTL_MS = 60_000;
const countCache = new Map<string, { at: number; count: number }>();

/** {@link repoHasNoCi} for production call sites, with the `countPrCiWorkflows` read
 *  TTL-memoized per repo (workflow files change rarely). Keeps the hot paths — the standalone
 *  critic's per-PR sweep, the per-poll `annotateHandoff`, the epic-landing enrich — from doing a
 *  readdir per candidate. Tests use the pure {@link repoHasNoCi} with an explicit count. */
export function repoHasNoCiCached(
  forgeKind: ForgeKind,
  repoPath: string,
  now: () => number = Date.now,
): boolean {
  if (forgeKind !== "github") return false;
  const t = now();
  const hit = countCache.get(repoPath);
  if (hit && t - hit.at < CACHE_TTL_MS) return hit.count === 0;
  const count = countPrCiWorkflows(repoPath);
  countCache.set(repoPath, { at: t, count });
  return count === 0;
}
