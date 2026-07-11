import { describe, expect, it } from "bun:test";
import type { GitForge } from "../src/forge/types";
import type { EpicDraftContent } from "../src/types";
import {
  materializeEpicDraft,
  renderParentBody,
  topoSortChildren,
  validateEpicDraft,
  type ValidatedEpicDraft,
} from "../src/epic-author";
import { parseEpicBody } from "../src/epic-parse";

// ── fixtures ─────────────────────────────────────────────────────────────────

function content(over: Partial<EpicDraftContent> = {}): EpicDraftContent {
  return {
    parent: {
      title: "Ship the widget",
      body: "Build the widget end to end.",
      acceptanceCriteria: ["widget renders", "widget is tested"],
      nonGoals: ["no theming"],
    },
    children: [
      {
        key: "c1",
        title: "API",
        body: "add endpoint",
        acceptanceCriteria: ["200 ok"],
        blockedBy: [],
      },
      { key: "c2", title: "UI", body: "add view", acceptanceCriteria: [], blockedBy: ["c1"] },
    ],
    ...over,
  };
}

/** In-memory GitForge stub: records createIssue calls, assigns sequential numbers, and
 *  implements the native epic methods so importEpicLinks succeeds. */
function fakeForge(opts: { failCreateAfter?: number; startAt?: number } = {}) {
  let next = opts.startAt ?? 100;
  const created: Array<{ title: string; body: string; number: number }> = [];
  const subIssues = new Map<number, number[]>();
  const blockedBy = new Map<number, number[]>();
  let createCalls = 0;
  const forge = {
    kind: "github",
    async createIssue({ title, body }: { title: string; body: string }) {
      createCalls++;
      if (opts.failCreateAfter != null && createCalls > opts.failCreateAfter)
        throw new Error("simulated forge failure");
      const number = next++;
      created.push({ title, body, number });
      return { number, url: `https://example.test/issues/${number}` };
    },
    async listSubIssues(parent: number) {
      return (subIssues.get(parent) ?? []).map((n) => ({
        number: n,
        title: `#${n}`,
        closed: false,
      }));
    },
    async listBlockedBy(n: number) {
      return blockedBy.get(n) ?? [];
    },
    async addSubIssue(parent: number, child: number) {
      subIssues.set(parent, [...(subIssues.get(parent) ?? []), child]);
    },
    async addBlockedBy(n: number, blocker: number) {
      blockedBy.set(n, [...(blockedBy.get(n) ?? []), blocker]);
    },
  };
  return { forge: forge as unknown as GitForge, created, subIssues, blockedBy };
}

// ── validate ─────────────────────────────────────────────────────────────────

