import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeContractDeps } from "./deps";
import {
  eventsForStream,
  operationsForStream,
  operationTemplate,
  parseStreamBlocks,
  streamBlocks,
  streamOwnedEvents,
  streamOwnedPaths,
  STREAM_NAMES,
} from "./stream-blocks";

/**
 * The per-stream insertion points in the contract.
 *
 * Every parallel stream appends its schemas, paths and events INSIDE its own
 * marked block — three blocks per stream, one in each of `components.schemas:`,
 * `paths:` and `x-shepherd-events:` — so two branches adding routes collide as
 * insertion conflicts resolved by keeping both blocks, not as a fight over the
 * same trailing lines. This guards the markers; openapi.test.ts still guards
 * what goes between them.
 */
const CONTRACT = readFileSync(
  join(import.meta.dir, "..", "..", "contracts", "openapi.yaml"),
  "utf8",
);
const LINES = CONTRACT.split("\n").map((line) => line.trim());
const STREAMS = STREAM_NAMES;

const first = (needle: string) => LINES.indexOf(needle);
const last = (needle: string) => LINES.lastIndexOf(needle);
const nth = (needle: string, n: number) => {
  let seen = 0;
  for (let i = 0; i < LINES.length; i++) {
    if (LINES[i] === needle && ++seen === n) return i;
  }
  return -1;
};
const count = (needle: string) => LINES.filter((line) => line === needle).length;

describe("contract stream blocks", () => {
  test("every stream has one open and one close marker per section", () => {
    for (const stream of STREAMS) {
      expect(count(`# ── stream: ${stream} ──`)).toBe(3);
      expect(count(`# ── /stream: ${stream} ──`)).toBe(3);
    }
  });

  test("the schema blocks sit at the end of components.schemas, before responses", () => {
    const schemas = first("schemas:");
    const responses = first("responses:");
    expect(schemas).toBeGreaterThan(-1);
    expect(responses).toBeGreaterThan(schemas);
    for (const stream of STREAMS) {
      expect(first(`# ── stream: ${stream} ──`)).toBeGreaterThan(schemas);
      expect(first(`# ── /stream: ${stream} ──`)).toBeLessThan(responses);
    }
  });

  test("the path blocks sit at the end of paths, before x-shepherd-events", () => {
    const paths = first("paths:");
    const events = first("x-shepherd-events:");
    expect(events).toBeGreaterThan(paths);
    for (const stream of STREAMS) {
      expect(nth(`# ── stream: ${stream} ──`, 2)).toBeGreaterThan(paths);
      expect(nth(`# ── /stream: ${stream} ──`, 2)).toBeLessThan(events);
    }
  });

  test("the event blocks sit at the end of x-shepherd-events, before x-shepherd-pty", () => {
    const events = first("x-shepherd-events:");
    const pty = first("x-shepherd-pty:");
    expect(pty).toBeGreaterThan(events);
    for (const stream of STREAMS) {
      expect(last(`# ── stream: ${stream} ──`)).toBeGreaterThan(events);
      expect(last(`# ── /stream: ${stream} ──`)).toBeLessThan(pty);
    }
  });

  test("the streams appear in the agreed order in all three sections", () => {
    const opens = LINES.filter((line) => line.startsWith("# ── stream: ")).map((line) =>
      line.replace("# ── stream: ", "").replace(" ──", ""),
    );
    expect(opens).toEqual([...STREAMS, ...STREAMS, ...STREAMS]);
  });
});

// A miniature contract: one schema, one route and one event outside the
// markers, one of each inside the sidebar block. Parsing a fixture rather than
// the real file is what lets this test exist before any stream has filled a
// block.
const SYNTHETIC = `openapi: 3.1.0
components:
  schemas:
    Health:
      type: object
    # ── stream: sidebar ──
    Backlog:
      type: object
    # ── /stream: sidebar ──
  responses:
    Unauthorized:
      description: no
paths:
  /api/health:
    get:
      operationId: getHealth
  # ── stream: sidebar ──
  /api/backlog:
    get:
      operationId: getBacklog
  # ── /stream: sidebar ──
x-shepherd-events:
  description: 'Frames look like: {"event": string}'
  envelope:
    $ref: "#/components/schemas/EventEnvelope"
  session:new:
    schema:
      $ref: "#/components/schemas/Session"
  # ── stream: sidebar ──
  backlog:changed:
    schema:
      $ref: "#/components/schemas/Backlog"
  # ── /stream: sidebar ──
x-shepherd-pty:
  description: nope
`;

