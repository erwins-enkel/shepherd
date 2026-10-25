import { test, expect } from "bun:test";
import { resolveBunBin, resolveNodeBin } from "../src/node-bin";

const never = () => null;
const noExist = () => false;

test("override wins over everything (trimmed)", () => {
  expect(
    resolveNodeBin({
      override: "  /opt/node/bin/node  ",
      which: () => "/usr/bin/node",
      exists: () => true,
    }),
  ).toBe("/opt/node/bin/node");
});

test("blank/whitespace override is ignored", () => {
  expect(resolveNodeBin({ override: "   ", which: () => "/usr/bin/node" })).toBe("/usr/bin/node");
});

test("falls back to node on PATH when no override", () => {
  expect(resolveNodeBin({ override: null, which: () => "/home/u/.bun/bin/node" })).toBe(
    "/home/u/.bun/bin/node",
  );
});

test("probes the mise shims dir when node is not on PATH", () => {
  const home = "/home/u";
  const shim = `${home}/.local/share/mise/shims/node`;
  expect(resolveNodeBin({ which: never, home, exists: (p) => p === shim })).toBe(shim);
});

test("probes common bin dirs when neither PATH nor mise has it", () => {
  expect(
    resolveNodeBin({ which: never, home: "/home/u", exists: (p) => p === "/usr/bin/node" }),
  ).toBe("/usr/bin/node");
});

test("falls back to bare 'node' when nothing resolves", () => {
  expect(resolveNodeBin({ which: never, home: "/home/u", exists: noExist })).toBe("node");
});

// ── resolveBunBin (#3351) ─────────────────────────────────────────────────────

const ident = (p: string) => p;

test("bun: the server's own bun (execPath) wins, realpath'd", () => {
  expect(
    resolveBunBin({
      execPath: "/home/u/.bun/bin/bun",
      which: () => "/usr/bin/bun",
      realpath: (p) =>
        p === "/home/u/.bun/bin/bun" ? "/home/u/mise/installs/bun/1.4.4/bin/bun" : p,
    }),
  ).toBe("/home/u/mise/installs/bun/1.4.4/bin/bun");
});

test("bun: non-bun execPath falls back to the PATH bun", () => {
  expect(
    resolveBunBin({
      execPath: "/opt/shepherd/shepherd",
      which: () => "/usr/bin/bun",
      realpath: ident,
    }),
  ).toBe("/usr/bin/bun");
});

test("bun: a PATH shim resolving to mise is rejected", () => {
  expect(
    resolveBunBin({
      execPath: "/opt/shepherd/shepherd",
      which: () => "/home/u/.bun/bin/bun",
      realpath: () => "/usr/bin/mise",
    }),
  ).toBeNull();
});

test("bun: nothing resolves → null", () => {
  expect(resolveBunBin({ execPath: "/usr/bin/node", which: never, realpath: ident })).toBeNull();
});
