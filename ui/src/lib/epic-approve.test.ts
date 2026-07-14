import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EpicDraft } from "./types";
import { epicDrafts } from "./epic-draft.svelte";
import { toasts } from "./toasts.svelte";
import { m } from "./paraglide/messages";
import * as api from "./api";
import { approveEpic, __resetAwaiting } from "./epic-approve";

// Mock only the network boundaries; ApiError + isPreviewBlocked stay REAL — the reconcile
// discriminates on them, so stubbing them would test the mock instead of the code.
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  approveEpicDraft: vi.fn(),
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

/** The bodyless-response fallback `apiError` builds when a proxy 502s a severed socket. A plain
 *  Error — NOT a TypeError — which is exactly why "not a TypeError" cannot gate the message. */
const proxy502 = () => new Error("epic-draft approve failed: 502");
const networkDrop = () => new TypeError("Failed to fetch");

const text = () => toasts.items.map((t) => t.text);
const last = () => toasts.items[toasts.items.length - 1]?.text;

// A fresh session id per test. The toast store's keyed-dedupe map OUTLIVES a test (only `items` is
// reset), so reusing an id would make a toast dedupe against the previous test's entry — refreshing
// a row that is no longer in `items` — and silently emit nothing at all.
let n = 0;
const nextSid = () => `s-${++n}`;