describe("stream-blocks helper", () => {
  test("schemas, paths and events inside a block are attributed to that stream", () => {
    const blocks = parseStreamBlocks(SYNTHETIC);
    expect(blocks.paths.get("sidebar")).toEqual(["/api/backlog"]);
    expect(blocks.schemas.get("sidebar")).toEqual(["Backlog"]);
    expect(blocks.events.get("sidebar")).toEqual(["backlog:changed"]);
    // Everything outside the markers stays unowned — including the `responses:`
    // sibling of `schemas:`, the top-level keys after `paths:`, and the
    // socket-level `description`/`envelope` keys plus the core `session:new`
    // event that sit above the events block.
    for (const stream of STREAM_NAMES) {
      if (stream === "sidebar") continue;
      expect(blocks.paths.get(stream)).toEqual([]);
      expect(blocks.schemas.get(stream)).toEqual([]);
      expect(blocks.events.get(stream)).toEqual([]);
    }
  });

  test("a second opener while a block is open is a parse error", () => {
    // Nesting is never the intent: it silently attributes one stream's routes
    // to another and leaves an unbalanced marker behind on the next rebase.
    const nested = SYNTHETIC.replace(
      "  # ── stream: sidebar ──\n  /api/backlog:",
      "  # ── stream: sidebar ──\n  # ── stream: actions ──\n  /api/backlog:",
    );
    expect(() => parseStreamBlocks(nested)).toThrow(
      /stream actions opened while sidebar is still open/,
    );
  });

  test("a close marker for the wrong stream is a parse error", () => {
    const mismatched = SYNTHETIC.replace("# ── /stream: sidebar ──", "# ── /stream: actions ──");
    expect(() => parseStreamBlocks(mismatched)).toThrow(/closed by actions/);
  });

  test("an opener whose name is not in STREAM_NAMES is a parse error", () => {
    const bogus = SYNTHETIC.replace(
      "# ── stream: sidebar ──\n    Backlog:",
      "# ── stream: nope ──\n    Backlog:",
    );
    expect(() => parseStreamBlocks(bogus)).toThrow(/unknown stream "nope"/);
  });

  test("an opener still open at the next column-0 key is a parse error", () => {
    // Dedicated fixture, not a SYNTHETIC edit: SYNTHETIC's schema-section (4-space)
    // and path-section (2-space) close markers for "sidebar" share the same text once
    // the indent is stripped, so a plain string .replace can't remove just one.
    const unclosed = `openapi: 3.1.0
paths:
  /api/health:
    get:
      operationId: getHealth
  # ── stream: sidebar ──
  /api/backlog:
    get:
      operationId: getBacklog
x-shepherd-events:
  description: nope
`;
    expect(() => parseStreamBlocks(unclosed)).toThrow(/stream block sidebar still open/);
  });

  test("an opener still open at EOF is a parse error", () => {
    const unclosed = `openapi: 3.1.0
paths:
  # ── stream: sidebar ──
  /api/backlog:
    get:
      operationId: getBacklog
`;
    expect(() => parseStreamBlocks(unclosed)).toThrow(/stream block sidebar still open at EOF/);
  });

  test("a marker-shaped comment that fails the exact grammar is a parse error, not a comment", () => {
    // Wrong case.
    expect(() =>
      parseStreamBlocks(SYNTHETIC.replace("# ── stream: sidebar ──", "# ── STREAM: sidebar ──")),
    ).toThrow(/malformed stream marker/);
    // Wrong dash count (one dash instead of two).
    expect(() =>
      parseStreamBlocks(SYNTHETIC.replace("# ── stream: sidebar ──", "# ─ stream: sidebar ──")),
    ).toThrow(/malformed stream marker/);
    // Extra internal whitespace before the closing dashes.
    expect(() =>
      parseStreamBlocks(SYNTHETIC.replace("# ── stream: sidebar ──", "# ── stream: sidebar  ──")),
    ).toThrow(/malformed stream marker/);
  });

  test("operationTemplate strips the method and the status", () => {
    expect(operationTemplate("GET /api/sessions/{id} 200")).toBe("/api/sessions/{id}");
  });

  test("the gate's filter drops operations inside a block and keeps the rest", () => {
    const owned = new Set([...parseStreamBlocks(SYNTHETIC).paths.values()].flat());
    const declared = ["GET /api/health 200", "GET /api/backlog 200", "GET /api/backlog 401"];
    // This is exactly the expression the coverage gate in openapi.test.ts uses.
    expect(declared.filter((o) => !owned.has(operationTemplate(o)))).toEqual([
      "GET /api/health 200",
    ]);
  });

  test("the event gate's filter drops events inside a block and keeps the rest", () => {
    const owned = new Set([...parseStreamBlocks(SYNTHETIC).events.values()].flat());
    const declared = ["session:new", "backlog:changed"];
    // This is exactly the expression the event coverage gate in openapi.test.ts uses.
    expect(declared.filter((e) => !owned.has(e))).toEqual(["session:new"]);
  });
});

