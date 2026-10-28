import { expect, test } from "bun:test";
import {
  parseProcArgsMarker,
  collectDarwinMarkers,
  makeDarwinMarkerScanner,
} from "../src/proc-markers-darwin";

function args(argv: string[], env: string[]) {
  const argc = Buffer.alloc(4);
  argc.writeInt32LE(argv.length);
  return Buffer.concat([
    argc,
    Buffer.from(`/bin/test\0\0${argv.join("\0")}\0${env.join("\0")}\0\0`),
  ]);
}

test("procargs marker distinguishes environment from arguments and exact keys", () => {
  expect(
    parseProcArgsMarker(
      args(["test", "", "SHEPHERD_HEAVY_JOB=fake"], ["A=1", "SHEPHERD_HEAVY_JOB=real"]),
    ),
  ).toEqual({ marker: "real", complete: false });
  expect(
    parseProcArgsMarker(args(["test", "SHEPHERD_HEAVY_JOB=fake"], ["XSHEPHERD_HEAVY_JOB=fake"])),
  ).toEqual({ marker: null, complete: false });
  for (const bad of [
    Buffer.alloc(0),
    Buffer.alloc(4, 255),
    args(["test"], ["A=1"]).subarray(0, -3),
    args(["test"], []),
  ]) {
    expect(parseProcArgsMarker(bad).complete).toBe(false);
  }
});
test("Darwin collection filters UID, zombies and foreign markers and preserves partial evidence", () => {
  const seen: number[] = [];
  const read = (pid: number) => {
    seen.push(pid);
    if (pid === 4) return null;
    return args(["test"], [`SHEPHERD_HEAVY_JOB=${pid === 5 ? "other" : "j"}`]);
  };
  const result = collectDarwinMarkers(
    "1 501 10 S\n2 502 99 S\n3 501 50 Z\n4 501 0 S\n5 501 2 S",
    501,
    new Set(["j"]),
    read,
  );
  expect(seen).toEqual([1, 4, 5]);
  expect(result).toEqual({
    procs: new Map([["j", { count: 1, rssBytes: 10240 }]]),
    complete: false,
  });
  expect(collectDarwinMarkers("garbage", 501, new Set(["j"]), read).complete).toBe(false);
  expect(collectDarwinMarkers("1 501 10 S", 501, new Set(["j"]), () => "gone").complete).toBe(true);
});
test("Darwin scanner rejects malformed output and serializes distinct requests", async () => {
  let active = 0;
  const calls: string[][] = [];
  const scan = makeDarwinMarkerScanner(async (ids) => {
    expect(++active).toBe(1);
    calls.push(ids);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return JSON.stringify({ procs: [[ids[0], { count: 1, rssBytes: 10 }]], complete: true });
  });
  const results = await Promise.all([scan(new Set(["a"])), scan(new Set(["b"]))]);
  expect(calls).toEqual([["a"], ["b"]]);
  expect(results[1]!.procs.has("b")).toBe(true);
  for (const text of ["", "{}", '{"complete":true,"procs":[["a",{"count":-1,"rssBytes":0}]]}']) {
    expect((await makeDarwinMarkerScanner(async () => text)(new Set(["a"]))).complete).toBe(false);
  }
  expect(
    (
      await makeDarwinMarkerScanner(async () => {
        throw new Error("timeout");
      })(new Set(["a"]))
    ).complete,
  ).toBe(false);
});

test("procargs never proves absence when empty argv0 can shift a marker into arguments", () => {
  expect(parseProcArgsMarker(args(["", "worker"], ["SHEPHERD_HEAVY_JOB=j", "A=1"]))).toEqual({
    marker: null,
    complete: false,
  });
});
