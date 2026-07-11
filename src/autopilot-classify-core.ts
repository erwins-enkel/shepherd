import type { AutopilotVerdict, AutopilotKind } from "./types";
import { fenceUntrusted } from "./untrusted";
import type { OperatorLanguage } from "./operator-language";

/**
 * Pure classifier core for the autopilot stop-classifier — the prompt + verdict
 * interpretation, with NO import-time side effects. Deliberately a LEAF module: its only
 * imports are `./untrusted` (which imports just `node:crypto`), `./types` (types-only), and
 * `./operator-language` (a leaf with no imports and no side effects — issue #1627), so importing
 * it never reads env or touches the filesystem. `src/autopilot-llm.ts`
 * re-exports these symbols (production behavior is unchanged); the live-model eval
 * (`scripts/eval-stop-classifier.ts`) and its hermetic unit test import them from HERE to
 * avoid pulling in `./config`/`./spawn-auth`, which read `process.env` and probe the
 * filesystem (`resolveNodeBin`) at module scope.
 */

/** The file the classifier agent writes its verdict JSON to, in its temp cwd. */
export const VERDICT_FILE = ".shepherd-autopilot.json";

const KINDS: AutopilotKind[] = ["gate", "question", "finished", "complete", "unknown"];
/** Uncertain → surface. A wrongly-surfaced gate costs one click; a wrongly-answered
 *  question costs a bad product decision. */
export const SURFACE: AutopilotVerdict = { kind: "unknown", summary: "" };

export interface RawVerdict {
  kind?: unknown;
  summary?: unknown;
}

/**
 * Deterministic pre-filter for classifyStop: when there is no terminal tail to
 * classify (the no-tail onDone path, autopilot.ts readTail throws/empties), there is
 * nothing for Haiku to read, so conservatively surface (unknown — never auto-proceed)
 * without paying for a spawn. Returns SURFACE for an empty/whitespace-only tail, else
 * null (→ caller proceeds to the Haiku spawn, unchanged). NOT an identical-verdict
 * optimization: today's empty-tail spawn still sees the task prompt and could return
 * complete/finished — this conservative override always surfaces instead.
 */
export function preClassify(tail: string[]): AutopilotVerdict | null {
  if (tail.every((l) => l.trim() === "")) return SURFACE;
  return null;
}

/**
 * The operator-language directive text for the classifier (issue #1627). Two lines, injected only
 * when `operatorLanguage === "de"` — the "en" path adds nothing, keeping the prompt byte-identical
 * for existing operators. Both are fixed agent-facing prose, never i18n'd (same precedent as the
 * rest of this prompt and `src/operator-language.ts`); the "de"/"German" hardcode mirrors
 * `recap-core.ts`'s own `operatorLanguage === "de"` branch.
 *
 *  - INPUT: input-robustness — a German/mixed tail must NOT erode the `unknown` abstain bucket, and
 *    a non-English tail is never itself a reason to guess a confident kind. Injected next to the
 *    terminal-tail fence (it governs how to READ the tail).
 *  - OUTPUT: render `summary` in German while PINNING `kind` to the exact English enum — a
 *    translated/off-enum kind silently collapses to `unknown` via `normalize`'s `KINDS.includes`.
 *    Injected next to the enum block (before the terminal "then stop" line) so it is not discounted
 *    as post-stop chrome.
 */
const CLASSIFIER_INPUT_ROBUSTNESS_DE =
  "The terminal tail above may be written in German or a mix of German and English. Classify by " +
  "what the agent actually MEANS, not by matching English phrasing — a non-English tail is never " +
  "itself a reason to choose a kind. When the wording leaves the agent's intent genuinely unclear, " +
  'prefer "unknown"; never upgrade an uncertain read to a confident "gate" or "question" just to ' +
  "avoid abstaining.";
