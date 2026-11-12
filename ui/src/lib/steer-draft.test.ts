import { describe, it, expect } from "vitest";
import { followSteers } from "./steer-draft";
import type { Steer } from "./types";

const steer = (id: string, p: Partial<Steer> = {}): Steer => ({
  id,
  label: id.toUpperCase(),
  text: `do ${id}`,
  inSteerBar: true,
  onIssues: false,
  ...p,
});
const ids = (list: Steer[]) => list.map((s) => s.id);

describe("followSteers", () => {
  it("adopts changes, additions and removals to rows the editor hasn't touched", () => {
    const before = [steer("a"), steer("b"), steer("c")];
    const after = [steer("a", { text: "changed there" }), steer("c"), steer("d")];
    const next = followSteers(
      before.map((s) => ({ ...s })),
      before,
      after,
    );
    expect(ids(next)).toEqual(["a", "c", "d"]);
    expect(next[0]!.text).toBe("changed there");
  });

  it("keeps a row edited here as typed, even when it changed there too", () => {
    const before = [steer("a"), steer("b")];
    const draft = [steer("a", { label: "Mine " }), steer("b")];
    const after = [steer("a", { label: "Theirs" }), steer("b", { text: "new b" })];
    const next = followSteers(draft, before, after);
    expect(next.find((s) => s.id === "a")!.label).toBe("Mine ");
    expect(next.find((s) => s.id === "b")!.text).toBe("new b");
  });

  it("keeps a row being added here, including once its own save lands", () => {
    const before = [steer("a")];
    const draft = [steer("a"), steer("n", { label: "New, still typ" })];
    // our save of the new row landed with an older label than what is typed by now
    const after = [steer("a"), steer("n", { label: "New, still" })];
    const next = followSteers(draft, before, after);
    expect(ids(next)).toEqual(["a", "n"]);
    expect(next[1]!.label).toBe("New, still typ");
  });

  it("keeps a row removed here removed", () => {
    const before = [steer("a"), steer("b")];
    const draft = [steer("a")];
    const after = [steer("a"), steer("b"), steer("c")];
    expect(ids(followSteers(draft, before, after))).toEqual(["a", "c"]);
  });

  it("follows the store's order unless the editor reordered", () => {
    const before = [steer("a"), steer("b"), steer("c")];
    const after = [steer("c"), steer("a"), steer("b")];
    expect(ids(followSteers([...before], before, after))).toEqual(["c", "a", "b"]);
    const reordered = [steer("b"), steer("a"), steer("c")];
    expect(ids(followSteers(reordered, before, after))).toEqual(["b", "a", "c"]);
  });

  it("treats an emptied repo selection as untouched (it saves as 'all repos')", () => {
    const before = [steer("a")];
    const draft = [steer("a", { repos: [] })];
    const after = [steer("a", { text: "changed there" })];
    expect(followSteers(draft, before, after)[0]!.text).toBe("changed there");
  });
});
