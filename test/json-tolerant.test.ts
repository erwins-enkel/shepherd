import { expect, test, describe } from "bun:test";
import { tolerantParseJson, isSpawnWorking, decideVerdictAction } from "../src/json-tolerant";
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

  test("absent → wait unless timed out (NOT fail-fasted even when finished)", () => {
    expect(decideVerdictAction(absent, false, false)).toBe("wait");
    expect(decideVerdictAction(absent, true, false)).toBe("wait"); // finished but no fail-fast
    expect(decideVerdictAction(absent, false, true)).toBe("finalize-null"); // only the hard timeout
  });
});
