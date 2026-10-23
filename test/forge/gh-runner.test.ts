/**
 * Tests for makeGhRunner (src/forge/github.ts) — the shared `gh` runner every GitHub forge
 * call goes through (#2656): GraphQL / REST read / REST write limit recording (#2805), the REST
 * read gate, the engagement logs, and the concurrency cap. The exec seam and all bucket trackers
 * are injected, with a fake clock.
 */
import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { makeGhRunner } from "../../src/forge/github";
import { BucketRateLimit, isGraphqlBucketCall, isRateLimitError } from "../../src/forge/rate-limit";
import { classifyGhError } from "../../src/forge/gh-attempt";
import { GraphqlSpendLedger } from "../../src/forge/github-spend";

const REST_403 = "gh: API rate limit exceeded for user ID 1. (HTTP 403)";

function ghError(stderr: string): Error {
  return Object.assign(new Error(`Command failed: gh …\n${stderr}`), { stderr });
}

function harness(
  opts: { maxConcurrent?: number; exec?: (args: string[]) => Promise<string> } = {},
) {
  let t = 0;
  const tracker = (label: string) =>
    new BucketRateLimit({ now: () => t, label, defaultCooldownMs: 60_000, maxCooldownMs: 900_000 });
  const rest = tracker("REST read");
  const restWrite = tracker("REST write");
  const graph = new BucketRateLimit({ now: () => t });
  const spend = new GraphqlSpendLedger({ now: () => t });
  const execs: string[][] = [];
  // GitHub limits REST reads and writes on separate counters (#2805): each can be down alone.
  let readDown = true;
  let writeDown = true;
  const exec =
    opts.exec ??
    (async (args: string[]) => {
      execs.push(args);
      const restCall = (args[0] === "api" && args[1] !== "graphql") || args[0] === "run";
      const write = args.includes("POST") || args[1] === "rerun";
      if (restCall && (write ? writeDown : readDown)) throw ghError(REST_403);
      return "{}";
    });
  const run = makeGhRunner({
    exec: async (args) => {
      if (opts.exec) execs.push(args);
      return exec(args);
    },
    rest,
    restWrite,
    graph,
    spend,
    maxConcurrent: opts.maxConcurrent,
  });
  return {
    run,
    rest,
    restWrite,
    graph,
    spend,
    execs,
    advance: (ms: number) => (t += ms),
    restUp: () => (readDown = writeDown = false),
    readsUp: () => (readDown = false),
    writesUp: () => (writeDown = false),
  };
}

describe("makeGhRunner — REST backoff (#2656)", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("after a REST 403, no REST read is spawned until the window has passed", async () => {
    const h = harness();
    const read = ["api", "--method", "GET", "repos/o/r/issues", "-f", "state=open"];

    await expect(h.run(read)).rejects.toThrow("API rate limit exceeded");
    expect(h.execs).toHaveLength(1);
    expect(h.rest.blocked()).toBe(true);

    // Inside the window: reads fail fast with a rate-limit error and never reach `gh`.
    const skipped = await h.run(read).catch((e: unknown) => e);
    expect(isRateLimitError(skipped)).toBe(true);
    await expect(h.run(["api", "repos/o/r/git/matching-refs/heads/epic/"])).rejects.toThrow();
    await expect(h.run(["run", "list", "--repo", "o/r"])).rejects.toThrow();
    expect(h.execs).toHaveLength(1);

    // Past the window: the next read is the probe and does reach `gh`.
    h.advance(60_000);
    h.restUp();
    await h.run(read);
    expect(h.execs).toHaveLength(2);
    expect(h.rest.blocked()).toBe(false);
  });

  it("writes and GraphQL calls still go through during a REST backoff", async () => {
    const h = harness();
    await h.run(["api", "repos/o/r"]).catch(() => {});
    expect(h.rest.blocked()).toBe(true);

    h.restUp();
    await h.run(["api", "--method", "POST", "repos/o/r/git/refs", "-f", "ref=refs/heads/x"]);
    expect(h.execs).toHaveLength(2);
    // …but a write's success says nothing about the read counter (#2805): reads stay gated.
    expect(h.rest.blocked()).toBe(true);

    await h.run(["api", "graphql", "-f", "query=query{viewer{login}}"]);
    await h.run(["issue", "list", "--repo", "o/r"]);
    expect(h.execs).toHaveLength(4);
  });

  it("the skipped call's error reads as a rate limit in the operator-facing trail", async () => {
    const h = harness();
    await h.run(["api", "repos/o/r"]).catch(() => {});
    const skipped = await h.run(["api", "repos/o/r"]).catch((e: unknown) => e);
    expect(classifyGhError("rest", skipped).reason).toBe("rate_limit");
  });

  it("a GraphQL rate-limit error engages the GraphQL tracker, not REST", async () => {
    const h = harness({
      exec: async (args) => {
        if (args[1] === "graphql") throw ghError("GraphQL: API rate limit already exceeded");
        return "{}";
      },
    });
    await h.run(["api", "graphql", "-f", "query=…"]).catch(() => {});
    expect(h.graph.blocked()).toBe(true);
    expect(h.rest.blocked()).toBe(false);
  });

  it("a non-rate-limit failure engages neither tracker", async () => {
    const h = harness({
      exec: async () => {
        throw ghError("GraphQL: Could not resolve to a Repository with the name 'o/r'.");
      },
    });
    await h.run(["issue", "list", "--repo", "o/r"]).catch(() => {});
    await h.run(["api", "repos/o/r"]).catch(() => {});
    expect(h.graph.blocked()).toBe(false);
    expect(h.rest.blocked()).toBe(false);
  });
});

