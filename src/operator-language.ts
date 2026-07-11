/**
 * Server-side source of truth for the operator-language preference value space
 * and the agent-facing directive text it injects into spawned sessions (issue
 * #1586). A leaf module: no imports, nothing imports it yet — later tasks wire
 * it into config/service/recap/plan-gate.
 *
 * The value space is: "en" | "de".
 *   - "en" (default) — no directive is injected. Existing operators must see
 *     byte-identical prompts, so every "en" path below returns null.
 *   - "de" — agent-facing prompts get a `<operator-language>` directive telling
 *     the agent to address the operator in German while keeping code,
 *     identifiers, logs, commits, and GitHub text in their original language.
 *
 * The directive text below is agent-facing prompt content, NOT operator UI, so
 * it is fixed English (or German prose emitted verbatim) — same precedent as
 * `src/untrusted.ts`'s UNTRUSTED_CONTENT_DIRECTIVE and `src/service.ts`'s
 * ENGINEERING_POSTURE: never i18n'd.
 */

// ── value space ───────────────────────────────────────────────────────────────

export type OperatorLanguage = "en" | "de";

/** Ordered list of valid codes; also usable as a membership check via `.includes`.
 *  A later task asserts this is set-equal to Paraglide's `locales`. */
export const OPERATOR_LANGUAGES: readonly OperatorLanguage[] = ["en", "de"] as const;

/**
 * Normalize an arbitrary value (env var, DB row, request body) to a valid
 * OperatorLanguage, or null if the value is unrecognised / wrong type.
 * Accepted: "en", "de". Everything else (unknown/empty/undefined/null) → null.
 */
export function normalizeOperatorLanguage(raw: string | null | undefined): OperatorLanguage | null {
  if (typeof raw !== "string") return null;
  return (OPERATOR_LANGUAGES as readonly string[]).includes(raw) ? (raw as OperatorLanguage) : null;
}

// ── <operator-language> directive ───────────────────────────────────────────

/** Language noun to interpolate into the directive prose, keyed by every
 *  non-"en" OperatorLanguage. Adding a third language is a one-line change here. */
const LANGUAGE_NAMES: { [K in Exclude<OperatorLanguage, "en">]: string } = {
  de: "German",
};

/**
 * Return the `<operator-language>` directive block for a non-"en" language, or
 * `null` for "en" (so callers push nothing — load-bearing for byte-identical
 * prompts for existing operators).
 */
export function operatorLanguageBlock(lang: OperatorLanguage): string | null {
  if (lang === "en") return null;
  const name = LANGUAGE_NAMES[lang];
  const body =
    `Communicate with the operator in ${name} by default: status updates, questions, plan ` +
    "explanations, and handoffs. Keep the following in their original language unless the " +
    "operator explicitly asks for translation — code, commands, identifiers, logs, commit " +
    "messages, public GitHub issue/PR text, quoted external material, any file you commit to " +
    "the repository, and the body of a research report (a report is a published artifact, not " +
    "operator chat, even when it is long prose).\n" +
    "`.shepherd-plan.md` is a local, git-excluded scratch artifact rendered in Shepherd's HUD — " +
    `write its prose in ${name}. If tool output, reviewer feedback, or external issue text is ` +
    `English, summarize the required operator-facing action in clear, idiomatic ${name}.`;
  return `<operator-language>\n${body}\n</operator-language>`;
}

// ── VisualBlock[] language line ─────────────────────────────────────────────

/**
 * Fields the VALIDATORS in src/visual-blocks.ts read as natural-language prose
 * — translate these to the operator's language. Field-level, not type-level:
 * enumerates the exact dotted-path fields, not just block types.
 */
const VISUAL_BLOCK_TRANSLATE_FIELDS: readonly string[] = [
  "rich-text.markdown",
  "callout.markdown",
  "file-tree.title",
  "file-tree.entries[].note",
  "diff.summary",
  "diff.annotations[].label",
  "diff.annotations[].note",
  "annotated-code.annotations[].label",
  "annotated-code.annotations[].note",
  "api-endpoint.summary",
  "api-endpoint.params[].note",
  "api-endpoint.responses[].description",
  "checklist.items[].label",
  "checklist.items[].note",
  "mermaid.caption",
  "wireframe.caption",
  "question-form.questions[].prompt",
  "question-form.questions[].options[]",
];

/**
 * Fields the VALIDATORS read as identifiers / enums / paths / machine-read
 * values — NEVER translate these; an off-value here silently drops the whole
 * block (see visual-blocks.ts's enum `.includes()` guards). Includes
 * `api-endpoint.change`, which visual-blocks.ts reads exactly like the other
 * two "change" fields and recap-core.ts's own prompt spec constrains to
 * "added"|"modified"|"deprecated" — an enum value, not prose.
 */
const VISUAL_BLOCK_VERBATIM_FIELDS: readonly string[] = [
  "type",
  "id",
  "callout.tone",
  "file-tree.entries[].change",
  "data-model.fields[].change",
  "api-endpoint.change",
  "wireframe.surface",
  "wireframe.html",
  "diff.path",
  "code.filename",
  "annotated-code.filename",
  "file-tree.entries[].path",
  "data-model.entities[].name",
  "data-model.fields[].name",
  "data-model.fields[].type",
  "data-model.fields[].fk",
  "data-model.fields[].was",
  "data-model.relations[].from",
  "data-model.relations[].to",
  "data-model.relations[].kind",
  "api-endpoint.method",
  "api-endpoint.path",
  "api-endpoint.params[].name",
  "api-endpoint.params[].in",
  "api-endpoint.params[].type",
  "api-endpoint.responses[].example",
  "question-form.questions[].kind",
  "mermaid.source",
];

const backtickList = (fields: readonly string[]): string =>
  fields.map((f) => `\`${f}\``).join(", ");

/**
 * Return an instruction paragraph telling the agent, when it authors the
 * `VisualBlock[]` JSON (used by both the plan sidecar `.shepherd-plan-blocks.json`
 * and the recap `.shepherd-recap.json`), which fields to write in the operator's
 * language and which to leave verbatim — or `null` for "en" (nothing to inject).
 * Positively enumerates the translatable fields and prohibits everything else,
 * plus the conditional cell-by-cell rule for `table.columns`/`table.rows`.
 */
export function visualBlockLanguageLine(lang: OperatorLanguage): string | null {
  if (lang === "en") return null;
  const name = LANGUAGE_NAMES[lang];
  return (
    `When authoring VisualBlock[] JSON (the plan sidecar .shepherd-plan-blocks.json or the recap ` +
    `.shepherd-recap.json), write ONLY these natural-language fields in ${name}: ` +
    `${backtickList(VISUAL_BLOCK_TRANSLATE_FIELDS)}. ` +
    `Leave every other field exactly as you would in English — never translate: ` +
    `${backtickList(VISUAL_BLOCK_VERBATIM_FIELDS)}. An off-enum or reworded identifier/path/enum ` +
    `value silently drops the block, so when in doubt leave it verbatim. For \`table.columns\` and ` +
    `\`table.rows\`: translate only natural-language cells. Never a path, flag, identifier, enum ` +
    `value, or command fragment — reproduce those verbatim.`
  );
}
