import { test, expect, describe } from "bun:test";
import { importEpicLinks } from "../src/epic-import";

function fakeForge(
  existingSubs: number[],
  existingBy: Map<number, number[]>,
  throwOnSubIssue?: Set<number>,
  throwOnBlockedBy?: Set<number>,
) {
  const subAdds: Array<[number, number]> = [],
    depAdds: Array<[number, number]> = [];
  return {
    forge: {
      listSubIssues: async () =>
        existingSubs.map((n) => ({
          number: n,
          title: `#${n}`,
          url: "",
          body: "",
          closed: false,
          labels: [],
        })),
      listBlockedBy: async (n: number) => existingBy.get(n) ?? [],
      addSubIssue: async (p: number, c: number) => {
        if (throwOnSubIssue?.has(c)) throw new Error(`cannot resolve id for #${c}`);
        subAdds.push([p, c]);
      },
      addBlockedBy: async (i: number, b: number) => {
        if (throwOnBlockedBy?.has(b)) throw new Error(`cannot resolve id for #${b}`);
        depAdds.push([i, b]);
      },
    } as never,
    subAdds,
    depAdds,
  };
}
const BODY = "```epic-dag\n#320\n#326\n#322 <- #320\n```";

describe("importEpicLinks", () => {
  test("creates missing", async () => {
    const f = fakeForge([], new Map());
    const r = await importEpicLinks(f.forge, 327, BODY);
    expect(f.subAdds).toEqual([
      [327, 320],
      [327, 326],
      [327, 322],
    ]);
    expect(f.depAdds).toEqual([[322, 320]]);
    expect(r).toEqual({ subIssuesAdded: 3, dependenciesAdded: 1, skipped: 0, unresolved: [] });
  });

  test("idempotent", async () => {
    const f = fakeForge([320, 326, 322], new Map([[322, [320]]]));
    const r = await importEpicLinks(f.forge, 327, BODY);
    expect(f.subAdds).toEqual([]);
    expect(f.depAdds).toEqual([]);
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.unresolved).toEqual([]);
  });

  test("skips unresolvable sub-issue, continues + reports", async () => {
    // BODY has #320, #326, #322 — #999 does not appear, use a body with a bad member
    const body = "```epic-dag\n#320\n#999\n#322\n```";
    const f = fakeForge([], new Map(), new Set([999]));
    const r = await importEpicLinks(f.forge, 327, body);
    // good members still linked
    expect(f.subAdds).toContainEqual([327, 320]);
    expect(f.subAdds).toContainEqual([327, 322]);
    // bad member not added
    expect(f.subAdds.map(([, c]) => c)).not.toContain(999);
    expect(r.subIssuesAdded).toBe(2);
    expect(r.unresolved).toEqual([999]);
  });

  test("skips unresolvable blocker in dependency, continues + reports", async () => {
    // #322 blocked by #320, but #320 can't be resolved
    const f = fakeForge([], new Map(), undefined, new Set([320]));
    const r = await importEpicLinks(f.forge, 327, BODY);
    // sub-issues all added fine
    expect(r.subIssuesAdded).toBe(3);
    // dependency with bad blocker not added
    expect(f.depAdds).toEqual([]);
    expect(r.dependenciesAdded).toBe(0);
    expect(r.unresolved).toEqual([320]);
  });

  test("skips dependency whose blocker is already unresolved from sub-issue phase", async () => {
    // #320 fails as sub-issue AND is a blocker for #322 — should not attempt addBlockedBy
    const f = fakeForge([], new Map(), new Set([320]));
    const r = await importEpicLinks(f.forge, 327, BODY);
    // #320 unresolved in sub-issue phase
    expect(r.unresolved).toContain(320);
    // addBlockedBy for #322 blocked-by #320 must not be attempted
    expect(f.depAdds).toEqual([]);
    expect(r.dependenciesAdded).toBe(0);
    // 320 appears only once in unresolved
    expect(r.unresolved.filter((n) => n === 320)).toHaveLength(1);
  });

  // A child listed on multiple `<-` lines (two blockers) must be added exactly once. Before the
  // parser dedup, the duplicated member was re-`addSubIssue`'d — the pre-loop existingSubs snapshot
  // didn't yet contain it, so the forge threw and it landed in `unresolved` (spurious miscount).
  test("multi-line blockers → child added once, both edges wired", async () => {
    const body = "```epic-dag\n#707\n#708\n#709 <- #707\n#709 <- #708\n```";
    const f = fakeForge([], new Map());
    const r = await importEpicLinks(f.forge, 327, body);
    expect(f.subAdds).toEqual([
      [327, 707],
      [327, 708],
      [327, 709],
    ]);
    expect(f.depAdds).toEqual([
      [709, 707],
      [709, 708],
    ]);
    expect(r).toEqual({ subIssuesAdded: 3, dependenciesAdded: 2, skipped: 0, unresolved: [] });
  });

  test("throws on forge with no native support", async () => {
    const bare = {} as never;
    await expect(importEpicLinks(bare, 1, BODY)).rejects.toThrow(
      "forge does not support native epic links",
    );
  });
});
