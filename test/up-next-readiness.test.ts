import { test, expect, describe } from "bun:test";
import { ReadinessScorer, type ReadinessScorerDeps } from "../src/up-next-readiness";
import { SessionStore, type ReadinessRow } from "../src/store";
import { readinessHash } from "../src/up-next-readiness-core";
import type { Judge } from "../src/judge";
import type { UpNextItem } from "../src/up-next-core";

function item(n: number, over: Partial<UpNextItem> = {}): UpNextItem {
  const title = over.title ?? `t${n}`;
  return {
    repoPath: "/r/a",
    repoSlug: "o/a",
    repoLabel: "a",
    number: n,
    title,
    url: `https://x/${n}`,
    kind: "feature",
    priority: false,
    createdAt: n,
    labels: [],
    issueRef: { number: n, url: `https://x/${n}`, title, body: `body ${n}` },
    ...over,
  };
}

function memStore(seed: Record<string, number> = {}) {
  const rows = new Map<string, ReadinessRow>(
    Object.entries(seed).map(([hash, p]) => [hash, { hash, p, model: "m", scoredAt: 0 }]),
  );
  return {
    rows,
    getReadiness: (hashes: readonly string[]) => {
      const out = new Map<string, number>();
      for (const h of hashes) if (rows.has(h)) out.set(h, rows.get(h)!.p);
      return out;
    },
    putReadiness: (row: ReadinessRow) => void rows.set(row.hash, row),
  };
}

/** A judge that answers `p` (or whatever `answer` returns) and counts calls. */
function stubJudge(answer: (state: string) => unknown = () => ({ type: "noul", p: 0.8 })) {
  const calls: string[] = [];
  const judge = {
    ask: async (state: unknown) => {
      calls.push(String(state));
      const a = answer(String(state));
      if (a instanceof Error) throw a;
      return {
        answers: { ready: a },
        model: "m",
        usage: { inputTokens: 1, outputTokens: 0 },
        costUsd: 0.001,
      };
    },
  } as unknown as Judge;
  return { judge, calls };
}

function scorer(over: Partial<ReadinessScorerDeps> & { judge?: () => Judge | null } = {}) {
  const store = memStore();
  const warns: string[] = [];
  const s = new ReadinessScorer({
    judge: () => stubJudge().judge,
    model: () => "m",
    store,
    now: () => 42,
    warn: (m) => void warns.push(m),
    ...over,
  });
  return { s, store: (over.store as ReturnType<typeof memStore>) ?? store, warns };
}

