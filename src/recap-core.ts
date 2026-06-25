/**
 * Pure helpers for the Session Recap feature — no I/O, no DB, no spawn.
 * Mirrors the structure of critic-core.ts (parse/validate/clamp + prompt building).
 */
import type { ActivityEntry } from "./activity";
import type { DiffFileStatus, Recap, RecapVerdict } from "./types";
import { parseVisualBlocks } from "./visual-blocks";
import type { VisualBlock } from "./visual-blocks";

export const RECAP_VERDICTS: readonly RecapVerdict[] = ["ready", "parked", "needs_attention"];
export const RECAP_HEADLINE_MAX = 100;
export const RECAP_DIGEST_MAX_CHARS = 4000;

/** Recover the recap object from a parse that an unattended agent's chatty output mangled.
 *  jsonrepair turns prose-wrapped JSON ("Here is the recap:\n{…}" or "{…}\nDone.") into an
 *  ARRAY (e.g. `["Here is the recap:", {…}]`); pull the first recap-shaped element back out so a
 *  preamble/epilogue doesn't sink an otherwise-complete verdict. A bare object passes through. */
function unwrapRecapObject(raw: unknown): Record<string, unknown> | null {
  if (Array.isArray(raw)) {
    const found = raw.find(
      (e) => !!e && typeof e === "object" && !Array.isArray(e) && "verdict" in (e as object),
    );
    return (found as Record<string, unknown>) ?? null;
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return null;
}

/** Normalize a verdict to the enum, tolerating formatting variance (case, surrounding
 *  whitespace, hyphen/space separators) — e.g. "Needs-Attention" / " READY " → enum value.
 *  Returns null for anything that is not one of RECAP_VERDICTS after normalization (no synonym
 *  guessing: "complete"/"approve" stay rejected — we never invent the agent's intent). */
function normalizeVerdict(v: unknown): RecapVerdict | null {
  if (typeof v !== "string") return null;
  const n = v
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (RECAP_VERDICTS as readonly string[]).includes(n) ? (n as RecapVerdict) : null;
}

/** Parse + validate the raw .shepherd-recap.json the spawn wrote. Returns null when the
 *  shape is invalid (caller fails closed). Clamps headline to RECAP_HEADLINE_MAX, coerces
 *  openItems to a string[] (drops non-strings), requires verdict ∈ RECAP_VERDICTS (normalized).
 *  Unwraps a prose-wrapped array (see unwrapRecapObject) so a chatty agent doesn't fail the recap.
 *  blocks is additive — parsed tolerantly via parseVisualBlocks ([] on missing/garbage). */
export function parseRecapVerdict(raw: unknown): {
  verdict: RecapVerdict;
  headline: string;
  body: string;
  openItems: string[];
  blocks: VisualBlock[];
} | null {
  const r = unwrapRecapObject(raw);
  if (!r) return null;

  const verdict = normalizeVerdict(r.verdict);
  if (!verdict) return null;

  const headline = typeof r.headline === "string" ? r.headline.slice(0, RECAP_HEADLINE_MAX) : "";
  const body = typeof r.body === "string" ? r.body : "";
  const rawItems = r.openItems;
  const openItems = Array.isArray(rawItems)
    ? rawItems.filter((x): x is string => typeof x === "string")
    : [];
  const blocks = parseVisualBlocks(r.blocks);

  return { verdict, headline, body, openItems, blocks };
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
  changedFiles: { path: string; status: DiffFileStatus }[];
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
    lines.push(
      "Files changed in this session:",
      ...input.changedFiles.map((f) => `  ${f.path} (${f.status})`),
      "",
    );
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
    "Optionally, include a `blocks` array to render the recap as a scannable visual document instead",
    "of plain markdown. Omit `blocks` entirely if plain `body` suffices — blocks are not required.",
    "",
    "Block types (Phase 1):",
    '- rich-text: {"type":"rich-text","id":"<unique>","markdown":"<prose>"} — narrative / the why.',
    '- callout:   {"type":"callout","id":"...","tone":"info|decision|risk|warning|success","markdown":"..."} — a toned note for a decision, risk, or assumption.',
    '- file-tree: {"type":"file-tree","id":"...","title?":"...","entries":[{"path":"<real path>","change":"added|modified|removed|renamed","note?":"<short>"}]} — the change footprint. Use real changed paths only.',
    '- diff:      {"type":"diff","id":"...","path":"<real changed path>","summary":"<one line>","annotations?":[{"label?":"<short>","note":"<prose>"}]} — feature a specific changed file.',
    "",
    "Block types (Phase 2):",
    '- code:           {"type":"code","id":"...","filename":"<path marked (added)>"} — highlights a new file (language is derived from the path). Only emit for files marked (added) above; modified files use diff blocks. Never type the code body — the server attaches it.',
    '- annotated-code: {"type":"annotated-code","id":"...","filename":"<path marked (added)>","annotations?":[{"label?":"<short>","note":"<prose describing this part of the code>"}]} — code with prose notes. Only (added) files. Never type the code body, never line numbers.',
    '- data-model:     {"type":"data-model","id":"...","entities":[{"id":"...","name":"...","fields":[{"name":"...","type":"...","pk?":true,"fk?":"<ref>","nullable?":true,"change?":"added|modified|removed|renamed","was?":"<old type>"}]}],"relations?":[{"from":"...","to":"...","kind":"..."}]} — ERD-ish card. Extract from real changed schema; do not invent fields; redact secrets. Will be tagged inferred automatically.',
    '- api-endpoint:   {"type":"api-endpoint","id":"...","method":"GET|POST|...","path":"<route>","summary?":"...","change?":"added|modified|deprecated","deprecated?":true,"params?":[{"name":"...","in":"path|query|body","type":"...","required?":true,"note?":"..."}],"responses?":[{"status":200,"description?":"...","example?":"..."}]} — one route card. Extract from real changed routes; redact secrets. Will be tagged inferred automatically.',
    '- table:          {"type":"table","id":"...","columns":["A","B"],"rows":[["a","b"]]} — columnar comparison or summary. Redact secrets.',
    '- checklist:      {"type":"checklist","id":"...","items":[{"id":"...","label":"...","note?":"...","checked?":true}]} — task list or review checklist.',
    "",
    "Block types (Phase 3):",
    '- mermaid:        {"type":"mermaid","id":"...","source":"<mermaid diagram source>","caption?":"..."} — an architecture or flow diagram (flowchart/sequence/etc). Use for genuine architecture/flow shifts only. Will be tagged inferred automatically.',
    '- wireframe:      {"type":"wireframe","id":"...","surface":"browser|desktop|mobile|popover|panel","html":"<themed HTML mockup>","caption?":"..."} — a UI mockup of a screen. Use ONLY for UI changes. Author with the wf helper classes + class-based color; NEVER inline hex/rgb()/hsl()/color()/font-family/box-shadow, and never <script>/<style>/event handlers/href.',
    "",
    "Rules for blocks:",
    "- Every block must have a unique string `id`.",
    '- Grounding: only reference files that ACTUALLY changed — use paths from the "Files changed in',
    '  this session" list above verbatim. Never invent a path, a field, or a change.',
    "- diff blocks: emit only `path`, `summary`, and prose `annotations`. Do NOT include diff hunks",
    "  or a `file` field — the server attaches the real diff content. Annotations are short prose",
    "  notes about the change, NOT line numbers or line ranges.",
    "- Feature a few load-bearing files as `diff` blocks (curated highlight, not every file); the",
    "  full footprint belongs in a `file-tree` block.",
    "- Redact secrets (API keys, tokens, passwords) in any summary/markdown/annotation — use",
    "  placeholders like `sk-•••` / `<redacted>`.",
    "",
    `Write the result as JSON to the file \`.shepherd-recap.json\` in your CWD with EXACTLY this shape`,
    "(the `blocks` field is optional — omit it entirely if not useful; the file must be strict, valid",
    "JSON with no comments):",
    `{"verdict": "ready" | "parked" | "needs_attention", "headline": "<string>", "body": "<markdown>", "openItems": ["<string>", ...], "blocks": [ ... ]}`,
    "Write the file as your final action, then stop.",
  );

  return lines.join("\n");
}