describe("makeGhRunner — separate REST read and write trackers (#2805)", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  const read = ["api", "repos/o/r/issues"];
  const write = ["api", "--method", "POST", "repos/o/r/git/refs", "-f", "ref=refs/heads/secret-x"];

  it("a rate-limited write does not make the next read fail fast — the read runs gh", async () => {
    const h = harness();
    h.readsUp();
    await expect(h.run(write)).rejects.toThrow("API rate limit exceeded");
    expect(h.restWrite.blocked()).toBe(true);
    expect(h.rest.blocked()).toBe(false);

    expect(await h.run(read)).toBe("{}");
    expect(h.execs).toEqual([write, read]);
    // A read's success says nothing about the write counter.
    expect(h.restWrite.blocked()).toBe(true);
  });

  it("a rate-limited read still blocks later reads, and leaves the write tracker clear", async () => {
    const h = harness();
    await h.run(read).catch(() => {});
    const skipped = await h.run(read).catch((e: unknown) => e);
    expect(isRateLimitError(skipped)).toBe(true);
    expect(h.execs).toHaveLength(1);
    expect(h.rest.blocked()).toBe(true);
    expect(h.restWrite.blocked()).toBe(false);
  });

  it("the runner never gates a write: during a write backoff it still runs, and its success clears it", async () => {
    const h = harness();
    await h.run(["run", "rerun", "7", "--repo", "o/r", "--failed"]).catch(() => {});
    expect(h.restWrite.blocked()).toBe(true);

    h.writesUp();
    await h.run(write);
    expect(h.execs).toHaveLength(2);
    expect(h.restWrite.blocked()).toBe(false);
  });

  it("honours a Retry-After on the write tracker", async () => {
    const h = harness({
      exec: async () => {
        throw ghError(`${REST_403}\nRetry-After: 120`);
      },
    });
    await h.run(write).catch(() => {});
    expect(h.restWrite.snapshot().pausedUntil).toBe(120_000);
    expect(h.rest.blocked()).toBe(false);
  });

  it("logs each engagement once, naming the bucket, the call and the stderr line — never field values", async () => {
    const h = harness({
      exec: async () => {
        throw ghError(`\n  ${REST_403}  \n{"message":"API rate limit exceeded"}`);
      },
    });
    await h.run(write).catch(() => {});
    await h.run(write).catch(() => {}); // inside the window: no second log
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain("[rate-limit] REST write backoff engaged until");
    expect(msg).toContain(`— gh api POST repos/o/r/git/refs: ${REST_403}`);
    expect(msg).not.toContain("secret-x");
    expect(msg).not.toContain('{"message"');

    await h.run(["run", "list", "--repo", "o/r"]).catch(() => {});
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[1]?.[0])).toContain(
      `[rate-limit] REST read backoff engaged until 1970-01-01T00:01:00.000Z — gh run list: ${REST_403}`,
    );
  });
});

