/**
 * Tests for makeGhRunner (src/forge/github.ts) — the shared `gh` runner every GitHub forge
 * call goes through (#2656): REST/GraphQL limit recording, the REST read gate, and the
 * concurrency cap. The exec seam and both bucket trackers are injected, with a fake clock.
 */
import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { makeGhRunner } from "../../src/forge/github";
import { BucketRateLimit, isRateLimitError } from "../../src/forge/rate-limit";
import { classifyGhError } from "../../src/forge/gh-attempt";

const REST_403 = "gh: API rate limit exceeded for user ID 1. (HTTP 403)";

function ghError(stderr: string): Error {
  return Object.assign(new Error(`Command failed: gh …\n${stderr}`), { stderr });
}

function harness(
  opts: { maxConcurrent?: number; exec?: (args: string[]) => Promise<string> } = {},
) {
  let t = 0;
  const rest = new BucketRateLimit({
    now: () => t,
    label: "REST",
    defaultCooldownMs: 60_000,
    maxCooldownMs: 900_000,
  });
  const graph = new BucketRateLimit({ now: () => t });
  const execs: string[][] = [];
  let restDown = true;
  const exec =
    opts.exec ??
    (async (args: string[]) => {
      execs.push(args);
      if (args[0] === "api" && args[1] !== "graphql" && restDown) throw ghError(REST_403);
      return "{}";
    });
  const run = makeGhRunner({
    exec: async (args) => {
      if (opts.exec) execs.push(args);
      return exec(args);
    },
    rest,
    graph,
    maxConcurrent: opts.maxConcurrent,
  });
  return {
    run,
    rest,
    graph,
    execs,
    advance: (ms: number) => (t += ms),
    restUp: () => (restDown = false),
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
    // …and the write's success is positive evidence the bucket answers again.
    expect(h.rest.blocked()).toBe(false);

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
