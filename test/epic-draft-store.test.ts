import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import type { EpicDraftContent } from "../src/types";

function mk() {
  return new SessionStore(":memory:");
}

const base = {
  name: "widget-epic",
  prompt: "build the widget epic",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/widget-epic",
  worktreePath: "/r-wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
};

const content: EpicDraftContent = {
  parent: {
    title: "Ship the widget",
    body: "end to end",
    acceptanceCriteria: ["renders", "tested"],
    nonGoals: ["theming"],
  },
  children: [
    { key: "c1", title: "API", body: "endpoint", acceptanceCriteria: ["200"], blockedBy: [] },
    { key: "c2", title: "UI", body: "view", acceptanceCriteria: [], blockedBy: ["c1"] },
  ],
};

test("epicAuthoring flag round-trips on the session row", () => {
  const s = mk();
  const sess = s.create({ ...base, epicAuthoring: true });
  expect(sess.epicAuthoring).toBe(true);
  expect(s.get(sess.id)?.epicAuthoring).toBe(true);
  const plain = s.create({ ...base });
  expect(plain.epicAuthoring).toBe(false);
});

test("replaceEpicDraft / getEpicDraft round-trip with draft status", () => {
  const s = mk();
  const sess = s.create({ ...base, epicAuthoring: true });
  expect(s.getEpicDraft(sess.id)).toBeNull();
  const d = s.replaceEpicDraft(sess.id, content);
  expect(d.status).toBe("draft");
  expect(d.parent.title).toBe("Ship the widget");
  expect(d.parent.acceptanceCriteria).toEqual(["renders", "tested"]);
  expect(d.parent.nonGoals).toEqual(["theming"]);
  expect(d.children.map((c) => c.key)).toEqual(["c1", "c2"]);
  expect(d.materializedChildren).toEqual({});
  expect(d.parentNumber).toBeNull();
  expect(s.getEpicDraft(sess.id)?.children[1]?.blockedBy).toEqual(["c1"]);
});

test("CAS beginEpicDraftMaterialize wins once, then blocks concurrent approve", () => {
  const s = mk();
  const sess = s.create({ ...base });
  s.replaceEpicDraft(sess.id, content);
  expect(s.beginEpicDraftMaterialize(sess.id)).toBe(true); // first wins
  expect(s.beginEpicDraftMaterialize(sess.id)).toBe(false); // second sees 'materializing'
  expect(s.getEpicDraft(sess.id)?.status).toBe("materializing");
});

test("resume: record children, revert on error, retry re-wins CAS retaining partial map", () => {
  const s = mk();
  const sess = s.create({ ...base });
  s.replaceEpicDraft(sess.id, content);
  expect(s.beginEpicDraftMaterialize(sess.id)).toBe(true);
  s.recordEpicDraftChild(sess.id, "c1", 100);
  // simulated error → revert
  s.revertEpicDraftToDraft(sess.id);
  const afterRevert = s.getEpicDraft(sess.id)!;
  expect(afterRevert.status).toBe("draft");
  expect(afterRevert.materializedChildren).toEqual({ c1: 100 }); // retained
  // explicit retry re-wins the CAS
  expect(s.beginEpicDraftMaterialize(sess.id)).toBe(true);
});

test("boot sweep reverts orphaned materializing rows to draft, retaining partial map", () => {
  const s = mk();
  const sess = s.create({ ...base });
  s.replaceEpicDraft(sess.id, content);
  s.beginEpicDraftMaterialize(sess.id);
  s.recordEpicDraftChild(sess.id, "c1", 100);
  s.resetOrphanedEpicDraftMaterialize();
  const swept = s.getEpicDraft(sess.id)!;
  expect(swept.status).toBe("draft");
  expect(swept.materializedChildren).toEqual({ c1: 100 });
});

test("setEpicDraftApproved records parent number/url and terminal status", () => {
  const s = mk();
  const sess = s.create({ ...base });
  s.replaceEpicDraft(sess.id, content);
  s.beginEpicDraftMaterialize(sess.id);
  s.setEpicDraftApproved(sess.id, 42, "https://example.test/issues/42");
  const d = s.getEpicDraft(sess.id)!;
  expect(d.status).toBe("approved");
  expect(d.parentNumber).toBe(42);
  expect(d.parentUrl).toBe("https://example.test/issues/42");
  // a re-PUT (amend) would reset — but an approved epic should not normally be re-PUT; verify reset works
  const reset = s.replaceEpicDraft(sess.id, content);
  expect(reset.status).toBe("draft");
  expect(reset.parentNumber).toBeNull();
});

test("listEpicDrafts returns all authored drafts", () => {
  const s = mk();
  const a = s.create({ ...base });
  const b = s.create({ ...base, name: "other" });
  s.replaceEpicDraft(a.id, content);
  s.replaceEpicDraft(b.id, content);
  expect(
    s
      .listEpicDrafts()
      .map((d) => d.sessionId)
      .sort(),
  ).toEqual([a.id, b.id].sort());
});
