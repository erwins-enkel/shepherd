import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadForgeMap } from "../../src/forge/load-config";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shep-forges-"));
  path = join(dir, "forges.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("loadForgeMap: missing file → empty map (no throw)", () => {
  expect(loadForgeMap(join(dir, "nope.json"))).toEqual({});
});

test("loadForgeMap: valid file → parsed map", () => {
  writeFileSync(
    path,
    JSON.stringify({ "git.example.com": { type: "gitea", baseUrl: "https://git.example.com" } }),
  );
  expect(loadForgeMap(path)).toEqual({
    "git.example.com": { type: "gitea", baseUrl: "https://git.example.com" },
  });
});

test("loadForgeMap: malformed JSON → empty map (no throw)", () => {
  writeFileSync(path, "{ not valid");
  expect(loadForgeMap(path)).toEqual({});
});

test("loadForgeMap: non-object JSON → empty map", () => {
  writeFileSync(path, "[1,2,3]");
  expect(loadForgeMap(path)).toEqual({});
});
