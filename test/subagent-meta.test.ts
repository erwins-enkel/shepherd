import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESCRIPTION_MAX, readSubagentDescription, subagentMetaPath } from "../src/subagent-meta";

let dir: string;
let transcript: string;
const writeMeta = (agentId: string, body: string) => {
  mkdirSync(join(dir, "sid", "subagents"), { recursive: true });
  writeFileSync(join(dir, "sid", "subagents", `agent-${agentId}.meta.json`), body);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subagent-meta-"));
  transcript = join(dir, "sid.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("reads the description from the agent's meta sidecar", async () => {
  writeMeta("a8f9cd", JSON.stringify({ agentType: "general-purpose", description: "Server side" }));
  expect(await readSubagentDescription(transcript, "a8f9cd")).toBe("Server side");
});

test("missing file, bad JSON, non-object or non-string description → undefined", async () => {
  expect(await readSubagentDescription(transcript, "nope")).toBeUndefined();
  writeMeta("bad", "{not json");
  expect(await readSubagentDescription(transcript, "bad")).toBeUndefined();
  writeMeta("arr", "[1]");
  expect(await readSubagentDescription(transcript, "arr")).toBeUndefined();
  writeMeta("num", JSON.stringify({ description: 42 }));
  expect(await readSubagentDescription(transcript, "num")).toBeUndefined();
  writeMeta("blank", JSON.stringify({ description: "  \n " }));
  expect(await readSubagentDescription(transcript, "blank")).toBeUndefined();
});

test("oversize sidecar is not read", async () => {
  writeMeta("big", JSON.stringify({ description: "x", pad: "y".repeat(10_000) }));
  expect(await readSubagentDescription(transcript, "big")).toBeUndefined();
});

test("traversal-shaped agent ids never build a path", async () => {
  for (const id of ["../x", "a/b", "", ".", "a".repeat(65)]) {
    expect(subagentMetaPath(transcript, id)).toBeNull();
    expect(await readSubagentDescription(transcript, id)).toBeUndefined();
  }
  expect(subagentMetaPath("/x/no-ext", "a1")).toBeNull();
});

test("strips control chars and caps the length", async () => {
  writeMeta("ctl", JSON.stringify({ description: "a\u001b[31mb‮c" }));
  expect(await readSubagentDescription(transcript, "ctl")).toBe("a [31mb c");
  writeMeta("long", JSON.stringify({ description: "z".repeat(500) }));
  const d = await readSubagentDescription(transcript, "long");
  expect(d).toBe(`${"z".repeat(DESCRIPTION_MAX)}…`);
});
