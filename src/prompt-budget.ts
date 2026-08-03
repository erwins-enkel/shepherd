/**
 * Per-block accounting for the assembled spawn prompt (issue #1999).
 *
 * `composeSystemPrompt` joins ~20 named blocks into the single payload every spawn carries — Claude
 * via `--append-system-prompt`, Codex inline on the prompt. Nothing measured it. The only size guard
 * on that path is the OS argv budget (`src/argv-limit.ts`), which fires at ~128 KiB — three orders of
 * magnitude above where the context-engineering decisions live.
 *
 * Pure and I/O-free by design: the composer hands over its parts, this module prices them, and the
 * caller persists the result. That keeps the reconstruction invariant (blocks + separators === the
 * emitted payload) testable without a store, a service or a spawn.
 */

/** One named part of the assembled prompt. `name` is the XML tag the block is wrapped in, so a
 *  reader can map a measurement straight back to the text it priced. */
export interface PromptBlock {
  name: string;
  text: string;
}

/** What one block costs. Chars AND bytes, deliberately: the epic's baseline table is stated in
 *  characters, while the argv guard works in UTF-8 bytes — and these blocks are em-dash dense
 *  enough that the two diverge by ~0.7%. Recording one would strand a consumer. */
export interface PromptBlockMeasure {
  name: string;
  chars: number;
  bytes: number;
  /** ESTIMATE — see {@link estimateTokens}. */
  tokens: number;
}

/** Total plus per-block breakdown for one assembled payload. */
export interface PromptBudget {
  totalChars: number;
  totalBytes: number;
  /** ESTIMATE — the sum of the per-block estimates, not a tokenizer's verdict. */
  totalTokens: number;
  /** Chars (== bytes; the separator is ASCII) spent on the separators BETWEEN blocks. Recorded so
   *  the breakdown reconciles to the total without the reader having to know the separator. */
  separatorChars: number;
  blocks: PromptBlockMeasure[];
}

/** The one separator the composer joins blocks with. Exported and shared by {@link joinPromptBlocks}
 *  and {@link measurePromptBlocks} so the meter cannot drift from the emitted payload by
 *  construction — the reconstruction test then asserts it empirically anyway. */
export const PROMPT_BLOCK_SEPARATOR = "\n\n";

/** Characters per token, the divisor behind {@link estimateTokens}.
 *
 *  DELIBERATELY a constant and not a tokenizer. Adding a real tokenizer would pull a dependency (and
 *  a model-specific vocabulary) onto the spawn path to answer a question this instrument does not
 *  ask: the epic's decisions turn on the RELATIVE weight of blocks, and a shared divisor preserves
 *  every ratio exactly. Every surface that shows a token count labels it as an estimate; a later
 *  slice can swap the estimator here without touching a single call site. */
export const CHARS_PER_TOKEN = 4;

/** Rough token count for `text`. An ESTIMATE, never a measurement — see {@link CHARS_PER_TOKEN}. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Join blocks into the payload that actually ships. The inverse of {@link measurePromptBlocks}. */
export function joinPromptBlocks(blocks: PromptBlock[]): string {
  return blocks.map((b) => b.text).join(PROMPT_BLOCK_SEPARATOR);
}

/** Price an assembled prompt block by block. `totalChars`/`totalBytes` are the cost of the JOINED
 *  payload — per-block sizes plus the separators between them — so they equal
 *  `joinPromptBlocks(blocks).length` and its UTF-8 byte length exactly. */
export function measurePromptBlocks(blocks: PromptBlock[]): PromptBudget {
  const measured = blocks.map((b) => ({
    name: b.name,
    chars: b.text.length,
    bytes: Buffer.byteLength(b.text, "utf8"),
    tokens: estimateTokens(b.text),
  }));
  // n blocks are joined by n-1 separators; zero blocks spend nothing (Math.max guards the -1).
  const separatorChars = Math.max(0, measured.length - 1) * PROMPT_BLOCK_SEPARATOR.length;
  return {
    totalChars: measured.reduce((s, b) => s + b.chars, 0) + separatorChars,
    totalBytes: measured.reduce((s, b) => s + b.bytes, 0) + separatorChars,
    totalTokens: measured.reduce((s, b) => s + b.tokens, 0),
    separatorChars,
    blocks: measured,
  };
}
