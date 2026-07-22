import { expect, test, describe } from "bun:test";
import {
  tolerantParseJson,
  isSpawnWorking,
  isSpawnAlive,
  decideVerdictAction,
} from "../src/json-tolerant";
import type { VerdictRead } from "../src/json-tolerant";

describe("tolerantParseJson", () => {
  test("strict-valid JSON parses with repaired=false", () => {
    const r = tolerantParseJson('{"a":1,"b":"x"}');
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error("unreachable");
    expect(r.repaired).toBe(false);
    expect(r.value).toEqual({ a: 1, b: "x" });
  });

  test("recovers an unescaped inner double-quote with repaired=true, content intact", () => {
    // The #822 failure class: a bare `"` inside a string value.
    const malformed = '{"body":"clicking "Open for merge" now","n":1}';
    expect(() => JSON.parse(malformed)).toThrow(); // pre-condition: strict rejects it
    const r = tolerantParseJson(malformed);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error("unreachable");
    expect(r.repaired).toBe(true);
    const v = r.value as { body: string; n: number };
    expect(v.n).toBe(1);
    // content fidelity: the inner-quoted phrase survives verbatim (not truncated/mangled).
    expect(v.body).toContain('"Open for merge"');
  });

  test("recovers trailing commas with repaired=true", () => {
    const r = tolerantParseJson('{"a":1,"b":[1,2,],}');
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error("unreachable");
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ a: 1, b: [1, 2] });
  });

  test("structurally broken / empty input → unparseable", () => {
    // jsonrepair throws on truncated-empty structures (no value to recover).
    for (const s of ["", "   ", "}{"]) {
      expect(tolerantParseJson(s).status).toBe("unparseable");
    }
  });

  test("bare non-JSON text coerces to a string (rejected downstream by shape validation)", () => {
    // jsonrepair is aggressive: bare text becomes a JSON string. tolerantParseJson reports `ok`,
    // but the value is a string, not the {verdict,...} object the readers require — so
    // parseRecapVerdict / critic shape validation fail closed on it. Documented, not a recovery.
    const r = tolerantParseJson("this is not json at all");
    expect(r.status).toBe("ok");
    if (r.status !== "ok") throw new Error("unreachable");
    expect(typeof r.value).toBe("string");
  });
});

describe("isSpawnWorking", () => {
  const at = (cwd: string, agentStatus: string) => ({ cwd, agentStatus });

  test("agent at cwd is 'working' → true (keep waiting)", () => {
    expect(isSpawnWorking([at("/x", "working")], "/x")).toBe(true);
  });

  test("agent at cwd is idle/done/blocked/unknown → false (finished)", () => {
    for (const s of ["idle", "done", "blocked", "unknown"]) {
      expect(isSpawnWorking([at("/x", s)], "/x")).toBe(false);
    }
  });

  test("no agent at cwd (gone) → false (finished)", () => {
    expect(isSpawnWorking([at("/other", "working")], "/x")).toBe(false);
    expect(isSpawnWorking([], "/x")).toBe(false);
  });
});

describe("decideVerdictAction", () => {
  const parsed = (repaired: boolean): VerdictRead<unknown> => ({
    status: "parsed",
    value: {},
    repaired,
  });
  const unparseable: VerdictRead<unknown> = { status: "unparseable" };
  const absent: VerdictRead<unknown> = { status: "absent" };

  test("strict parse → finalize-value regardless of spawn/timeout state", () => {
    expect(decideVerdictAction(parsed(false), false, false)).toBe("finalize-value");
    expect(decideVerdictAction(parsed(false), true, false)).toBe("finalize-value");
  });

  test("repaired → finalize-value only when finished or timed out, else wait", () => {
    expect(decideVerdictAction(parsed(true), false, false)).toBe("wait");
    expect(decideVerdictAction(parsed(true), true, false)).toBe("finalize-value"); // finished
    expect(decideVerdictAction(parsed(true), false, true)).toBe("finalize-value"); // timed out
  });

  test("unparseable → finalize-null (fail fast) only when finished or timed out, else wait", () => {
    expect(decideVerdictAction(unparseable, false, false)).toBe("wait");
    expect(decideVerdictAction(unparseable, true, false)).toBe("finalize-null"); // fail fast
    expect(decideVerdictAction(unparseable, false, true)).toBe("finalize-null"); // timeout
  });

  test("absent → wait while the spawn is still working, regardless of grace", () => {
    expect(decideVerdictAction(absent, false, false)).toBe("wait");
    expect(decideVerdictAction(absent, false, false, true)).toBe("wait"); // grace up but still working
    expect(decideVerdictAction(absent, false, true)).toBe("finalize-null"); // only the hard timeout
  });

  test("absent → fail-fast once the spawn has finished AND the startup grace elapsed", () => {
    // A critic/recap that exits without ever writing a verdict (e.g. died at startup — no usable
    // account) used to sit "working" in the UI for the full hard timeout. Once the spawn is
    // genuinely finished and past the boot grace, finalize it now rather than waiting it out.
    expect(decideVerdictAction(absent, true, false, true)).toBe("finalize-null");
    // ...but NOT during the boot grace: a slow-booting agent reads as not-yet-working before its
    // first turn, and the verdict is legitimately absent then — don't kill it prematurely.
    expect(decideVerdictAction(absent, true, false, false)).toBe("wait");
    // Back-compat: callers that omit the grace flag keep the pre-grace "wait until timeout" behavior.
    expect(decideVerdictAction(absent, true, false)).toBe("wait");
  });
});

