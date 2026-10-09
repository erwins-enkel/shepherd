import { test, expect } from "bun:test";
import { bunMeetsFloor, checkBunVersion, devBunFloor } from "../scripts/check-bun-version";

test("devBunFloor: reads engines.bun", () => {
  expect(devBunFloor({ engines: { bun: ">=1.4.2" } })).toBe(">=1.4.2");
});

test("devBunFloor: throws without engines.bun", () => {
  expect(() => devBunFloor({})).toThrow(/engines\.bun/);
  expect(() => devBunFloor({ engines: {} })).toThrow(/engines\.bun/);
});

test("bunMeetsFloor: below, at and above the floor", () => {
  expect(bunMeetsFloor("1.3.10", ">=1.4.2")).toBe(false);
  expect(bunMeetsFloor("1.4.1", ">=1.4.2")).toBe(false);
  expect(bunMeetsFloor("1.4.2", ">=1.4.2")).toBe(true);
  expect(bunMeetsFloor("1.5.0", ">=1.4.2")).toBe(true);
});

test("bunMeetsFloor: prerelease/build suffixes compare by their release triple", () => {
  expect(bunMeetsFloor("1.4.3-canary.1+abc", ">=1.4.2")).toBe(true);
  expect(bunMeetsFloor("1.4.1-canary.9", ">=1.4.2")).toBe(false);
});

test("checkBunVersion: ok passes silently", () => {
  expect(checkBunVersion("1.4.2", ">=1.4.2")).toEqual({ ok: true, message: "" });
});

test("checkBunVersion: too old names version, floor and the fix", () => {
  const r = checkBunVersion("1.3.10", ">=1.4.2");
  expect(r.ok).toBe(false);
  expect(r.message).toContain("1.3.10");
  expect(r.message).toContain(">=1.4.2");
  expect(r.message).toContain("bun upgrade");
});