/** Settled-idle test: agent status is finished AND has been idle long enough. */
export function isSettledIdle(status: string, idleMs: number, thresholdMs: number): boolean {
  return (status === "idle" || status === "done") && idleMs >= thresholdMs;
}

/** `(headSha, base)`-keyed dedupe: regenerate when there's no recap yet, the existing recap
 *  summarized a different HEAD, or — when the current base was authoritatively resolved — the
 *  existing recap diffed against a different base (e.g. it baked the stored baseBranch before
 *  the PR's real base became known). Otherwise an existing row at the same head — generating/
 *  ready/failed/empty — means do NOT auto-fire; fail-closed: no auto-retry of a failed recap.
 *
 *  Two guards on the base dimension:
 *   - `existing.base !== ""` — legacy rows (predating the base column) are never force-regenerated
 *     on base alone, so a deploy doesn't mass-regenerate every prior recap.
 *   - `resolved` — only an authoritatively-resolved base re-fires; a transient fallback to
 *     `baseBranch` (cold/evicted cache, on-demand gh failed) must NOT flip the key and bill a
 *     recap spawn each tick. */
export function needsRecap(
  existing: Recap | null,
  currentHeadSha: string,
  currentBase: string,
  resolved: boolean,
): boolean {
  return (
    !existing ||
    existing.headSha !== currentHeadSha ||
    (resolved && existing.base !== "" && existing.base !== currentBase)
  );
}