/**
 * Invariants over the live contract, not a snapshot of it.
 *
 * "Every block is empty" was true only until the first stream landed, and would
 * have failed that stream's own branch. What has to hold forever is that the
 * blocks stay well-formed and disjoint however full they get — the emptiness
 * checks live on in the synthetic fixture above, where they mean something.
 */
describe("the real contract's stream blocks", () => {
  const blocks = streamBlocks();
  const sections = [
    ["paths", blocks.paths],
    ["schemas", blocks.schemas],
    ["events", blocks.events],
  ] as const;

  test("every section names exactly the registered streams", () => {
    for (const [label, map] of sections) {
      expect([...map.keys()].sort(), label).toEqual([...STREAM_NAMES].sort());
    }
  });

  test("nothing inside a block is claimed by a second block", () => {
    for (const [label, map] of sections) {
      const all = [...map.values()].flat();
      expect(all.length, `${label}: a duplicate entry across blocks`).toBe(new Set(all).size);
    }
  });

  test("the owned sets are exactly the union of the blocks", () => {
    expect([...streamOwnedPaths()].sort()).toEqual([...blocks.paths.values()].flat().sort());
    expect([...streamOwnedEvents()].sort()).toEqual([...blocks.events.values()].flat().sort());
  });

  // Runs the two per-stream gates against the real contract and harness. Empty on
  // this branch, non-empty the moment a stream fills its block — and right either
  // way, because what is asserted is the correspondence, not the count.
  test("operationsForStream covers a stream's block and nothing else", () => {
    for (const stream of STREAM_NAMES) {
      const owned = blocks.paths.get(stream) ?? [];
      const templates = new Set(operationsForStream(stream).map(operationTemplate));
      expect([...templates].sort(), stream).toEqual([...owned].sort());
    }
  });

  test("eventsForStream covers a stream's block and nothing else", () => {
    for (const stream of STREAM_NAMES) {
      const owned = blocks.events.get(stream) ?? [];
      expect([...eventsForStream(stream)].sort(), stream).toEqual([...owned].sort());
    }
  });
});

/** The thirteen optional AppDeps the milestone-3 routes read. Absent, every one of those routes
 *  answers its empty value and a stream cannot exercise the payload it declared — which is the
 *  whole point of the drift test. Asserted here rather than in a stream's file because `deps.ts`
 *  is shared and no stream may edit it. */
describe("the contract harness wires the milestone-3 deps", () => {
  test("every optional dep the new blocks read is present and seedable", () => {
    const ctx = makeContractDeps();
    try {
      for (const key of [
        "prCache",
        "activity",
        "claudeAlive",
        "stranded",
        "workingBlocked",
        "blocks",
        "holds",
        "reviewCache",
        "planGateCache",
        "recapCache",
        "autoMerge",
        "resolveForge",
        "shapeTask",
      ] as const) {
        expect(ctx.deps[key], key).toBeDefined();
        expect(ctx.stubs[key], `stubs.${key}`).toBeDefined();
      }
      ctx.stubs.prCache.rows["sess_x"] = {
        kind: "github",
        state: "open",
        checks: "success",
        deployConfigured: false,
      };
      expect(ctx.deps.prCache?.snapshot()["sess_x"]?.state).toBe("open");
      ctx.stubs.stranded.ids = ["sess_x"];
      expect(ctx.deps.stranded?.ids()).toEqual(["sess_x"]);
      // S11's two: an absent resolveForge makes GET /api/issues answer an empty listing on
      // every call, and an absent shapeTask makes POST /api/shape answer 503.
      ctx.stubs.resolveForge.forge = { listIssues: async () => [], slug: "o/r" } as never;
      expect(ctx.deps.resolveForge?.(ctx.validRepo)).not.toBeNull();
      // And the repo the harness hands out must be a real git repository, because
      // GET /api/branches shells out to git against it.
      expect(existsSync(join(ctx.validRepo, ".git"))).toBe(true);
    } finally {
      ctx.cleanup();
    }
  });
});