describe("makeGhRunner — concurrency cap (#2656)", () => {
  it("with many failing repos at once, concurrent gh processes never exceed the cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const h = harness({
      maxConcurrent: 4,
      exec: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        throw ghError("GraphQL: Could not resolve to a Repository with the name 'o/r'.");
      },
    });
    const calls = Array.from({ length: 20 }, (_, i) =>
      h.run(["issue", "list", "--repo", `o/r${i}`]).catch(() => null),
    );
    await Promise.all(calls);
    expect(h.execs).toHaveLength(20);
    expect(peak).toBe(4);
  });
});

describe("makeGhRunner — GraphQL spend (#2840)", () => {
  const RESET = "1970-01-01T01:00:00Z";
  const reading = (used: number, cost = 1, resetAt = RESET) =>
    JSON.stringify({
      data: { viewer: { login: "x" }, rateLimit: { cost, used, remaining: 5000 - used, resetAt } },
    });
  const rows = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ number: i })));
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  /** Runs the calls in order — each answering with its own output — then reads the split. */
  async function split(calls: Array<[string[], () => string]>) {
    const queue = calls.map(([, out]) => out);
    // A limit error's budget read (#2841) isn't one of the scripted calls; it fails here.
    const h = harness({
      exec: async (args) => {
        if (args.includes("query={rateLimit{remaining resetAt}}")) throw new Error("unscripted");
        return queue.shift()!();
      },
    });
    for (const [args] of calls) {
      await h.run(args).catch(() => undefined);
      h.advance(10_000);
    }
    return { h, split: h.spend.split() };
  }

  it("charges an own query its in-query cost and closes the interval with its reading", async () => {
    const q = [
      "api",
      "graphql",
      "-f",
      "query=query{viewer{login} rateLimit{cost used remaining resetAt}}",
    ];
    const { h, split: s } = await split([
      [q, () => reading(100)],
      [q, () => reading(150, 3)],
    ]);
    expect(s).toMatchObject({ ownPoints: 3, otherPoints: 47 });
    expect(h.graph.snapshot().remaining).toBe(4850);
  });

  it("charges porcelain calls by the measured table", async () => {
    const q = ["api", "graphql", "-f", "query=…"];
    const issues = ["issue", "list", "--repo", "o/r", "--json", "number,body", "--limit", "200"];
    const snapshot = [
      "pr",
      "list",
      "--repo",
      "o/r",
      "--json",
      "number,statusCheckRollup",
      "--limit",
      "20",
    ];
    const { split: s } = await split([
      [q, () => reading(100)],
      [issues, () => rows(40)],
      [snapshot, () => rows(3)],
      [q, () => reading(110)],
    ]);
    // 2 (issue list page of 100) + 1 (snapshot page of 20) + 1 (the closing query)
    expect(s).toMatchObject({ ownPoints: 4, otherPoints: 6 });
  });

  it("does not charge a rate-limited call or REST calls", async () => {
    const q = ["api", "graphql", "-f", "query=…"];
    const { split: s } = await split([
      [q, () => reading(100)],
      [
        ["pr", "view", "1"],
        () => {
          throw ghError("GraphQL: API rate limit exceeded");
        },
      ],
      [["api", "repos/o/r/pulls"], () => "[]"],
      [q, () => reading(101)],
    ]);
    expect(s).toMatchObject({ ownPoints: 1, otherPoints: 0 });
  });

  it("charges a failed GraphQL call GitHub answered, and reads its partial data", async () => {
    const q = ["api", "graphql", "-f", "query=…"];
    const partial = () => {
      throw Object.assign(new Error("exit 1"), { stdout: reading(120, 2), stderr: "NOT_FOUND" });
    };
    const { split: s } = await split([
      [q, () => reading(100)],
      [q, partial],
    ]);
    expect(s).toMatchObject({ ownPoints: 2, otherPoints: 18 });
  });

  it("a reading from another counter reaches neither the tracker nor the ledger", async () => {
    const q = ["api", "graphql", "-f", "query=…"];
    const { h, split: s } = await split([
      [q, () => reading(100)],
      [q, () => reading(158, 1, "1970-01-01T00:20:00Z")],
      [q, () => reading(110)],
    ]);
    expect(h.graph.snapshot()).toMatchObject({ remaining: 4890, resetAt: Date.parse(RESET) });
    // The ignored query still cost Shepherd its point.
    expect(s).toMatchObject({ ownPoints: 2, otherPoints: 8 });
  });
});

