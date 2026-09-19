import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  operationTemplate,
  parseStreamBlocks,
  streamBlocks,
  streamOwnedPaths,
  STREAM_NAMES,
} from "./stream-blocks";

/**
 * The per-stream insertion points in the contract.
 *
 * Every parallel stream appends its paths and schemas INSIDE its own marked
 * block, so two branches adding routes collide as insertion conflicts resolved
 * by keeping both blocks — not as a fight over the same trailing lines. This
 * guards the markers; openapi.test.ts still guards what goes between them.
 */
const CONTRACT = readFileSync(
  join(import.meta.dir, "..", "..", "contracts", "openapi.yaml"),
  "utf8",
);
const LINES = CONTRACT.split("\n").map((line) => line.trim());
const STREAMS = ["terminal", "detail", "sidebar", "actions"] as const;

const first = (needle: string) => LINES.indexOf(needle);
const last = (needle: string) => LINES.lastIndexOf(needle);
const count = (needle: string) => LINES.filter((line) => line === needle).length;

describe("contract stream blocks", () => {
  test("every stream has one open and one close marker per section", () => {
    for (const stream of STREAMS) {
      expect(count(`# ── stream: ${stream} ──`)).toBe(2);
      expect(count(`# ── /stream: ${stream} ──`)).toBe(2);
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
      expect(last(`# ── stream: ${stream} ──`)).toBeGreaterThan(paths);
      expect(last(`# ── /stream: ${stream} ──`)).toBeLessThan(events);
    }
  });

  test("the streams appear in the agreed order in both sections", () => {
    const opens = LINES.filter((line) => line.startsWith("# ── stream: ")).map((line) =>
      line.replace("# ── stream: ", "").replace(" ──", ""),
    );
    expect(opens).toEqual([...STREAMS, ...STREAMS]);
  });
});

// A miniature contract: one route and one schema outside the markers, one of
// each inside the sidebar block. Parsing a fixture rather than the real file is
// what lets this test exist before any stream has filled a block.
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
  description: nope
`;

describe("stream-blocks helper", () => {
  test("paths and schemas inside a block are attributed to that stream", () => {
    const blocks = parseStreamBlocks(SYNTHETIC);
    expect(blocks.paths.get("sidebar")).toEqual(["/api/backlog"]);
    expect(blocks.schemas.get("sidebar")).toEqual(["Backlog"]);
    // Everything outside the markers stays unowned — including the `responses:`
    // sibling of `schemas:` and the top-level keys after `paths:`.
    for (const stream of STREAM_NAMES) {
      if (stream === "sidebar") continue;
      expect(blocks.paths.get(stream)).toEqual([]);
      expect(blocks.schemas.get(stream)).toEqual([]);
    }
  });

  test("a close marker for the wrong stream is a parse error", () => {
    const mismatched = SYNTHETIC.replace("# ── /stream: sidebar ──", "# ── /stream: actions ──");
    expect(() => parseStreamBlocks(mismatched)).toThrow(/closed by actions/);
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

  test("the real contract's blocks are all still empty on this branch", () => {
    expect(streamOwnedPaths().size).toBe(0);
    expect([...streamBlocks().paths.keys()].sort()).toEqual([...STREAM_NAMES].sort());
  });
});
