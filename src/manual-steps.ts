/**
 * Manual-operator-step carrier parsing (#1059, epic #1056 P1).
 *
 * Manual operator steps = work a human must do around merge/deploy that the diff itself can't
 * perform (flip a feature flag, set an env var, run a one-off backfill, restart a worker, DNS
 * cutover, seed a record). Today they live only in PR prose and are silently lost when auto-merge
 * or an inattentive operator lands the PR and archives the session. This module is the PURE
 * detection half: given a PR body, it returns the structured steps so the band can surface them
 * on the backlog row + carry them into the Done recap. NO I/O — the forge supplies the body.
 *
 * Two carriers, both read from the single already-fetched PR body (no extra I/O, no new forge
 * method):
 *  1. PRIMARY — a fenced ```shepherd:manual-steps block: each `- [ ]` / `- [x]` line is a step.
 *  2. ADDITIVE — `Manual-Step:` trailer-form lines anchored at column 0 (outside the fence), so a
 *     `Manual-Step:` substring quoted inside prose or a blockquote can't match.
 * A leading `POST-MERGE:` (case-insensitive) on either form marks the step post-merge.
 *
 * Commit-message git trailers (which would need a new forge.prCommits() + squash-survival
 * analysis) are intentionally out of scope here — a follow-up.
 */

/** Stable parsed shape persisted on the session + carried into the recap checklist. */
export interface ManualStep {
  /** Deterministic id by final output order (`ms1`, `ms2`, …) — pure, test-stable. */
  id: string;
  /** Display text, with checkbox + `POST-MERGE:` prefix stripped. */
  text: string;
  /** True when the step must happen after the PR merges (leading `POST-MERGE:`). */
  postMerge: boolean;
}

/** The fence that opens/closes the primary carrier block. */
const FENCE_OPEN = /^```shepherd:manual-steps[ \t]*$/i;
const FENCE_CLOSE = /^```[ \t]*$/;
/** A markdown task-list line inside the fence: `- [ ] text` / `- [x] text` / `* [X] text`. */
const TASK_LINE = /^[ \t]*[-*][ \t]+\[[ xX]\][ \t]*(.*)$/;
/** A `Manual-Step:` trailer line, anchored at column 0 (no leading whitespace / blockquote). */
const TRAILER_LINE = /^Manual-Step:[ \t]*(.+)$/i;
/** A leading `POST-MERGE:` marker on a step's text (case-insensitive). */
const POST_MERGE_PREFIX = /^POST-MERGE:[ \t]*/i;

/** A raw step before dedupe: its text (POST-MERGE stripped) and post-merge flag. */
interface RawStep {
  text: string;
  postMerge: boolean;
}

/** Split a step's raw text into its post-merge flag + cleaned text. */
function splitPostMerge(raw: string): RawStep {
  const postMerge = POST_MERGE_PREFIX.test(raw);
  const text = raw.replace(POST_MERGE_PREFIX, "").trim();
  return { text, postMerge };
}

/** Normalize for dedupe: collapse whitespace + lowercase. Run BOTH new and stored text through
 *  this same normalizer before keying the Set (house rule: dedupe in normalized space). */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Pull every `- [ ]` / `- [x]` line out of all ```shepherd:manual-steps fences. Order-preserving;
 * tolerant of an unclosed final fence (reads to end of body). Non-list lines inside the fence are
 * ignored. Returns the raw lines AND the body with those fences removed (so trailer parsing can't
 * re-match lines that lived inside a fence).
 */
function extractBlockSteps(body: string): { steps: RawStep[]; bodyWithoutFences: string } {
  const lines = body.split(/\r?\n/);
  const steps: RawStep[] = [];
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (!inFence) {
      if (FENCE_OPEN.test(line)) {
        inFence = true;
        continue; // drop the opening fence from the trailer-scan body
      }
      kept.push(line);
      continue;
    }
    // inside a fence
    if (FENCE_CLOSE.test(line)) {
      inFence = false;
      continue; // drop the closing fence too
    }
    const m = TASK_LINE.exec(line);
    if (m) steps.push(splitPostMerge(m[1]!.trim()));
    // non-list lines inside the fence are dropped (not kept for trailer scan)
  }
  return { steps, bodyWithoutFences: kept.join("\n") };
}

/** Pull `Manual-Step:` trailer lines from the fence-stripped body (column-0 anchored). */
function extractTrailerSteps(bodyWithoutFences: string): RawStep[] {
  const steps: RawStep[] = [];
  for (const line of bodyWithoutFences.split(/\r?\n/)) {
    const m = TRAILER_LINE.exec(line);
    if (m) steps.push(splitPostMerge(m[1]!.trim()));
  }
  return steps;
}

/**
 * Parse manual operator steps from a PR body. Block steps first (primary), then trailer steps
 * (additive). Merge + dedupe in normalized space: first occurrence wins for display text;
 * `postMerge` is true if ANY source marks it. Pure; no I/O. Empty / malformed body → [].
 */
export function parseManualSteps(prBody: string): ManualStep[] {
  if (!prBody) return [];
  const { steps: blockSteps, bodyWithoutFences } = extractBlockSteps(prBody);
  const trailerSteps = extractTrailerSteps(bodyWithoutFences);

  const byKey = new Map<string, RawStep>();
  for (const s of [...blockSteps, ...trailerSteps]) {
    if (!s.text) continue; // skip empty steps (e.g. `- [ ]` with no text)
    const key = normalize(s.text);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      // keep first text, OR the post-merge flag across duplicates
      if (s.postMerge) existing.postMerge = true;
    } else {
      byKey.set(key, { text: s.text, postMerge: s.postMerge });
    }
  }

  return [...byKey.values()].map((s, i) => ({
    id: `ms${i + 1}`,
    text: s.text,
    postMerge: s.postMerge,
  }));
}
