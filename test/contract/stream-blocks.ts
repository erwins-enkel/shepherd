import { readFileSync } from "node:fs";
import { join } from "node:path";
import { declaredEvents, declaredOperations } from "./harness";

/** The streams that own a marked block, in the order S0-prep placed them.
 *
 *  Milestone 2 placed the first four; S0-prep-2 appended the six milestone-3 streams. The order
 *  here is the order the markers sit in each section, and `stream-blocks.test.ts` asserts the two
 *  agree — a name added here without its three markers fails that test, and a marker placed for a
 *  name that is not here throws `unknown stream` out of `parseStreamBlocks`. Both directions are
 *  deliberate: a half-registered stream is worse than neither half. */
export const STREAM_NAMES = [
  "terminal",
  "detail",
  "sidebar",
  "actions",
  "herd",
  "plan",
  "merge",
  "queues",
  "compose",
  "settings",
] as const;
export type StreamName = (typeof STREAM_NAMES)[number];

export interface StreamBlocks {
  /** Path templates inside each stream's block in `paths:`. */
  paths: Map<string, string[]>;
  /** Component schema names inside each stream's block in `components.schemas:`. */
  schemas: Map<string, string[]>;
  /** Event names inside each stream's block in `x-shepherd-events:`. */
  events: Map<string, string[]>;
}

const CONTRACT_PATH = join(import.meta.dir, "..", "..", "contracts", "openapi.yaml");
// A single literal space at each gap, not `\s*`: the grammar is meant to be exact, so a marker
// with doubled internal whitespace is a mistake to catch, not a variant to tolerate.
const OPEN = /^# ── stream: ([a-z]+) ──$/;
const CLOSE = /^# ── \/stream: ([a-z]+) ──$/;
const STREAM_NAME_SET: ReadonlySet<string> = new Set(STREAM_NAMES);

/**
 * Loosely matches any `#`-comment that is *trying* to be a marker — the right
 * words in the right order, modulo case, dash count/character and internal
 * whitespace — so a near-miss (`# ── STREAM: terminal ──`, a single `─`, a
 * stray extra space) fails loudly instead of being read as an ordinary
 * comment and silently dropping the block it was meant to open or close.
 * Checked only once `OPEN`/`CLOSE` have already failed to match.
 */
function looksLikeMarker(trimmed: string): boolean {
  const collapsed = trimmed.replace(/\s+/g, "").toLowerCase();
  return /^#[─-]+\/?stream:[a-z]*[─-]+$/.test(collapsed);
}

/**
 * Parses the `# ── stream: <name> ──` blocks out of an OpenAPI document.
 *
 * Three sections carry blocks, one grammar for all of them: `components.schemas:`,
 * `paths:` and `x-shepherd-events:`. Raw text, not `Bun.YAML.parse`: the markers
 * are comments and a YAML parse drops them. Indentation is the section
 * discriminator — a top-level key sits at column 0, a path template and an event
 * name two spaces under `paths:` / `x-shepherd-events:`, a schema name four
 * spaces under `components:` → `schemas:`.
 */
export function parseStreamBlocks(yaml: string): StreamBlocks {
  const state = emptyState();
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) consumeLine(state, lines[i]!, i + 1);

  if (state.open) {
    throw new Error(`stream block ${state.open} still open at EOF`);
  }
  return state.blocks;
}

/** Which of the three marked sections the walk is inside, if any. */
type Section = "paths" | "schemas" | "events" | null;

/** The parser's whole world: where it is, and what it has collected so far. */
interface ParseState {
  section: Section;
  /** The stream whose block is open, or null between blocks. */
  open: string | null;
  blocks: StreamBlocks;
}

function emptyState(): ParseState {
  const blocks: StreamBlocks = { paths: new Map(), schemas: new Map(), events: new Map() };
  for (const name of STREAM_NAMES) {
    blocks.paths.set(name, []);
    blocks.schemas.set(name, []);
    blocks.events.set(name, []);
  }
  return { section: null, open: null, blocks };
}

function consumeLine(state: ParseState, line: string, lineNo: number): void {
  const trimmed = line.trim();
  if (trimmed === "") return;
  if (consumeComment(state, trimmed, lineNo)) return;
  if (/^\S/.test(line)) {
    enterTopLevel(state, line, trimmed, lineNo);
    return;
  }
  attachKey(state, line);
}

/**
 * Handles every `#`-comment, marker or not, and answers whether the line was
 * one. A near-miss marker throws here rather than passing as a comment.
 */
function consumeComment(state: ParseState, trimmed: string, lineNo: number): boolean {
  const opened = OPEN.exec(trimmed);
  if (opened) {
    openBlock(state, opened[1]!, lineNo);
    return true;
  }
  const closed = CLOSE.exec(trimmed);
  if (closed) {
    closeBlock(state, closed[1]!);
    return true;
  }
  if (!trimmed.startsWith("#")) return false;
  if (looksLikeMarker(trimmed)) {
    throw new Error(`line ${lineNo}: malformed stream marker: ${trimmed}`);
  }
  return true;
}