describe("validateEpicDraft", () => {
  it("accepts a well-formed draft and returns children in dependency order", () => {
    const r = validateEpicDraft(
      content({
        children: [
          { key: "c2", title: "UI", body: "", acceptanceCriteria: [], blockedBy: ["c1"] },
          { key: "c1", title: "API", body: "", acceptanceCriteria: [], blockedBy: [] },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.children.map((c) => c.key)).toEqual(["c1", "c2"]);
  });

  it("rejects an empty parent title", () => {
    const r = validateEpicDraft(
      content({ parent: { title: "  ", body: "", acceptanceCriteria: [], nonGoals: [] } }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects zero children", () => {
    const r = validateEpicDraft(content({ children: [] }));
    expect(r.ok).toBe(false);
  });

  it("rejects duplicate keys", () => {
    const r = validateEpicDraft(
      content({
        children: [
          { key: "c1", title: "A", body: "", acceptanceCriteria: [], blockedBy: [] },
          { key: "c1", title: "B", body: "", acceptanceCriteria: [], blockedBy: [] },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a self-edge", () => {
    const r = validateEpicDraft(
      content({
        children: [{ key: "c1", title: "A", body: "", acceptanceCriteria: [], blockedBy: ["c1"] }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects an edge to an unknown key", () => {
    const r = validateEpicDraft(
      content({
        children: [{ key: "c1", title: "A", body: "", acceptanceCriteria: [], blockedBy: ["cX"] }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a dependency cycle", () => {
    const r = validateEpicDraft(
      content({
        children: [
          { key: "c1", title: "A", body: "", acceptanceCriteria: [], blockedBy: ["c2"] },
          { key: "c2", title: "B", body: "", acceptanceCriteria: [], blockedBy: ["c1"] },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("topoSortChildren", () => {
  it("returns null on a cycle", () => {
    expect(
      topoSortChildren([
        { key: "a", title: "", body: "", acceptanceCriteria: [], blockedBy: ["b"] },
        { key: "b", title: "", body: "", acceptanceCriteria: [], blockedBy: ["a"] },
      ]),
    ).toBeNull();
  });
});

// ── renderParentBody ───────────────────────────────────────────────────────────

describe("renderParentBody", () => {
  it("emits an epic-dag fence with real digits and parses back to the same DAG", () => {
    const v = validateEpicDraft(content());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const body = renderParentBody(v.value, { c1: 100, c2: 101 });
    expect(body).toContain("```epic-dag");
    expect(body).not.toContain("#<");
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("## Non-goals");
    const parsed = parseEpicBody(body);
    expect(parsed.members.sort()).toEqual([100, 101]);
    expect(parsed.edges).toEqual([{ dependent: 101, blocker: 100 }]);
  });

  it("emits a checklist when there are no edges", () => {
    const v = validateEpicDraft(
      content({
        children: [
          { key: "c1", title: "A", body: "", acceptanceCriteria: [], blockedBy: [] },
          { key: "c2", title: "B", body: "", acceptanceCriteria: [], blockedBy: [] },
        ],
      }),
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const body = renderParentBody(v.value, { c1: 5, c2: 6 });
    expect(body).not.toContain("epic-dag");
    const parsed = parseEpicBody(body);
    expect(parsed.members.sort()).toEqual([5, 6]);
    expect(parsed.edges).toEqual([]);
  });
});

// ── materializeEpicDraft ───────────────────────────────────────────────────────

describe("materializeEpicDraft", () => {
  it("creates children before the parent, wires native links, returns numbers", async () => {
    const v = validateEpicDraft(content()) as { ok: true; value: ValidatedEpicDraft };
    const { forge, created, subIssues, blockedBy } = fakeForge();
    const persisted: Record<string, number> = {};
    const r = await materializeEpicDraft(forge, v.value, {
      onChildCreated: (k, n) => {
        persisted[k] = n;
      },
    });
    // children (100, 101) created before parent (102)
    expect(created.map((c) => c.number)).toEqual([100, 101, 102]);
    expect(r.childNumbers).toEqual({ c1: 100, c2: 101 });
    expect(persisted).toEqual({ c1: 100, c2: 101 });
    expect(r.parentNumber).toBe(102);
    // native links wired from the parent body fence
    expect(subIssues.get(102)?.sort()).toEqual([100, 101]);
    expect(blockedBy.get(101)).toEqual([100]);
    expect(r.importResult?.subIssuesAdded).toBe(2);
  });

  it("throws when the forge cannot create issues", async () => {
    const v = validateEpicDraft(content()) as { ok: true; value: ValidatedEpicDraft };
    const bare = { kind: "local" } as unknown as GitForge;
    await expect(materializeEpicDraft(bare, v.value)).rejects.toThrow();
  });

  it("resumes without double-creating after a mid-way failure", async () => {
    const v = validateEpicDraft(content()) as { ok: true; value: ValidatedEpicDraft };
    // First attempt: fail after creating the first child.
    const first = fakeForge({ failCreateAfter: 1 });
    const persisted: Record<string, number> = {};
    await expect(
      materializeEpicDraft(first.forge, v.value, {
        onChildCreated: (k, n) => {
          persisted[k] = n;
        },
      }),
    ).rejects.toThrow();
    expect(persisted).toEqual({ c1: 100 }); // only the first child persisted

    // Retry on a fresh forge (distinct number base), passing the persisted map: c1 is skipped.
    const second = fakeForge({ startAt: 200 });
    const r = await materializeEpicDraft(second.forge, v.value, {
      alreadyCreated: { ...persisted },
    });
    // only c2 + parent are created this attempt (c1 skipped) → 200 (c2), 201 (parent)
    expect(second.created.map((c) => c.number)).toEqual([200, 201]);
    expect(r.childNumbers.c1).toBe(100); // carried from alreadyCreated, not re-created
    expect(r.childNumbers.c2).toBe(200); // created this attempt
    expect(r.parentNumber).toBe(201);
  });
});
