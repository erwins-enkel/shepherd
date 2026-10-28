import { describe, it, expect } from "vitest";
import { pendingAskEntries, groupAsksByRepo } from "./ask-center";
import type { BlockReason, PendingAsk, Session } from "./types";

const sess = (id: string, repoPath = "/r/a", extra: Partial<Session> = {}): Session =>
  ({ id, desig: id, name: id, repoPath, status: "blocked", ...extra }) as Session;
const ask = (toolUseId: string): PendingAsk => ({ toolUseId, questions: [] });
const reason = (a?: PendingAsk): BlockReason => ({ shape: "menu", options: [], tail: [], ask: a });

describe("pendingAskEntries", () => {
  it("lists only sessions whose block carries an ask, oldest question first", () => {
    const sessions = [sess("a"), sess("b"), sess("c")];
    const blocks = {
      a: { reason: reason(ask("t-a")), since: 300 },
      b: { reason: reason(), since: 100 },
      c: { reason: reason(ask("t-c")), since: 200 },
    };
    const out = pendingAskEntries(sessions, blocks);
    expect(out.map((e) => e.session.id)).toEqual(["c", "a"]);
    expect(out[0]).toMatchObject({ ask: { toolUseId: "t-c" }, since: 200 });
  });

  it("skips mirrored sessions and assistants, which can't be answered from here", () => {
    const host = { instanceId: "i", name: "macbook", platform: "darwin" };
    const sessions = [
      sess("mirror", "/r/a", { host }),
      sess("op", "/r/a", { operatorAssistant: true }),
      sess("repo-asst", "/r/a", { assistantRepo: "/r/a" }),
      sess("local"),
    ];
    const blocks = Object.fromEntries(
      sessions.map((s) => [s.id, { reason: reason(ask(`t-${s.id}`)), since: 1 }]),
    );
    expect(pendingAskEntries(sessions, blocks).map((e) => e.session.id)).toEqual(["local"]);
  });
});

describe("groupAsksByRepo", () => {
  const entries = [
    { session: sess("a1", "/r/a"), ask: ask("1") },
    { session: sess("b1", "/r/b"), ask: ask("2") },
    { session: sess("a2", "/r/a"), ask: ask("3") },
    { session: sess("c1", "/r/c"), ask: ask("4") },
  ];

  it("groups by repo in first-seen order, keeping each group's entry order", () => {
    const groups = groupAsksByRepo(entries);
    expect(groups.map((g) => g.repoPath)).toEqual(["/r/a", "/r/b", "/r/c"]);
    expect(groups[0]!.entries.map((e) => e.session.id)).toEqual(["a1", "a2"]);
  });

  it("puts the focused repo first", () => {
    expect(groupAsksByRepo(entries, "/r/c").map((g) => g.repoPath)).toEqual([
      "/r/c",
      "/r/a",
      "/r/b",
    ]);
  });
});

it("keeps all requests of a session without duplicating the compatibility ask", () => {
  const a = ask("first"),
    b = ask("second");
  expect(
    pendingAskEntries([sess("s")], { s: { reason: { ...reason(a), asks: [a, b] }, since: 1 } }).map(
      (e) => e.ask.toolUseId,
    ),
  ).toEqual(["first", "second"]);
});
