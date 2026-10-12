import { describe, expect, it } from "vitest";
import { desigIndex, findDesigLinks } from "./desigLinks";

const live = desigIndex([
  { id: "s31", desig: "TASK-31" },
  { id: "s07", desig: "TASK-07" },
]);

describe("findDesigLinks", () => {
  it("links every desig naming a live session, with its char range", () => {
    const line = "TASK-31 is blocked on TASK-07's plan gate";
    expect(findDesigLinks(line, live)).toEqual([
      { start: 0, end: 7, id: "s31" },
      { start: 22, end: 29, id: "s07" },
    ]);
  });

  it("matches case-insensitively, like the server's desig lookup", () => {
    expect(findDesigLinks("see task-31", live)).toEqual([{ start: 4, end: 11, id: "s31" }]);
  });

  it("ignores desigs with no live session", () => {
    expect(findDesigLinks("TASK-99 finished", live)).toEqual([]);
  });

  it("links tokens wrapped in punctuation", () => {
    for (const line of [
      "(TASK-31)",
      "`TASK-31`",
      "TASK-31.",
      "TASK-31:",
      '"TASK-31"',
      "#TASK-31",
    ]) {
      expect(
        findDesigLinks(line, live).map((l) => l.id),
        line,
      ).toEqual(["s31"]);
    }
  });

  it("does not link inside a longer word, number or path", () => {
    for (const line of ["TASK-311", "XTASK-31", "shepherd/TASK-31", "TASK-31-fix", "TASK-31b"]) {
      expect(findDesigLinks(line, live), line).toEqual([]);
    }
  });

  it("returns nothing for an empty herd", () => {
    expect(findDesigLinks("TASK-31", new Map())).toEqual([]);
  });
});
