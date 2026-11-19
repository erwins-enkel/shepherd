import { describe, expect, test } from "bun:test";
import { type Result, err, ok } from "../src/result";

function half(n: number): Result<number> {
  return n % 2 === 0 ? ok(n / 2) : err(`${n} is odd`);
}

describe("result", () => {
  test("ok wraps a value", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
    expect(ok(null)).toEqual({ ok: true, value: null });
  });

  test("err wraps a string error by default", () => {
    expect(err("boom")).toEqual({ ok: false, error: "boom" });
  });

  test("err carries a custom error type", () => {
    const r: Result<number, { code: number }> = err({ code: 7 });
    expect(r).toEqual({ ok: false, error: { code: 7 } });
  });

  test("narrows on .ok", () => {
    const good = half(4);
    const bad = half(3);
    if (!good.ok || bad.ok) throw new Error("unexpected branch");
    expect(good.value).toBe(2);
    expect(bad.error).toBe("3 is odd");
  });
});
