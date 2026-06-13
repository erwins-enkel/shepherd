/**
 * Pure helpers for the Session Recap feature — no I/O, no DB, no spawn.
 * Mirrors the structure of critic-core.ts (parse/validate/clamp + prompt building).
 */
import type { ActivityEntry } from "./activity";
import type { Recap, RecapVerdict } from "./types";

export const RECAP_VERDICTS: readonly RecapVerdict[] = ["ready", "parked", "needs_attention"];
export const RECAP_HEADLINE_MAX = 100;
export const RECAP_DIGEST_MAX_CHARS = 4000;

/** Parse + validate the raw .shepherd-recap.json the spawn wrote. Returns null when the
 *  shape is invalid (caller fails closed). Clamps headline to RECAP_HEADLINE_MAX, coerces
 *  openItems to a string[] (drops non-strings), requires verdict ∈ RECAP_VERDICTS. */
export function parseRecapVerdict(
  raw: unknown,
): { verdict: RecapVerdict; headline: string; body: string; openItems: string[] } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const verdict = r.verdict;
  if (!RECAP_VERDICTS.includes(verdict as RecapVerdict)) return null;

  const headline = typeof r.headline === "string" ? r.headline.slice(0, RECAP_HEADLINE_MAX) : "";
  const body = typeof r.body === "string" ? r.body : "";
  const rawItems = r.openItems;
  const openItems = Array.isArray(rawItems)
    ? rawItems.filter((x): x is string => typeof x === "string")
    : [];

  return { verdict: verdict as RecapVerdict, headline, body, openItems };
}

/** Build a bounded digest of what the agent did from parsed transcript entries
 *  (tool-use summaries, oldest→newest), capped to ~maxChars (default RECAP_DIGEST_MAX_CHARS).
 *  If the very first entry exceeds the cap, a truncated version of it is included so a single
 *  large entry always contributes something rather than returning "". */
export function buildTranscriptDigest(
  entries: ActivityEntry[],
  maxChars = RECAP_DIGEST_MAX_CHARS,
): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  let total = 0;
  for (const e of entries) {
    const line = `[${e.tool}] ${e.summary}`;
    if (total + line.length + 1 > maxChars) {
      if (lines.length === 0) lines.push(line.slice(0, maxChars));
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

/** The instruction prompt for the recap spawn. Tells the agent to summarize a COMPLETED
 *  coding session for an operator deciding whether to merge, and to Write a
 *  `.shepherd-recap.json` file with {verdict, headline, body, openItems}. */
export function buildRecapPrompt(input: {
  taskPrompt: string;
  plan: string; // "" when no .shepherd-plan.md
  changedFiles: string[];
  digest: string;
  context: string; // pre-rendered critic verdict / CI / readyToMerge lines (may be "")
}): string {
  const lines = [
    "You are summarizing a COMPLETED coding session for an operator who will decide whether to merge the work.",
    "Do NOT modify, build, commit, or run anything — read-only inspection only.",
    "",
    "The task that was worked on:",
    input.taskPrompt,
    "",
  ];

  if (input.plan.trim()) {
    lines.push("Plan that was executed:", input.plan, "");
  }

  if (input.changedFiles.length > 0) {
    lines.push("Files changed in this session:", ...input.changedFiles.map((f) => `  ${f}`), "");
  }

  if (input.digest.trim()) {
    lines.push("What the agent did (tool-use digest, oldest→newest):", input.digest, "");
  }

  if (input.context.trim()) {
    lines.push("Additional context (CI / critic verdict / merge readiness):", input.context, "");
  }

  lines.push(
    "Based on the above, write a concise recap for the operator:",
    '- verdict: one of "ready" | "parked" | "needs_attention"',
    '  - "ready": the session looks complete, merged-able, no blocking issues',
    '  - "parked": work done but not yet complete (e.g. mid-task, awaiting feedback)',
    '  - "needs_attention": blocking issues, failing tests, or something the operator must act on',
    `- headline: ≤${RECAP_HEADLINE_MAX} chars — one-line summary of what was accomplished`,
    "- body: concise markdown covering what changed, key decisions made, and merge-readiness",
    "- openItems: string[] of anything left to do or worth noting for the next session ([] if none)",
    "",
    `Write the result as JSON to the file \`.shepherd-recap.json\` in your CWD with EXACTLY this shape:`,
    `{"verdict": "ready" | "parked" | "needs_attention", "headline": "<string>", "body": "<markdown>", "openItems": ["<string>", ...]}`,
    "Write the file as your final action, then stop.",
  );

  return lines.join("\n");
}

/** Settled-idle test: agent status is finished AND has been idle long enough. */
export function isSettledIdle(status: string, idleMs: number, thresholdMs: number): boolean {
  return (status === "idle" || status === "done") && idleMs >= thresholdMs;
}

/** Head-keyed dedupe: regenerate only when there's no recap yet, or the existing recap
 *  summarized a different HEAD. Any existing row at the same head — generating/ready/failed/
 *  empty — means do NOT auto-fire; fail-closed: no auto-retry of a failed recap. */
export function needsRecap(existing: Recap | null, currentHeadSha: string): boolean {
  return !existing || existing.headSha !== currentHeadSha;
}
