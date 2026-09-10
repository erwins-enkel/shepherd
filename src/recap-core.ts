/**
 * Pure helpers for the Session Recap feature — no I/O, no DB, no spawn.
 * Mirrors the structure of critic-core.ts (parse/validate/clamp + prompt building).
 */
import type { ActivityEntry } from "./activity";
import type { DiffFile, DiffFileStatus, DiffHunk, Recap, RecapVerdict } from "./types";
import { parseVisualBlocks } from "./visual-blocks";
import type { VisualBlock } from "./visual-blocks";
import { UNTRUSTED_CONTENT_DIRECTIVE, fenceUntrusted } from "./untrusted";
import { amendmentBlock, type TaskAmendment } from "./task-amendments";
import { visualBlockLanguageLine, type OperatorLanguage } from "./operator-language";

export const RECAP_VERDICTS: readonly RecapVerdict[] = ["ready", "parked", "needs_attention"];
export const RECAP_HEADLINE_MAX = 100;
export const RECAP_DIGEST_MAX_CHARS = 4000;

/** The recap `body`, written beside the verdict JSON as plain markdown.
 *
 *  #2045 (the recap half of #2042): the recap agent hand-authors its verdict JSON, so every `"` in
 *  the body has to be escaped by the model. It only has to miss once. The unrecoverable shape is a
 *  bare `"` immediately before `:` or `,` (`…nicht mehr": drei Dinge`), which is byte-identical to a
 *  real key/value boundary — jsonrepair cannot resolve that ambiguity, and no repairer could. German
 *  prose produces it constantly via `„…":` / `„…",`, and it has already destroyed a complete recap
 *  in production.
 *
 *  Carrying the body as its own file removes the escaping obligation entirely: markdown has no
 *  reserved characters, so no prose can break the read. What remains in the JSON (verdict, headline,
 *  openItems) is short and structured, where the model's escaping is reliable in practice.
 *
 *  Unlike the critic's equivalent, this needs NO pre-seed scrub: the recap spawn's cwd is a fresh
 *  mkdtemp directory (see defaultMakeTmpDir in recap.ts), never an untrusted PR-head checkout. */
export const RECAP_BODY_FILE = ".shepherd-recap.md";

/** The recap `blocks`, written beside the verdict JSON as a bare `VisualBlock[]` — mirroring the
 *  plan gate's `.shepherd-plan-blocks.json` sidecar.
 *
 *  Blocks are still JSON, so moving them out cannot remove the escaping hazard the way the markdown
 *  body does. What it removes is the BLAST RADIUS: `rich-text.markdown`, `callout.markdown`,
 *  `diff.annotations[].note` and quote-dense `wireframe.html` are exactly as prose-heavy as the body
 *  was, and inline they could sink the entire recap. In their own file a mangled write costs only
 *  the visual cards — the verdict, headline and body still land (see readRecapBlocks in recap.ts,
 *  which falls back rather than failing). */
export const RECAP_BLOCKS_FILE = ".shepherd-recap-blocks.json";

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

/** Splice the sidecar payloads (#2045) onto a freshly-parsed recap verdict.
 *
 *  `body` / `blocks` are `null` for "no sidecar contribution" — the inline field then survives
 *  untouched, which is what keeps a Codex recap (answers in chat, writes no files) and any run
 *  already in flight across a server restart working unchanged. A present sidecar WINS: it is the
 *  format the prompt asks for whenever files are writable, and the one that cannot have been
 *  mangled by escaping.
 *
 *  Goes through unwrapRecapObject so it also lands on the jsonrepair array shape
 *  (`["Here is the recap:", {…}]`); that unwrap is idempotent with parseRecapVerdict downstream.
 *  Returns `raw` untouched when there is nothing to splice or the shape is unrecoverable.
 *
 *  `blocks` is `unknown` rather than `VisualBlock[]` on purpose: shape validation belongs to
 *  parseVisualBlocks downstream, which already tolerates anything. */
