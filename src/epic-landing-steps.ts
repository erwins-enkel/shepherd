/**
 * Epic landing PR ⟷ children's manual operator steps (#3103). Child PRs merge into the epic
 * integration branch, not `main`, and are often merged by the train/drain — so their
 * `shepherd:manual-steps` never reach the Owed lens and were lost when the epic landed.
 *
 *  - {@link collectLandingManualSteps}: at landing-body build, re-read every child PR body and
 *    aggregate its steps (deduped, with origin PRs). A step is done if its child PR fence ticks it,
 *    the child's own Owed record ticks it, or the current landing PR body ticks it.
 *  - {@link materializeLandingManualSteps}: on landing merge, freeze the landing PR's steps into ONE
 *    `post_merge_steps` record for the epic and dismiss the child records it covers.
 *
 * Both never throw; failures log and degrade (a child's stored session steps, the persisted
 * aggregate) rather than dropping steps.
 */
import { createHash } from "node:crypto";
import type { CompletedEpicChild } from "./completed-epic";
import {
  buildLandingPrTitle,
  mergeLandingManualSteps,
  parseLandingManualSteps,
  type LandingManualStep,
} from "./epic-landing";
import type { GitForge } from "./forge/types";
import { normalizeStepText, parseManualStepChecklist } from "./manual-steps";
import type { SessionStore } from "./store";

/** What {@link collectLandingManualSteps} reads. */
export type CollectStepsStore = Pick<
  SessionStore,
  "listPostMergeStepsForPr" | "latestSessionManualStepsForIssue"
>;

type LandingStepsStore = CollectStepsStore &
  Pick<
    SessionStore,
    | "getEpicLandingManualSteps"
    | "getPostMergeSteps"
    | "materializePostMergeSteps"
    | "dismissPostMergeSteps"
    | "getEpicCompletedLanding"
  >;

type Child = Pick<CompletedEpicChild, "number" | "prNumber">;

/** Owed-record id for an epic's landing (a session-less record): URL-safe, stable per repo+epic. */
export function landingStepsRecordId(repoPath: string, parentIssueNumber: number): string {
  const hash = createHash("sha1").update(repoPath).digest("hex").slice(0, 8);
  return `epic-landing-${parentIssueNumber}-${hash}`;
}

/** Normalized texts of the steps ticked done in this PR's own Owed record(s). */
function owedDoneKeys(store: CollectStepsStore, repoPath: string, prNumber: number): Set<string> {
  const done = store
    .listPostMergeStepsForPr(repoPath, prNumber)
    .flatMap((r) => r.steps.filter((s) => s.doneAt != null));
  return new Set(done.map((s) => normalizeStepText(s.text)));
}

/** Mark every step whose normalized text is in `keys` done. */
function markDone(steps: LandingManualStep[], keys: Set<string>): LandingManualStep[] {
  return steps.map((s) => (keys.has(normalizeStepText(s.text)) ? { ...s, done: true } : s));
}

/** One child's steps: its PR body's fence (authoritative), else its stored session steps. */
async function childSteps(
  forge: Pick<GitForge, "prReviewMeta">,
  store: CollectStepsStore,
  repoPath: string,
  child: Child & { prNumber: number },
): Promise<LandingManualStep[]> {
  let parsed: { text: string; postMerge: boolean; done: boolean }[] | null = null;
  try {
    const meta = await forge.prReviewMeta?.(child.prNumber);
    if (meta) parsed = parseManualStepChecklist(meta.body);
  } catch (err) {
    console.warn(`[epic-landing-steps] ${repoPath} child pr#${child.prNumber} fetch failed:`, err);
  }
  if (!parsed) {
    parsed = store
      .latestSessionManualStepsForIssue(repoPath, child.number)
      .map((s) => ({ ...s, done: false }));
  }
  const steps = parsed.map((s) => ({
    text: s.text,
    postMerge: s.postMerge,
    done: s.done,
    fromPrs: [child.prNumber],
  }));
  return markDone(steps, owedDoneKeys(store, repoPath, child.prNumber));
}

/** Aggregate every child's manual steps for the landing PR body. `priorLandingBody` (the landing
 *  PR's current body, when refreshing) keeps steps the operator ticked there ticked. */
export async function collectLandingManualSteps(input: {
  forge: Pick<GitForge, "prReviewMeta">;
  store: CollectStepsStore;
  repoPath: string;
  children: Child[];
  priorLandingBody?: string | null;
}): Promise<LandingManualStep[]> {
  const { forge, store, repoPath } = input;
  const lists: LandingManualStep[][] = [];
  for (const c of input.children) {
    if (c.prNumber == null) continue;
    lists.push(await childSteps(forge, store, repoPath, { ...c, prNumber: c.prNumber }));
  }
  const prior = parseLandingManualSteps(input.priorLandingBody ?? "").filter((s) => s.done);
  return markDone(
    mergeLandingManualSteps(lists),
    new Set(prior.map((s) => normalizeStepText(s.text))),
  );
}

/** The landed PR's steps: its body's fence merged with the persisted aggregate (either may be
 *  missing — a failed fetch, or a landing opened before #3103). `requireMerged` (the caller has
 *  not seen the merge itself) → null unless the forge confirms the landing PR merged. */