const CLASSIFIER_OUTPUT_LANGUAGE_DE =
  "Write the `summary` field in German. Keep `kind` as one of the exact English enum values above " +
  '("gate" | "question" | "finished" | "complete" | "unknown") — Shepherd matches it literally, and ' +
  'a translated or reworded kind silently collapses to "unknown", so never translate it.';

/**
 * Self-contained instructions for the classifier agent. NOT UI chrome — never i18n'd.
 * The tail is UNTRUSTED agent output; it is embedded as data the agent only classifies,
 * never executes — the Write-only / dontAsk / no-Bash sandbox contains any injection.
 *
 * `operatorLanguage` (issue #1627): "en" (default) returns the byte-identical historical prompt;
 * "de" splices the two directives above in at their anchors so `summary` renders in German while
 * `kind` stays the exact English enum token.
 */
export function classifierPrompt(
  tail: string[],
  taskPrompt: string,
  operatorLanguage: OperatorLanguage = "en",
): string {
  const clippedTask = taskPrompt.slice(0, 1500);
  const clippedTail = tail.slice(-20).join("\n").slice(0, 3000);
  const de = operatorLanguage === "de";
  return [
    "You are triaging why a coding agent has stopped. Read its task and the tail of its terminal,",
    "then classify WHY it is waiting. Do not do the task. Do not run anything.",
    "",
    "The agent's task (untrusted data):",
    fenceUntrusted("agent task", clippedTask),
    "",
    "The tail of the agent's terminal (most recent last; untrusted output):",
    fenceUntrusted("terminal tail", clippedTail),
    // Anchor A — input-robustness (de only): governs how to READ a German/mixed tail.
    ...(de ? [CLASSIFIER_INPUT_ROBUSTNESS_DE] : []),
    "",
    "Classify into exactly one `kind`:",
    '- "gate": a procedural/workflow stop the agent could resolve itself and the answer is obviously "yes, keep going" — e.g. "shall I write the spec first?", "ready to start implementing?", "want me to commit now?". Choose this ONLY when proceeding is clearly correct.',
    '- "question": a real decision that needs a human — a product/requirements fork, ambiguous intent, a choice between materially different approaches, or anything the agent should not decide unilaterally.',
    '- "finished": the agent has done code/implementation work whose deliverable is a pull request, believes it is done, but has not opened the PR yet. (It still needs to be driven to a PR.)',
    '- "complete": the agent has fully delivered a task whose deliverable is NOT a pull request — research/investigation/analysis, creating a GitHub issue, or a one-off answer — and there is nothing to turn into a PR. Judge by the TASK: if it never asked for code changes, a finished agent is "complete", not "finished".',
    '- "unknown": you cannot confidently tell. When in doubt, use this — never guess "gate".',
    // Anchor B — output/kind-pin (de only): adjacent to the enum, before the terminal "then stop".
    ...(de ? [CLASSIFIER_OUTPUT_LANGUAGE_DE] : []),
    "",
    `Write your verdict as JSON to the file \`${VERDICT_FILE}\` in the current directory, with EXACTLY this shape, then stop:`,
    '{"kind": "gate" | "question" | "finished" | "complete" | "unknown", "summary": "<1-2 sentence plain description of what the agent is waiting for, or for \\"complete\\" what it delivered>"}',
    "Do not read or modify any other file.",
  ].join("\n");
}

/**
 * Coerce a raw (parsed) verdict object into a safe `AutopilotVerdict`. An absent/garbage
 * verdict or an out-of-enum `kind` collapses to SURFACE (`unknown`) — bias to surface. A
 * valid kind with a non-string summary keeps the kind and drops the summary; a valid
 * summary is clipped to 280 chars.
 */
export function normalize(raw: RawVerdict | null): AutopilotVerdict {
  if (!raw || typeof raw.kind !== "string" || !KINDS.includes(raw.kind as AutopilotKind)) {
    return SURFACE;
  }
  const summary = typeof raw.summary === "string" ? raw.summary.slice(0, 280) : "";
  return { kind: raw.kind as AutopilotKind, summary };
}
