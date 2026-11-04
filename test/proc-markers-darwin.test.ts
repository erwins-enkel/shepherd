import { expect, test } from "bun:test";
import { parseProcArgsMarker, collectDarwinMarkers } from "../src/proc-markers-darwin-core";
import { makeDarwinMarkerScanner } from "../src/proc-markers-darwin";

function args(argv: string[], env: string[]) {
  const argc = Buffer.alloc(4);
  argc.writeInt32LE(argv.length);
  return Buffer.concat([
    argc,
    Buffer.from(`/bin/test\0\0${argv.join("\0")}\0${env.join("\0")}\0\0`),
  ]);
}

test("procargs marker prefers the environment and reads exact keys only", () => {
  expect(
    parseProcArgsMarker(
      args(["test", "", "SHEPHERD_HEAVY_JOB=fake"], ["A=1", "SHEPHERD_HEAVY_JOB=real"]),
    ),
  ).toBe("real");
  expect(parseProcArgsMarker(args(["SHEPHERD_HEAVY_JOB=x", "test"], ["A=1"]))).toBeNull();
  expect(parseProcArgsMarker(args(["test"], ["XSHEPHERD_HEAVY_JOB=fake"]))).toBeNull();
  for (const bad of [Buffer.alloc(0), Buffer.alloc(4, 255), args(["test"], [])]) {
    expect(parseProcArgsMarker(bad)).toBeNull();
  }
  // A truncated block still yields the marker read before the cut.
  expect(parseProcArgsMarker(args(["test"], ["SHEPHERD_HEAVY_JOB=j", "A=1"]).subarray(0, -3))).toBe(
    "j",
  );
});

test("procargs counts a marker an empty argv[0] shifted into the last argument", () => {
  expect(parseProcArgsMarker(args(["", "worker"], ["SHEPHERD_HEAVY_JOB=j", "A=1"]))).toBe("j");
});

test("Darwin collection skips foreign UIDs, zombies and unreadable processes (#3631)", () => {
  const seen: number[] = [];
  const read = (pid: number) => {
    seen.push(pid);
    if (pid === 4) return null; // SIP-protected or vanished: skipped, never "unknown"
    if (pid === 6) return args(["test"], []); // redacted environment
    return args(["test"], [`SHEPHERD_HEAVY_JOB=${pid === 5 ? "other" : "j"}`]);
  };
  const result = collectDarwinMarkers(
    "1 501 10 S\n2 502 99 S\n3 501 50 Z\n4 501 0 S\n5 501 2 S\n6 501 1 S\n7 501 5 S",
    501,
    new Set(["j"]),
    read,
  );
  expect(seen).toEqual([1, 4, 5, 6, 7]);
  expect(result).toEqual(new Map([["j", { count: 2, rssBytes: 15360 }]]));
  expect(collectDarwinMarkers("1 501 10 S", 501, new Set(["j"]), () => null)).toEqual(new Map());
});

test("Darwin collection is unknown only when the process table can't be read", () => {
  const read = () => args(["test"], ["SHEPHERD_HEAVY_JOB=j"]);
  expect(collectDarwinMarkers("", 501, new Set(["j"]), read)).toBeNull();
  expect(collectDarwinMarkers("garbage", 501, new Set(["j"]), read)).toBeNull();
  expect(collectDarwinMarkers("1 501 10 S\nbad row", 501, new Set(["j"]), read)).toBeNull();
});

test("Darwin scanner serializes requests; a failed or malformed answer is unknown", async () => {
  let active = 0;
  const calls: string[][] = [];
  const scan = makeDarwinMarkerScanner(async (ids) => {
    expect(++active).toBe(1);
    calls.push(ids);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return JSON.stringify([[ids[0], { count: 1, rssBytes: 10 }]]);
  });
  const results = await Promise.all([scan(new Set(["a"])), scan(new Set(["b"]))]);
  expect(calls).toEqual([["a"], ["b"]]);
  expect(results[1]!.has("b")).toBe(true);
  expect(await makeDarwinMarkerScanner(async () => "[]")(new Set(["a"]))).toEqual(new Map());
  expect(await makeDarwinMarkerScanner(async () => "null")(new Set(["a"]))).toBeNull();
  for (const text of [
    "",
    "{}",
    '[["a",{"count":-1,"rssBytes":0}]]',
    '[["z",{"count":1,"rssBytes":0}]]',
  ]) {
    expect(await makeDarwinMarkerScanner(async () => text)(new Set(["a"]))).toBeNull();
  }
  expect(
    await makeDarwinMarkerScanner(async () => {
      throw new Error("timeout");
    })(new Set(["a"])),
  ).toBeNull();
});