describe("makeGhRunner — GraphQL waits for the empty bucket's reset (#2841)", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  const MIN = 60_000;
  const PRIMARY = "GraphQL: API rate limit already exceeded for user ID 1.";
  const RESET_AT = 40 * MIN;
  const reading = (remaining: number, resetAt: number) =>
    `{"data":{"rateLimit":{"remaining":${remaining},"resetAt":"${new Date(resetAt).toISOString()}"}}}`;
  const isBudgetRead = (args: string[]) => args.some((a) => a.includes("{rateLimit{"));

  /** Every GraphQL call is refused with `stderr`; the budget read answers `budget()`. */
  function drained(stderr: string, budget: () => Promise<string>) {
    return harness({
      exec: async (args) => {
        if (isBudgetRead(args)) return budget();
        if (isGraphqlBucketCall(args)) throw ghError(stderr);
        return "{}";
      },
    });
  }

  it("reads the budget once and holds the backoff until just past resetAt", async () => {
    const h = drained(PRIMARY, async () => reading(0, RESET_AT));
    await expect(h.run(["issue", "list", "--repo", "o/r"])).rejects.toThrow("rate limit");
    expect(h.execs.filter(isBudgetRead)).toHaveLength(1);
    expect(h.graph.snapshot().pausedUntil).toBe(RESET_AT + 5_000);

    h.advance(RESET_AT + 4_000);
    expect(h.graph.blocked()).toBe(true);
    h.advance(2_000);
    expect(h.graph.blocked()).toBe(false);
  });

  it("a wave of refused calls shares one budget read and logs one engagement", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const h = drained(PRIMARY, async () => {
      await answered;
      return reading(0, RESET_AT);
    });
    const wave = [
      h.run(["issue", "list", "--repo", "o/r"]),
      h.run(["pr", "list", "--repo", "o/r"]),
      h.run(["api", "graphql", "-f", "query=query{viewer{login}}"]),
    ].map((p) => p.catch((e: unknown) => e));
    await Bun.sleep(0);
    answer();
    const errs = await Promise.all(wave);
    expect(errs.every((e) => isRateLimitError(e))).toBe(true);
    expect(h.execs.filter(isBudgetRead)).toHaveLength(1);

    // A call already in flight when the window opened fails inside it: no second read.
    await h.run(["issue", "view", "7", "--repo", "o/r"]).catch(() => {});
    expect(h.execs.filter(isBudgetRead)).toHaveLength(1);

    const engaged = warnSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l: string) => l.includes("engaged"));
    expect(engaged).toHaveLength(1);
    expect(engaged[0]).toContain(new Date(RESET_AT + 5_000).toISOString());
    expect(engaged[0]).toContain(`resets ${new Date(RESET_AT).toISOString()}`);
  });

  it("a reading with points left falls back to the cooldown", async () => {
    const h = drained(PRIMARY, async () => reading(3, RESET_AT));
    await h.run(["issue", "list", "--repo", "o/r"]).catch(() => {});
    expect(h.graph.snapshot().pausedUntil).toBe(MIN);
  });

  it("a resetAt more than an hour ahead falls back to the cooldown", async () => {
    const h = drained(PRIMARY, async () => reading(0, 61 * MIN));
    await h.run(["issue", "list", "--repo", "o/r"]).catch(() => {});
    expect(h.graph.snapshot().pausedUntil).toBe(MIN);
  });

  it("a failed budget read falls back to the cooldown and the call's own error is thrown", async () => {
    const h = drained(PRIMARY, async () => {
      throw ghError(PRIMARY);
    });
    await expect(h.run(["issue", "list", "--repo", "o/r"])).rejects.toThrow(PRIMARY);
    expect(h.graph.snapshot().pausedUntil).toBe(MIN);
  });

  it("a secondary limit keeps its own rule: Retry-After, no budget read", async () => {
    const h = drained("You have exceeded a secondary rate limit. Retry-After: 120", async () =>
      reading(0, RESET_AT),
    );
    await h.run(["issue", "list", "--repo", "o/r"]).catch(() => {});
    expect(h.execs.filter(isBudgetRead)).toHaveLength(0);
    expect(h.graph.snapshot().pausedUntil).toBe(120_000);
  });

  it("a secondary limit without Retry-After escalates, no budget read", async () => {
    const h = drained("You have exceeded a secondary rate limit.", async () =>
      reading(0, RESET_AT),
    );
    await h.run(["issue", "list", "--repo", "o/r"]).catch(() => {});
    expect(h.execs.filter(isBudgetRead)).toHaveLength(0);
    expect(h.graph.snapshot().pausedUntil).toBe(MIN);
  });
});
