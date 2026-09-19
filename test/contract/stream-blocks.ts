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
const OPEN = /^#\s*──\s*stream:\s*([a-z]+)\s*──$/;
const CLOSE = /^#\s*──\s*\/stream:\s*([a-z]+)\s*──$/;

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

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const opened = OPEN.exec(trimmed);
    if (opened) {
      open = opened[1]!;
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
    if (trimmed.startsWith("#")) continue;

    // A column-0 key ends whatever section we were in.
    if (/^\S/.test(line)) {
      section = line.startsWith("paths:") ? "paths" : null;
      open = null;
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