function openBlock(state: ParseState, name: string, lineNo: number): void {
  if (!STREAM_NAME_SET.has(name)) {
    throw new Error(`line ${lineNo}: unknown stream "${name}" — not in STREAM_NAMES`);
  }
  // Blocks never nest: an opener inside an open block would attribute one
  // stream's surface to another and leave the markers unbalanced.
  if (state.open) {
    throw new Error(`line ${lineNo}: stream ${name} opened while ${state.open} is still open`);
  }
  state.open = name;
}

function closeBlock(state: ParseState, name: string): void {
  if (name !== state.open) {
    throw new Error(`stream block ${state.open ?? "(none)"} closed by ${name}`);
  }
  state.open = null;
}

/** A column-0 key ends whatever section we were in, and may open another. */
function enterTopLevel(state: ParseState, line: string, trimmed: string, lineNo: number): void {
  if (state.open) {
    throw new Error(`line ${lineNo}: stream block ${state.open} still open at "${trimmed}"`);
  }
  if (line.startsWith("paths:")) state.section = "paths";
  else if (line.startsWith("x-shepherd-events:")) state.section = "events";
  else state.section = null;
}

function attachKey(state: ParseState, line: string): void {
  if (state.section === "events") {
    attachEvent(state, line);
    return;
  }
  const twoSpace = /^ {2}([^\s:][^:]*):/.exec(line);
  if (twoSpace) {
    attachTwoSpaceKey(state, twoSpace[1]!);
    return;
  }
  const fourSpace = /^ {4}([^\s:][^:]*):/.exec(line);
  if (fourSpace && state.section === "schemas" && state.open) {
    state.blocks.schemas.get(state.open)!.push(fourSpace[1]!);
  }
}

/**
 * An event name carries colons of its own (`session:new`), so it is matched as
 * the whole whitespace-free key of a nested mapping — which also skips the
 * socket-level `description: …` scalar, whose key is followed by a space.
 */
function attachEvent(state: ParseState, line: string): void {
  const key = /^ {2}(\S+):$/.exec(line);
  if (key && state.open) state.blocks.events.get(state.open)!.push(key[1]!);
}

function attachTwoSpaceKey(state: ParseState, key: string): void {
  if (state.section === "paths") {
    if (state.open && key.startsWith("/")) state.blocks.paths.get(state.open)!.push(key);
    return;
  }
  // Under `components:`. `schemas:` opens the schema section; any other
  // two-space key (`responses:`, `securitySchemes:`) closes it.
  state.section = key === "schemas" ? "schemas" : null;
  state.open = null;
}

let cached: StreamBlocks | null = null;
/** The real `contracts/openapi.yaml`, parsed once. */
export function streamBlocks(): StreamBlocks {
  if (!cached) cached = parseStreamBlocks(readFileSync(CONTRACT_PATH, "utf8"));
  return cached;
}

/** Every path template any stream owns. */
export function streamOwnedPaths(): Set<string> {
  const out = new Set<string>();
  for (const templates of streamBlocks().paths.values()) for (const t of templates) out.add(t);
  return out;
}

/** Every `/events` frame name any stream owns. */
export function streamOwnedEvents(): Set<string> {
  const out = new Set<string>();
  for (const names of streamBlocks().events.values()) for (const n of names) out.add(n);
  return out;
}

/** `"GET /api/sessions/{id} 200"` → `"/api/sessions/{id}"`. */
export function operationTemplate(operation: string): string {
  const parts = operation.split(" ");
  return parts.slice(1, -1).join(" ");
}

/**
 * Every `"METHOD /template status"` the contract declares inside `stream`'s
 * block — what that stream's own `test/contract/<stream>.test.ts` gates on, as
 * its last `describe`.
 *
 * A stream's gate must not lean on coverage another FILE recorded: Bun runs test
 * files in filesystem order, so `openapi.test.ts`'s global unauthenticated sweep
 * may run after the stream's file. A stream therefore exercises every status it
 * declares — 401 included — from its own file.
 */
export function operationsForStream(stream: StreamName): string[] {
  const owned = new Set(streamBlocks().paths.get(stream) ?? []);
  return declaredOperations().filter((o) => owned.has(operationTemplate(o)));
}

/**
 * Every `/events` frame name the contract declares inside `stream`'s block —
 * the event half of `operationsForStream`, and what that stream's own
 * `test/contract/<stream>.test.ts` gates on. The global gate in
 * `openapi.test.ts` skips these for the same file-order reason it skips the
 * stream's paths.
 */
export function eventsForStream(stream: StreamName): string[] {
  const owned = new Set(streamBlocks().events.get(stream) ?? []);
  return declaredEvents().filter((e) => owned.has(e));
}