describe("approveEpic", () => {
  beforeEach(() => {
    toasts.items = [];
    epicDrafts.map = {};
    __resetAwaiting();
    vi.mocked(api.approveEpicDraft).mockReset();
    vi.mocked(api.getEpicDraft).mockReset();
  });

  it("toasts success on the happy path", async () => {
    const s1 = nextSid();
    vi.mocked(api.approveEpicDraft).mockResolvedValue({
      parentNumber: 13,
      parentUrl: "u",
      childNumbers: {},
    } as never);

    await approveEpic(s1);
    expect(last()).toBe(m.epicdraft_approve_success({ n: 13 }));
  });

  // A throw does NOT mean failure: the request can lose its connection while the handler runs on and
  // commits the epic. The two shapes — bodyless proxy 502 (dev) and fetch TypeError (prod) — must both
  // reconcile against the SERVER's state, not the throw.
  it.each([
    ["bodyless 502", proxy502],
    ["network TypeError", networkDrop],
  ])("reports success when %s hid an approve that actually landed", async (_l, thrown) => {
    const s1 = nextSid();
    vi.mocked(api.approveEpicDraft).mockRejectedValue(thrown());
    vi.mocked(api.getEpicDraft).mockResolvedValue(draft(s1, "approved"));

    await approveEpic(s1);
    expect(last()).toBe(m.epicdraft_approve_success({ n: 13 }));
  });

  // THE REGRESSION GUARD. Server killed mid-materialize → the orphan-reset row is back at `draft`, and
  // the thrown proxy 502 is a plain Error. A discriminator of "show e.message unless it's a TypeError"
  // renders "epic-draft approve failed: 502" straight to the operator — the very string this fix
  // exists to kill. Only message PROVENANCE (ApiError.serverAuthored) rejects it.
  it.each([
    ["bodyless 502", proxy502, "epic-draft approve failed: 502"],
    ["network TypeError", networkDrop, "Failed to fetch"],
  ])("shows the generic failure — never the raw %s string", async (_l, thrown, raw) => {
    const s1 = nextSid();
    vi.mocked(api.approveEpicDraft).mockRejectedValue(thrown());
    vi.mocked(api.getEpicDraft).mockResolvedValue(draft(s1, "draft"));

    await approveEpic(s1);
    expect(last()).toBe(m.epicdraft_approve_failed());
    expect(last()).not.toContain(raw);
  });

  // The 500 case guards a status-range rule (`status < 500`) from creeping back in: the handler's 500
  // carries `{error: e.message}` and is the most informative failure this flow can produce.
  it.each([
    [400, "no forge for this repo"],
    [409, "epic materialize already in progress"],
    [500, "epic materialize failed: GitHub rate limit exceeded"],
  ])("surfaces the server-authored %s message", async (status, msg) => {
    const s1 = nextSid();
    vi.mocked(api.approveEpicDraft).mockRejectedValue(
      new api.ApiError(status as number, msg as string, undefined, true),
    );
    vi.mocked(api.getEpicDraft).mockResolvedValue(draft(s1, "draft"));

    await approveEpic(s1);
    expect(last()).toBe(msg);
  });

  // An empty `{error: ""}` is NOT a server message — honouring it would render a blank toast.
  it("shows the generic failure for an empty server message, not a blank toast", async () => {
    const s1 = nextSid();
    vi.mocked(api.approveEpicDraft).mockRejectedValue(new api.ApiError(500, "", undefined, false));
    vi.mocked(api.getEpicDraft).mockResolvedValue(draft(s1, "draft"));

    await approveEpic(s1);
    expect(last()).toBe(m.epicdraft_approve_failed());
  });

  it.each([
    ["the refetch throws", () => vi.mocked(api.getEpicDraft).mockRejectedValue(new Error("x"))],
    ["the session has no draft", () => vi.mocked(api.getEpicDraft).mockResolvedValue(null)],
  ])("falls back to the generic failure when %s", async (_l, arrange) => {
    const s1 = nextSid();
    vi.mocked(api.approveEpicDraft).mockRejectedValue(proxy502());
    (arrange as () => void)();

    await approveEpic(s1);
    expect(last()).toBe(m.epicdraft_approve_failed());
    expect(last()).not.toContain("failed: ");
  });

  // Every outcome shares one key per session. The failure toast is sticky — it never auto-dismisses —
  // so without the key a retry's success toast appears BESIDE a pinned "Couldn't create the epic.",
  // telling the operator two contradictory things at once.
  it("supersedes a pinned failure toast when the retry succeeds", async () => {
    const s1 = nextSid();
    vi.mocked(api.approveEpicDraft).mockRejectedValue(proxy502());
    vi.mocked(api.getEpicDraft).mockResolvedValue(draft(s1, "draft"));
    await approveEpic(s1);
    expect(last()).toBe(m.epicdraft_approve_failed());

    vi.mocked(api.approveEpicDraft).mockResolvedValue({
      parentNumber: 13,
      parentUrl: "u",
      childNumbers: {},
    } as never);
    await approveEpic(s1);

    expect(toasts.items).toHaveLength(1); // superseded in place, not stacked
    expect(last()).toBe(m.epicdraft_approve_success({ n: 13 }));
  });

  // The response died and the handler is STILL materializing. Its terminal state arrives later over
  // WS. Without the watcher a subsequent failure would be entirely silent — in the exact scenario this
  // whole change exists for. The watcher lives outside the component tree, so it keeps working after
  // the modal that started the approve is closed and the operator has moved to another session.
  describe("a materialize whose response was lost", () => {
    let pendingSid = "";
    beforeEach(() => {
      pendingSid = nextSid();
      vi.mocked(api.approveEpicDraft).mockRejectedValue(proxy502());
      vi.mocked(api.getEpicDraft).mockResolvedValue(draft(pendingSid, "materializing"));
    });

    it.each([
      ["failure", "draft" as const, () => m.epicdraft_approve_failed()],
      ["success", "approved" as const, () => m.epicdraft_approve_success({ n: 13 })],
    ])("resolves into a %s toast when the WS event lands", async (_l, terminal, expected) => {
      const s1 = pendingSid;
      await approveEpic(s1);
      expect(last()).toBe(m.epicdraft_approve_in_progress());

      epicDrafts.upsert(draft(s1, terminal)); // the WS `session:epic-draft` event

      expect(toasts.items).toHaveLength(1); // superseded its own in-progress toast
      expect(last()).toBe(expected());
    });

    // The outcome belongs to the session that started the approve — never to whatever is on screen.
    it("keys the outcome to the approving session, not another one", async () => {
      const s1 = pendingSid;
      epicDrafts.upsert(draft(nextSid(), "draft")); // an unrelated session sitting in `draft`
      await approveEpic(s1);

      // s2 must not be told its (never-attempted) approve failed.
      expect(text()).not.toContain(m.epicdraft_approve_failed());
      expect(toasts.items).toHaveLength(1);
      expect(toasts.items[0]!.key).toBe(`epicdraft-approve-${s1}`);

      epicDrafts.upsert(draft(s1, "approved"));

      expect(last()).toBe(m.epicdraft_approve_success({ n: 13 }));
    });
  });
});
