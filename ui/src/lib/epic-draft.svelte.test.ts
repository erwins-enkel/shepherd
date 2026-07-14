import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EpicDraft } from "./types";
import { epicDrafts } from "./epic-draft.svelte";
import * as api from "./api";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getEpicDraft: vi.fn(),
}));

function draft(sessionId: string, status: EpicDraft["status"]): EpicDraft {
  return {
    sessionId,
    parent: { title: "t", body: "b", acceptanceCriteria: [], nonGoals: [] },
    children: [{ key: "c1", title: "Child", body: "b", acceptanceCriteria: [], blockedBy: [] }],
    status,
    materializedChildren: {},
    parentNumber: status === "approved" ? 13 : null,
    parentUrl: status === "approved" ? "https://example.test/13" : null,
  };
}

describe("EpicDraftsStore.refresh", () => {
  beforeEach(() => {
    epicDrafts.map = {};
    vi.mocked(api.getEpicDraft).mockReset();
  });

  it("upserts the server's row and returns it", async () => {
    vi.mocked(api.getEpicDraft).mockResolvedValue(draft("s1", "materializing"));

    expect((await epicDrafts.refresh("s1"))?.status).toBe("materializing");
    expect(epicDrafts.get("s1")?.status).toBe("materializing");
  });

  it("evicts the cached row when the server reports no draft", async () => {
    epicDrafts.upsert(draft("s1", "draft"));
    vi.mocked(api.getEpicDraft).mockResolvedValue(null);

    expect(await epicDrafts.refresh("s1")).toBeNull();
    expect(epicDrafts.get("s1")).toBeUndefined();
  });

  // The reconcile's GET can lose a race: if the handler finishes while it is in flight, the WS event
  // carrying the TERMINAL state lands first. Writing the older `materializing` response over it would
  // pin the panel on "materializing" forever — no further event is coming — with a sticky in-progress
  // toast, until a reload. A write that landed during the GET must win.
  it.each([
    ["approved", "approved" as const],
    ["reverted to draft", "draft" as const],
  ])("does not clobber a WS event that landed mid-flight (%s)", async (_label, terminal) => {
    epicDrafts.upsert(draft("s1", "draft"));

    vi.mocked(api.getEpicDraft).mockImplementation(async () => {
      // The handler finishes while the GET is in flight: the WS event upserts the terminal row...
      epicDrafts.upsert(draft("s1", terminal));
      // ...and only then does this (now stale) response resolve.
      return draft("s1", "materializing");
    });

    const returned = await epicDrafts.refresh("s1");

    expect(epicDrafts.get("s1")?.status).toBe(terminal); // the newer event survives
    expect(returned?.status).toBe(terminal); // and the caller sees the truth, not the stale row
  });

  // ...but the guard must be scoped to THIS session. Every write replaces `map` wholesale, so a
  // global write counter would also trip on an unrelated session's event — discarding a perfectly
  // good response and reporting the stale `draft` row as a failure for an approve that is still
  // materializing and about to succeed.
  it("is not tripped by an unrelated session's write during the GET", async () => {
    epicDrafts.upsert(draft("s1", "draft"));

    vi.mocked(api.getEpicDraft).mockImplementation(async () => {
      epicDrafts.upsert(draft("other-session", "approved")); // noise from another panel/WS event
      return draft("s1", "materializing");
    });

    const returned = await epicDrafts.refresh("s1");

    expect(returned?.status).toBe("materializing"); // the fresh response is kept, not discarded
    expect(epicDrafts.get("s1")?.status).toBe("materializing");
  });
});