// ── isSpawnAlive ─────────────────────────────────────────────────────────────
// Ground-truth process-liveness helper: uses paneForegroundProcs to determine whether a
// verdict spawn is actually alive, rather than relying on the transient agentStatus signal.

/** Minimal herdr shape that isSpawnAlive accepts. */
function makeHerdrStub(opts: {
  agents?: { cwd: string; paneId: string; agentStatus: string }[];
  procs?: string[] | Error;
  listThrows?: boolean;
}): {
  list: () => { cwd: string; paneId: string; agentStatus: string }[];
  paneForegroundProcs: () => Promise<string[]>;
} {
  return {
    list: () => {
      if (opts.listThrows) throw new Error("herdr unavailable");
      return opts.agents ?? [];
    },
    paneForegroundProcs: async () => {
      if (opts.procs instanceof Error) throw opts.procs;
      return opts.procs ?? [];
    },
  };
}

describe("isSpawnAlive", () => {
  const CWD = "/review-wt";
  const agent = (agentStatus: string) => ({ cwd: CWD, paneId: "p1", agentStatus });

  test("agentStatus=working → alive (fast path, no paneForegroundProcs call)", async () => {
    let procsCalled = false;
    const herdr = {
      list: () => [agent("working")],
      paneForegroundProcs: async () => {
        procsCalled = true;
        return ["zsh"];
      },
    };
    expect(await isSpawnAlive(herdr, CWD)).toBe(true);
    expect(procsCalled).toBe(false); // fast path skips the process-info call
  });

  test("idle + non-shell procs ['claude','node-MainThread'] → alive", async () => {
    const herdr = makeHerdrStub({ agents: [agent("idle")], procs: ["claude", "node-MainThread"] });
    expect(await isSpawnAlive(herdr, CWD)).toBe(true);
  });

  test("idle + non-shell procs ['claude','bash'] (critic mid-Bash) → alive", async () => {
    const herdr = makeHerdrStub({ agents: [agent("idle")], procs: ["claude", "bash"] });
    expect(await isSpawnAlive(herdr, CWD)).toBe(true);
  });

  test("idle + shell-only ['zsh'] (husk, startup-death shape) → dead", async () => {
    const herdr = makeHerdrStub({ agents: [agent("idle")], procs: ["zsh"] });
    expect(await isSpawnAlive(herdr, CWD)).toBe(false);
  });

  test("idle + sandboxed foreground ['bwrap'] (live membrane pane) → alive (#1891)", async () => {
    // A sandboxed agent's pane foreground is the `bwrap` monitor, not `claude`. The non-shell rule
    // correctly reads it alive; a dead sandbox falls back to a bare shell ('zsh' above) → dead.
    const herdr = makeHerdrStub({ agents: [agent("idle")], procs: ["bwrap"] });
    expect(await isSpawnAlive(herdr, CWD)).toBe(true);
  });

  test("idle + empty procs [] (undeterminable) → alive (fail-closed)", async () => {
    const herdr = makeHerdrStub({ agents: [agent("idle")], procs: [] });
    expect(await isSpawnAlive(herdr, CWD)).toBe(true);
  });

  test("paneForegroundProcs throws → alive (fail-closed, never reap on read error)", async () => {
    const herdr = makeHerdrStub({ agents: [agent("idle")], procs: new Error("ECONNREFUSED") });
    expect(await isSpawnAlive(herdr, CWD)).toBe(true);
  });

  test("list() throws → alive (fail-closed, helper does not propagate)", async () => {
    const herdr = makeHerdrStub({ listThrows: true });
    expect(await isSpawnAlive(herdr, CWD)).toBe(true);
  });

  test("cwd absent from list → dead", async () => {
    const herdr = makeHerdrStub({
      agents: [{ cwd: "/other-wt", paneId: "p2", agentStatus: "working" }],
    });
    expect(await isSpawnAlive(herdr, CWD)).toBe(false);
  });

  test("empty list (no agents) → dead", async () => {
    const herdr = makeHerdrStub({ agents: [] });
    expect(await isSpawnAlive(herdr, CWD)).toBe(false);
  });
});
