import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