export function spliceRecapSidecars(raw: unknown, body: string | null, blocks: unknown): unknown {
  if (body === null && blocks === null) return raw;
  const obj = unwrapRecapObject(raw);
  if (!obj) return raw;
  if (body !== null) obj.body = body;
  if (blocks !== null) obj.blocks = blocks;
  return obj;
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

// ── UI markup (#2209) ─────────────────────────────────────────────────────────
//
// The recap agent runs the `writer-only` preset — Write only, a disposable temp cwd, no
// `--add-dir` — so it can read NOTHING. `buildRecapPrompt` carried changed paths and statuses but
// no markup, which is why `wireframe` fired 0 times across 30 regenerations over three prompt
// variants (#2194 → #2208): a mockup of the resulting screen would have to be invented, and the
// prompt's own grounding rule ("Never invent a path, a field, or a change") correctly stops that.
// The model was behaving well; the input was missing.
//
// So the input is supplied, from the diff the service ALREADY holds in memory — no tool grant, no
// extra I/O, no widening of what the spawn can reach.

/** At most this many view files carry markup into the prompt. A wireframe is one screen, not a tour
 *  of the diff; past a handful the section is competing with `plan` for the argv budget (#1944). */
export const RECAP_UI_MARKUP_MAX_FILES = 3;

/** Per-file ceiling, so one large component cannot crowd out the other selected files. */
const RECAP_UI_MARKUP_MAX_FILE_CHARS = 2500;

/** Section ceiling, to within one truncation marker per file (the marker rides on top of a clipped
 *  slice). Soft either way: `fitRecapPrompt` clamps this block FIRST if the argv budget still bites. */
const RECAP_UI_MARKUP_MAX_CHARS = 6000;

/** Below this a file's slice is all marker and no markup — stop instead of emitting a stub. */
const MIN_UI_MARKUP_FILE_CHARS = 200;

/** Extensions that carry rendered markup. Deliberately EXTENSION-based, never path-based: Shepherd
 *  drives arbitrary repos, so a `ui/**` rule would be a Shepherd-only heuristic. */
const VIEW_FILE_RE = /\.(?:svelte|vue|astro|tsx|jsx|html|htm)$/i;

/** `Foo.test.tsx`, `Foo.spec.jsx`, `Foo.browser.test.ts` — a test renders no screen the operator sees. */
const TEST_FILE_RE = /\.(?:test|spec)\.[^./]+$/i;

/** True for a changed file whose post-change side is worth showing as UI markup. */
export function isViewFile(path: string): boolean {
  return VIEW_FILE_RE.test(path) && !TEST_FILE_RE.test(path);
}

/** Neutral, factual truncation marker — states a count, commands nothing (it lands inside an
 *  untrusted fence, where an instruction would be contractually ignorable; see untrusted.ts). */
function elidedChars(n: number): string {
  return `[… ${n} chars elided …]`;
}

function clipMarkup(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n${elidedChars(text.length - maxChars)}`;
}

/** Render the POST-CHANGE side of a file's hunks: `-` lines dropped, `+` kept on added lines, a
 *  leading space kept on context lines. Hunk headers are dropped — they are line numbers, which the
 *  prompt already forbids the agent from repeating back. Hunks are separated by a bare `…`. */
function afterSide(hunks: DiffHunk[]): string {
  const parts: string[] = [];
  for (const h of hunks) {
    const lines = h.lines
      .filter((l) => l.kind !== "del")
      .map((l) => `${l.kind === "add" ? "+" : " "}${l.content}`);
    if (lines.length > 0) parts.push(lines.join("\n"));
  }
  return parts.join("\n…\n");
}

/** Build the bounded UI-markup digest handed to the recap agent, or "" when the session changed no
 *  view file. Pure — the caller passes the diff it already computed.
 *
 *  Selection drops what cannot ground a mockup: deleted files (no resulting screen), binary files,
 *  and files whose hunks `diff.ts` dropped past its per-file line cap (`truncated`) — silence beats
 *  a lie, which is the whole lesson of #2209. Ranking is by additions descending (stable on the
 *  diff's own order): the largest markup change is the most mock-able. */
export function buildUiMarkupDigest(
  files: DiffFile[],
  limits: { maxFiles?: number; maxFileChars?: number; maxChars?: number } = {},
): string {
  const maxFiles = limits.maxFiles ?? RECAP_UI_MARKUP_MAX_FILES;
  const maxFileChars = limits.maxFileChars ?? RECAP_UI_MARKUP_MAX_FILE_CHARS;
  const maxChars = limits.maxChars ?? RECAP_UI_MARKUP_MAX_CHARS;

  const selected = files
    .map((file, order) => ({ file, order, after: afterSide(file.hunks) }))
    // The post-change side is rendered BEFORE selection, because emptiness is part of the
    // selection rule and it costs a file its slot: a component emptied but KEPT (status still
    // `modified`, hunks non-empty, every line a deletion) has no resulting screen. Emitting its
    // header alone would put the section — and the instruction to ground a wireframe on it — over
    // a fence holding no markup, which is the invent-a-screen pressure this change exists to remove.
    .filter(
      ({ file, after }) =>
        isViewFile(file.path) &&
        file.status !== "deleted" &&
        !file.binary &&
        !file.truncated &&
        after.trim() !== "",
    )
    .sort((a, b) => b.file.additions - a.file.additions || a.order - b.order)
    .slice(0, maxFiles);

  const blocks: string[] = [];
  let total = 0;
  for (const { file, after } of selected) {
    const header = `${file.path} (${file.status})`;
    // Whatever is left of the section budget, never more than one file's share. Below the marker's
    // own length there is no room for content worth reading, so stop rather than emit a stub.
    const room = Math.min(maxFileChars, maxChars - total - header.length - 2);
    if (room < MIN_UI_MARKUP_FILE_CHARS) break;
    const block = `${header}\n${clipMarkup(after, room)}`;
    blocks.push(block);
    total += block.length + 2;
  }
  return blocks.join("\n\n");
}

/** The instruction prompt for the recap spawn. Tells the agent to summarize a COMPLETED
 *  coding session for an operator deciding whether to merge, and to Write the prose to
 *  `.shepherd-recap.md`, any visual blocks to `.shepherd-recap-blocks.json`, and
 *  `.shepherd-recap.json` LAST with {verdict, headline, openItems}. */
export function buildRecapPrompt(input: {
  taskPrompt: string;
  plan: string; // "" when no .shepherd-plan.md
  changedFiles: { path: string; status: DiffFileStatus }[];
  digest: string;
  context: string; // pre-rendered critic verdict / CI / readyToMerge lines (may be "")
  uiMarkup?: string; // buildUiMarkupDigest output; "" / absent when no view file changed (#2209)
  operatorLanguage?: OperatorLanguage;
  /** #2225: the operator's standing task amendments. Absent/empty ⇒ byte-identical prompt. The
   *  recap summarizes work against what was ACTUALLY asked, which includes any amendment. */
  amendments?: readonly TaskAmendment[];
}): string {
  const lines = [
    "You are summarizing a COMPLETED coding session for an operator who will decide whether to merge the work.",
    "Do NOT modify, build, commit, or run anything — read-only inspection only.",
    "",
    // #2002: the one home for the fence contract in this prompt — fences carry label + nonce only.
    UNTRUSTED_CONTENT_DIRECTIVE,
    "",
    "The task that was worked on:",
    fenceUntrusted("task", input.taskPrompt),
    "",
    // Outside the fence, directly under the task — operator-authored, and it is part of what the
    // operator is deciding whether to merge against.
    ...amendmentBlock(input.amendments ?? []),
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

  // #2209: the ONLY sight of the UI this agent gets. It rides here — with the changed-file list it
  // annotates, and outside the static block-guidance region, which has ~37 bytes of headroom under
  // the ceiling its test pins. The interpreting instruction sits AFTER the fence: an instruction
  // inside one is contractually ignorable and forgeable (see untrusted.ts), so it would be inert
  // exactly where it matters.
  if (input.uiMarkup?.trim()) {
    lines.push(
      "UI markup after this change (post-change side of the diff for the view files that changed —",
      "`+` marks a line this session added, a leading space marks surrounding context, `…` separates",
      "non-adjacent regions of the same file):",
      fenceUntrusted("ui-markup", input.uiMarkup),
      "This markup is your grounding for a `wireframe` block: mock up the screen it renders. Do not",
      "put UI in a wireframe that you cannot see here.",
      "",
    );
  }

  if (input.digest.trim()) {
    lines.push("What the agent did (tool-use digest, oldest→newest):", input.digest, "");
  }

  if (input.context.trim()) {
    lines.push(
      "Additional context (CI / critic verdict / merge readiness):",
      fenceUntrusted("context", input.context),
      "",
    );
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
    "Optionally, add `blocks` to render the recap as a scannable visual document instead",
    // #2194: this line used to end "Omit `blocks` entirely if plain `body` suffices — blocks are not
    // required", which the model weighed over every later rule: regenerations kept coming back with
    // ZERO blocks on 9-to-74-file sessions. The escape hatch stays for the genuinely empty session
    // (and a Codex recap, which answers in chat and writes no sidecar at all, still degrades to
    // body-only mechanically) — it just no longer reads as a standing invitation.
    "of plain markdown. For a session that changed code, blocks are how the operator reads it —",
    "omit them only when there is genuinely nothing to show.",
    "",
    // #2194: the schemas below are the parse contract; these five rules are the BRAKES on the
    // per-type triggers appended to each. Triggers without brakes produce kitchen-sink recaps —
    // a worse failure than the under-use they fix. Never ship one half of this pair.
    "Choosing a view — each schema below ends with when to reach for that type. If no trigger",
    "fires, do not emit that type. Five rules govern all of them:",
    "- Pick the smallest view that ANSWERS THE READER'S QUESTION. Smallest means most economical to",
    "  READ, not cheapest to write: never skip the view a point needs because authoring it is more",
    "  work. A sentence beats a block only when the sentence actually answers the question.",
    "- `body` and `blocks` are ONE document, read top to bottom — not two artifacts. Write the short",
    "  text that sets each visual up; never restate in `body` a point a block already makes.",
    "- A good recap is typically 4-7 blocks. Past ~10 you are cataloguing the session instead of",
    "  explaining it; at 0-1 you wrote prose and called it a recap.",
    "- Reach for a type when its trigger fires — not because it exists, nor because you reached for",
    "  it last time. `callout`/`diff`/`file-tree` are not the default three.",
    // #2194: wireframe and mermaid had fired 0 times across 88 block-emitting recaps. Both are
    // expensive to author, so every "keep it small" rule argues against them unless their trigger
    // is stated as non-optional HERE — in the preamble that gets read — rather than only at the end
    // of their own (long, restriction-heavy) schema lines.
    "- If the session changed what a user sees on screen, `wireframe` is NOT optional: no diff can",
    "  show the operator the resulting screen. If it changed control or data flow BETWEEN components,",
    "  `mermaid` is not optional either. These two are under-used, not over-used — when their trigger",
    "  fires, emit them.",
    "",
    "Block types (Phase 1):",
    '- rich-text: {"type":"rich-text","id":"<unique>","markdown":"<prose>"} — narrative / the why. Reach for it when the point is WHY, not what. Also the home for a shape sketch: when the change is structural and no single file carries it, put a fenced ```diff of the SHAPE here (component tree, file layout, call tree, control-flow pseudocode — before/after), not a file diff.',
    '- callout:   {"type":"callout","id":"...","tone":"info|decision|risk|warning|success","markdown":"..."} — a toned note for a decision, risk, or assumption. Reach for it when a reader who skims everything else must still see this one thing. Three callouts in a row is a list, not a callout.',
    '- file-tree: {"type":"file-tree","id":"...","title?":"...","entries":[{"path":"<real path>","change":"added|modified|removed|renamed","note?":"<short>"}]} — the change footprint. Use real changed paths only. Reach for it when the footprint itself is the story: a change spread wide, or one that moves/renames. Skip it when ≤3 files changed — the diff blocks already show them.',
    '- diff:      {"type":"diff","id":"...","path":"<real changed path>","summary":"<one line>","annotations?":[{"label?":"<short>","note":"<prose>"}]} — feature a specific changed file. Reach for it when one specific changed file carries a load-bearing decision. Curated: 1-3 per recap, never every file you touched.',
    "",
    "Block types (Phase 2):",
    '- code:           {"type":"code","id":"...","filename":"<path marked (added)>"} — highlights a new file (language is derived from the path). Only emit for files marked (added) above; modified files use diff blocks. Never type the code body — the server attaches it. Reach for it when a new file is short and self-explaining, and reading it beats describing it.',
    '- annotated-code: {"type":"annotated-code","id":"...","filename":"<path marked (added)>","annotations?":[{"label?":"<short>","note":"<prose describing this part of the code>"}]} — code with prose notes. Only (added) files. Never type the code body, never line numbers. Reach for it when such a file instead needs a guided read: a non-obvious ordering, a subtle guard, a rule that is not local.',
    '- data-model:     {"type":"data-model","id":"...","entities":[{"id":"...","name":"...","fields":[{"name":"...","type":"...","pk?":true,"fk?":"<ref>","nullable?":true,"change?":"added|modified|removed|renamed","was?":"<old type>"}]}],"relations?":[{"from":"...","to":"...","kind":"..."}]} — ERD-ish card. Extract from real changed schema; do not invent fields; redact secrets. Will be tagged inferred automatically. Reach for it when the schema changed and the shape of the data is what a reviewer must check.',
    '- api-endpoint:   {"type":"api-endpoint","id":"...","method":"GET|POST|...","path":"<route>","summary?":"...","change?":"added|modified|deprecated","deprecated?":true,"params?":[{"name":"...","in":"path|query|body","type":"...","required?":true,"note?":"..."}],"responses?":[{"status":200,"description?":"...","example?":"..."}]} — one route card. Extract from real changed routes; redact secrets. Will be tagged inferred automatically. Reach for it when a route was added, changed or deprecated and the contract is what a caller must know.',
    '- table:          {"type":"table","id":"...","columns":["A","B"],"rows":[["a","b"]]} — columnar comparison or summary. Redact secrets. Reach for it when the point is a comparison across fixed axes (before/after, option A vs B, per-environment behaviour). Not for prose in a grid.',
    '- checklist:      {"type":"checklist","id":"...","items":[{"id":"...","label":"...","note?":"...","checked?":true}]} — task list or review checklist. Reach for it when the operator has something to DO or verify. If it only restates openItems, drop it.',
    "",
    "Block types (Phase 3):",
    '- mermaid:        {"type":"mermaid","id":"...","source":"<mermaid diagram source>","caption?":"..."} — an architecture or flow diagram (flowchart/sequence/etc). Use for genuine architecture/flow shifts only. Will be tagged inferred automatically. Reach for it when control or data flow CHANGED, and the change is BETWEEN components rather than inside one — a sequence diagram of the new path beats three paragraphs. Never diagram architecture that did not change.',
    '- wireframe:      {"type":"wireframe","id":"...","surface":"browser|desktop|mobile|popover|panel","html":"<themed HTML mockup>","caption?":"..."} — a UI mockup of a screen. Use ONLY for UI changes. Author with the wf helper classes + class-based color; NEVER inline hex/rgb()/hsl()/color()/font-family/box-shadow, and never <script>/<style>/event handlers/href. Reach for it when the change is visible on screen: the operator cannot see the UI from a diff, and a mockup of the resulting screen is the only block that answers what they will actually see. Use it for any user-visible layout, state or copy change. The helper classes are: wf-card, wf-box, wf-pill, wf-chip, wf-muted — plus plain <button> (class="primary" or data-primary for the accent one) and data-icon for a glyph. Compose them with div/span/ul/li/table/h1-h6/header/nav/section/strong/small/img/svg.',
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
    "When done, write these files in your CWD:",
    // Binds the term once: every rule above says `body` / `blocks`, and they all now resolve to
    // these files. Cheaper and less drift-prone than restating each rule.
    `1. \`${RECAP_BODY_FILE}\` — the \`body\`. Everywhere these instructions say "body", they mean THIS file. It is NOT JSON: write the markdown directly, escape nothing, quote however you like.`,
    `2. \`${RECAP_BLOCKS_FILE}\` — OPTIONAL. The \`blocks\` described above as a bare JSON array (\`[ {…}, {…} ]\`, no wrapper object). Omit the file entirely when plain markdown suffices.`,
    `3. \`.shepherd-recap.json\` — the structured verdict. It must be strict, valid JSON with no comments, with EXACTLY this shape:`,
    `{"verdict": "ready" | "parked" | "needs_attention", "headline": "<string>", "openItems": ["<string>", ...]}`,
    // #2045: `body` and `blocks` used to live inside this JSON. A single unescaped `"` before a `:`
    // or `,` — which German `„…":` prose produces constantly — is indistinguishable from a real
    // key/value boundary, so it silently destroyed complete recaps. Keeping the prose out of the
    // JSON entirely is the only fix that cannot regress.
    //
    // They stay DOCUMENTED OPTIONAL fields, not removed ones: a Codex recap answers in chat and
    // writes no files at all (its verdict is recovered from the `-o` last-message capture — see
    // readRoleResultText and defaultReadVerdict in recap.ts). For that provider no sidecar can
    // exist, so dropping them from the shape would produce a recap with no text in it.
    `OMIT "body" and "blocks" from that JSON when you wrote the files above — the files always win. Include them inline ONLY if you cannot write files at all (you are answering in chat): then put the markdown in "body", the array in "blocks", and escape every \`"\` inside them as \`\\"\`.`,
    `Escaping matters ONLY in \`.shepherd-recap.json\`, and — when you wrote the markdown file — it is short: inside "headline" and each "openItems" entry every \`"\` must be written \`\\"\`. If that feels error-prone, phrase them without quotation marks; the markdown file is where quoting is free.`,
    // Ordering is load-bearing: the server finalizes as soon as the JSON parses, so the JSON must be
    // written LAST — otherwise a tick landing between the writes finalizes with an empty body.
    `Write \`${RECAP_BODY_FILE}\` (and \`${RECAP_BLOCKS_FILE}\`, if any) FIRST and \`.shepherd-recap.json\` LAST — the JSON file is the completion signal — then stop.`,
  );

  if (input.operatorLanguage === "de") {
    lines.push(
      "",
      "Write the recap prose fields `headline`, `body`, and `openItems[]` in German. Keep " +
        '`verdict` as the literal enum value ("ready" | "parked" | "needs_attention") — the ' +
        "operator UI switches on it, never translate it.",
    );
    const blockLine = visualBlockLanguageLine("de");
    if (blockLine) lines.push(blockLine);
  }

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
