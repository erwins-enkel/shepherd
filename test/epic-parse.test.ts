import { test, expect, describe } from "bun:test";
import { parseEpicBody } from "../src/epic-parse";

const FENCED = [
  "intro",
  "```epic-dag",
  "#320",
  "#326",
  "#321 <- #326",
  "#322 <- #320",
  "#325 <- #320, #322",
  "#323 <- #320, #321, #322",
  "```",
  "- [ ] #320 EFI",
].join("\n");

describe("parseEpicBody", () => {
  test("fenced → members in order + edges", () => {
    const r = parseEpicBody(FENCED);
    expect(r.members).toEqual([320, 326, 321, 322, 325, 323]);
    expect(r.order).toEqual([320, 326, 321, 322, 325, 323]);
    expect(r.edges).toContainEqual({ dependent: 323, blocker: 320 });
    expect(r.edges.filter((e) => e.dependent === 325)).toEqual([
      { dependent: 325, blocker: 320 },
      { dependent: 325, blocker: 322 },
    ]);
  });
  test("checklist only → members, no edges", () => {
    const r = parseEpicBody("- [ ] #10 a\n- [x] #11 b\n");
    expect(r.members).toEqual([10, 11]);
    expect(r.edges).toEqual([]);
  });
  test("no structure → empty", () =>
    expect(parseEpicBody("prose")).toEqual({ members: [], order: [], edges: [] }));
});