describe("ReadinessScorer.scoreMissing", () => {
  test("scores misses, stores p with model + scoredAt, and returns the count", async () => {
    const { judge, calls } = stubJudge();
    const { s, store } = scorer({ judge: () => judge });
    expect(await s.scoreMissing([item(1), item(2)])).toBe(2);
    expect(calls).toHaveLength(2);
    const h = readinessHash("m", { title: "t1", body: "body 1", labels: [] });
    expect(store.rows.get(h)).toEqual({ hash: h, p: 0.8, model: "m", scoredAt: 42 });
  });

  test("a cache hit costs no call", async () => {
    const { judge, calls } = stubJudge();
    const h = readinessHash("m", { title: "t1", body: "body 1", labels: [] });
    const { s } = scorer({ judge: () => judge, store: memStore({ [h]: 0.5 }) });
    expect(await s.scoreMissing([item(1)])).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("dedupes by hash (an identical issue twice is one call)", async () => {
    const { judge, calls } = stubJudge();
    const { s } = scorer({ judge: () => judge });
    // Different numbers/repos, same scored content → same hash.
    expect(
      await s.scoreMissing([
        item(1, { title: "x" }),
        item(2, { title: "x", issueRef: { number: 2, url: "u", title: "x", body: "body 1" } }),
      ]),
    ).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("an unarmed judge makes no call", async () => {
    const { s } = scorer({ judge: () => null });
    expect(await s.scoreMissing([item(1)])).toBe(0);
  });

  test("spend.allow() === false stops before any call", async () => {
    const { judge, calls } = stubJudge();
    let recorded = 0;
    const { s } = scorer({
      judge: () => judge,
      spend: { allow: () => false, record: () => void recorded++ },
    });
    expect(await s.scoreMissing([item(1), item(2)])).toBe(0);
    expect(calls).toHaveLength(0);
    expect(recorded).toBe(0);
  });

  test("records spend once per answered call — including an unusable answer", async () => {
    const { judge } = stubJudge((st) =>
      st.includes("t2") ? { type: "noul", p: 7 } : { type: "noul", p: 0.4 },
    );
    const costs: number[] = [];
    const { s, store } = scorer({
      judge: () => judge,
      spend: { allow: () => true, record: (c) => void costs.push(c) },
    });
    expect(await s.scoreMissing([item(1), item(2)])).toBe(1);
    expect(costs).toEqual([0.001, 0.001]);
    // The out-of-range answer is NOT cached, so the next refresh retries it.
    expect(store.rows.size).toBe(1);
  });

  test("a throwing judge returns 0, warns once, never throws", async () => {
    const { judge, calls } = stubJudge(() => new Error("503"));
    const { s, warns } = scorer({ judge: () => judge, concurrency: 1 });
    expect(await s.scoreMissing([item(1), item(2), item(3), item(4), item(5)])).toBe(0);
    expect(warns).toHaveLength(1);
    // A systemic failure stops the run rather than being retried for every item.
    expect(calls.length).toBeLessThan(5);
  });

  test("a throwing ledger read or store read is swallowed", async () => {
    const { s: s1 } = scorer({
      spend: {
        allow: () => {
          throw new Error("locked");
        },
        record: () => {},
      },
    });
    expect(await s1.scoreMissing([item(1)])).toBe(0);
    const { s: s2 } = scorer({
      store: {
        getReadiness: () => {
          throw new Error("locked");
        },
        putReadiness: () => {},
      } as unknown as ReturnType<typeof memStore>,
    });
    expect(await s2.scoreMissing([item(1)])).toBe(0);
    expect(s2.scoreLookup([item(1)])(item(1))).toBeNull();
  });

  test("a throwing spend.record does not lose the score", async () => {
    const { s, store } = scorer({
      spend: {
        allow: () => true,
        record: () => {
          throw new Error("disk");
        },
      },
    });
    expect(await s.scoreMissing([item(1)])).toBe(1);
    expect(store.rows.size).toBe(1);
  });

  test("respects maxPerRefresh and bounded concurrency", async () => {
    let live = 0;
    let peak = 0;
    const judge = {
      ask: async () => {
        peak = Math.max(peak, ++live);
        await new Promise((r) => setTimeout(r, 2));
        live--;
        return {
          answers: { ready: { type: "noul", p: 0.9 } },
          model: "m",
          usage: { inputTokens: 1, outputTokens: 0 },
          costUsd: 0,
        };
      },
    } as unknown as Judge;
    const { s } = scorer({ judge: () => judge, maxPerRefresh: 5, concurrency: 2 });
    const items = Array.from({ length: 12 }, (_, i) => item(i + 1));
    expect(await s.scoreMissing(items)).toBe(5);
    expect(peak).toBe(2);
    // The rest converge over later refreshes.
    expect(await s.scoreMissing(items)).toBe(5);
    expect(await s.scoreMissing(items)).toBe(2);
  });

  test("overlapping runs never ask about the same hash twice", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const judge = {
      ask: async () => {
        calls++;
        await gate;
        return {
          answers: { ready: { type: "noul", p: 0.9 } },
          model: "m",
          usage: { inputTokens: 1, outputTokens: 0 },
          costUsd: 0,
        };
      },
    } as unknown as Judge;
    const { s } = scorer({ judge: () => judge });
    const first = s.scoreMissing([item(1)]);
    const second = s.scoreMissing([item(1)]);
    release();
    expect(await first).toBe(1);
    expect(await second).toBe(0);
    expect(calls).toBe(1);
  });
});

describe("ReadinessScorer.scoreLookup", () => {
  test("maps items to cached p, null when unscored; hash is model-scoped", () => {
    const h1 = readinessHash("m", { title: "t1", body: "body 1", labels: [] });
    let model = "m";
    const { s } = scorer({ store: memStore({ [h1]: 0.7 }), model: () => model });
    const look = s.scoreLookup([item(1), item(2)]);
    expect(look(item(1))).toBe(0.7);
    expect(look(item(2))).toBeNull();
    model = "m2"; // a re-pin misses everything
    expect(s.scoreLookup([item(1)])(item(1))).toBeNull();
  });

  test("an epic row is scored on its child issueRef plus the parent's labels", () => {
    const epicRow = item(5, {
      kind: "epic",
      labels: ["Area/UI"],
      epicParent: { number: 100, title: "parent" },
      issueRef: { number: 5, url: "u", title: "child", body: "child body" },
    });
    const h = readinessHash("m", { title: "child", body: "child body", labels: ["area/ui"] });
    const { s } = scorer({ store: memStore({ [h]: 0.2 }) });
    expect(s.scoreLookup([epicRow])(epicRow)).toBe(0.2);
  });
});

describe("SessionStore readiness cache", () => {
  test("get/put/prune", () => {
    const st = new SessionStore(":memory:");
    expect(st.getReadiness([]).size).toBe(0);
    st.putReadiness({ hash: "a", p: 0.1, model: "m", scoredAt: 100 });
    st.putReadiness({ hash: "b", p: 0.9, model: "m", scoredAt: 200 });
    st.putReadiness({ hash: "a", p: 0.3, model: "m", scoredAt: 300 }); // upsert
    expect([...st.getReadiness(["a", "b", "c"])].sort()).toEqual([
      ["a", 0.3],
      ["b", 0.9],
    ]);
    expect(st.pruneReadiness(200)).toBe(0); // strictly older, not equal
    expect(st.pruneReadiness(201)).toBe(1);
    expect([...st.getReadiness(["a", "b"]).keys()]).toEqual(["a"]);
  });

  test("chunks a large IN list", () => {
    const st = new SessionStore(":memory:");
    const hashes = Array.from({ length: 1234 }, (_, i) => `h${i}`);
    for (const h of hashes) st.putReadiness({ hash: h, p: 0.5, model: "m", scoredAt: 1 });
    expect(st.getReadiness(hashes).size).toBe(1234);
  });
});