async function landedSteps(
  forge: Pick<GitForge, "prReviewMeta">,
  store: LandingStepsStore,
  repoPath: string,
  parentIssueNumber: number,
  landingPrNumber: number,
  requireMerged: boolean,
): Promise<LandingManualStep[] | null> {
  let fromBody: LandingManualStep[] = [];
  let merged = false;
  try {
    const meta = await forge.prReviewMeta?.(landingPrNumber);
    fromBody = parseLandingManualSteps(meta?.body ?? "");
    merged = meta?.state === "merged";
  } catch (err) {
    console.warn(
      `[epic-landing-steps] ${repoPath} landing pr#${landingPrNumber} fetch failed:`,
      err,
    );
  }
  if (requireMerged && !merged) return null;
  return mergeLandingManualSteps([
    fromBody,
    store.getEpicLandingManualSteps(repoPath, parentIssueNumber),
  ]);
}

/** Step text with its origin PRs, so the Owed card says which child declared it. */
function withOrigin(s: LandingManualStep): string {
  return s.fromPrs.length ? `${s.text} (from ${s.fromPrs.map((n) => `#${n}`).join(", ")})` : s.text;
}

/** Dismiss each child's Owed record whose every step the epic aggregate carries. */
function dismissCoveredChildRecords(
  store: LandingStepsStore,
  repoPath: string,
  children: Child[],
  steps: LandingManualStep[],
): boolean {
  const carried = new Set(steps.map((s) => normalizeStepText(s.text)));
  let changed = false;
  for (const c of children) {
    if (c.prNumber == null) continue;
    for (const rec of store.listPostMergeStepsForPr(repoPath, c.prNumber)) {
      if (rec.clearedAt != null) continue;
      if (!rec.steps.every((s) => carried.has(normalizeStepText(s.text)))) continue;
      store.dismissPostMergeSteps(rec.sessionId);
      changed = true;
    }
  }
  return changed;
}

/** On landing merge: write the epic's Owed record (done steps pre-ticked; skipped when none are
 *  owed) and dismiss covered child records. Idempotent — a replay finds the record and no-ops.
 *  Never throws. */
export async function materializeLandingManualSteps(input: {
  forge: Pick<GitForge, "prReviewMeta">;
  store: LandingStepsStore;
  repoPath: string;
  parentIssueNumber: number;
  landingPrNumber: number;
  landingPrTitle: string;
  children: Child[];
  emitChange: () => void;
  /** Set when the caller hasn't observed the merge (parent-close dismissal): verify it first. */
  requireMerged?: boolean;
}): Promise<void> {
  const { forge, store, repoPath, parentIssueNumber, landingPrNumber, children } = input;
  const sessionId = landingStepsRecordId(repoPath, parentIssueNumber);
  try {
    if (store.getPostMergeSteps(sessionId)) return;
    const collected = await landedSteps(
      forge,
      store,
      repoPath,
      parentIssueNumber,
      landingPrNumber,
      input.requireMerged ?? false,
    );
    if (!collected?.length) return;
    const doneKeys = new Set<string>();
    for (const c of children)
      if (c.prNumber != null)
        for (const k of owedDoneKeys(store, repoPath, c.prNumber)) doneKeys.add(k);
    const steps = markDone(collected, doneKeys);
    let changed = false;
    if (steps.some((s) => !s.done)) {
      const now = Date.now();
      changed = store.materializePostMergeSteps({
        sessionId,
        desig: `EPIC-${parentIssueNumber}`,
        repoPath,
        prNumber: landingPrNumber,
        prTitle: input.landingPrTitle,
        steps: steps.map((s, i) => ({
          id: `ms${i + 1}`,
          text: withOrigin(s),
          postMerge: s.postMerge,
          doneAt: s.done ? now : null,
        })),
      });
      if (changed)
        console.info(
          `[epic-landing-steps] materialized ${steps.length} step(s) for ${repoPath} epic #${parentIssueNumber} (pr#${landingPrNumber})`,
        );
    }
    if (dismissCoveredChildRecords(store, repoPath, children, steps)) changed = true;
    if (changed) input.emitChange();
  } catch (err) {
    console.warn(
      `[epic-landing-steps] materialize for ${repoPath} epic #${parentIssueNumber} failed:`,
      err,
    );
  }
}

/** A completed-epic row was cleared — notably the parent-close dismissal after a landing PR merged
 *  straight on GitHub, which never flips the row to `merged` (auto-merge off, or a
 *  migration-bearing epic). If the forge confirms its landing PR merged, materialize as on a
 *  merged emit. A row that is gone (restart) or never got a landing PR is a no-op. Never throws. */
export async function materializeLandingOnClear(input: {
  forge: Pick<GitForge, "prReviewMeta">;
  store: LandingStepsStore;
  repoPath: string;
  parentIssueNumber: number;
  emitChange: () => void;
}): Promise<void> {
  const { store, repoPath, parentIssueNumber } = input;
  let children: Child[];
  let row: ReturnType<LandingStepsStore["getEpicCompletedLanding"]>;
  try {
    row = store.getEpicCompletedLanding(repoPath, parentIssueNumber);
    if (row?.landingPrNumber == null) return;
    children = JSON.parse(row.childrenJson) as Child[];
  } catch (err) {
    console.warn(`[epic-landing-steps] clear for ${repoPath} epic #${parentIssueNumber}:`, err);
    return;
  }
  await materializeLandingManualSteps({
    ...input,
    landingPrNumber: row.landingPrNumber,
    landingPrTitle: buildLandingPrTitle(parentIssueNumber, row.parentTitle),
    children,
    requireMerged: true,
  });
}
