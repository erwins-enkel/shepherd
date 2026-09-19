import { readFileSync } from "node:fs";
import { join } from "node:path";
import { declaredOperations } from "./harness";

/** The streams that own a marked block, in the order S0-prep placed them. */
export const STREAM_NAMES = ["terminal", "detail", "sidebar", "actions"] as const;
export type StreamName = (typeof STREAM_NAMES)[number];

export interface StreamBlocks {
  /** Path templates inside each stream's block in `paths:`. */
  paths: Map<string, string[]>;
  /** Component schema names inside each stream's block in `components.schemas:`. */
  schemas: Map<string, string[]>;
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
 * Raw text, not `Bun.YAML.parse`: the markers are comments and a YAML parse
 * drops them. Indentation is the section discriminator — a top-level key sits at
 * column 0, a path template two spaces under `paths:`, a schema name four spaces
 * under `components:` → `schemas:`.
 */
export function parseStreamBlocks(yaml: string): StreamBlocks {
  const paths = new Map<string, string[]>();
  const schemas = new Map<string, string[]>();
  for (const name of STREAM_NAMES) {
    paths.set(name, []);
    schemas.set(name, []);
  }

  let section: "paths" | "schemas" | null = null;
  let open: string | null = null;

  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const lineNo = i + 1;

    const opened = OPEN.exec(trimmed);
    if (opened) {
      const name = opened[1]!;
      if (!STREAM_NAME_SET.has(name)) {
        throw new Error(`line ${lineNo}: unknown stream "${name}" — not in STREAM_NAMES`);
      }
      open = name;
      continue;
    }
    const closed = CLOSE.exec(trimmed);
    if (closed) {
      if (closed[1] !== open) {
        throw new Error(`stream block ${open ?? "(none)"} closed by ${closed[1]}`);
      }
      open = null;
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (looksLikeMarker(trimmed)) {
        throw new Error(`line ${lineNo}: malformed stream marker: ${trimmed}`);
      }
      continue;
    }

    // A column-0 key ends whatever section we were in.
    if (/^\S/.test(line)) {
      if (open) {
        throw new Error(`line ${lineNo}: stream block ${open} still open at "${trimmed}"`);
      }
      section = line.startsWith("paths:") ? "paths" : null;
      continue;
    }
    const twoSpace = /^ {2}([^\s:][^:]*):/.exec(line);
    if (twoSpace) {
      if (section === "paths") {
        if (open && twoSpace[1]!.startsWith("/")) paths.get(open)!.push(twoSpace[1]!);
      } else {
        // Under `components:`. `schemas:` opens the schema section; any other
        // two-space key (`responses:`, `securitySchemes:`) closes it.
        section = twoSpace[1] === "schemas" ? "schemas" : null;
        open = null;
      }
      continue;
    }
    const fourSpace = /^ {4}([^\s:][^:]*):/.exec(line);
    if (fourSpace && section === "schemas" && open) schemas.get(open)!.push(fourSpace[1]!);
  }

  if (open) {
    throw new Error(`stream block ${open} still open at EOF`);
  }

  return { paths, schemas };
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
