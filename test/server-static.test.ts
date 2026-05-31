import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp } from "../src/server";

const UI_BUILD = join(import.meta.dir, "..", "ui", "build");
const MANIFEST = join(UI_BUILD, "manifest.webmanifest");
let createdDir = false;

beforeAll(() => {
  if (!existsSync(UI_BUILD)) {
    mkdirSync(UI_BUILD, { recursive: true });
    createdDir = true;
  }
  writeFileSync(MANIFEST, JSON.stringify({ name: "Shepherd" }));
});

afterAll(() => {
  rmSync(MANIFEST, { force: true });
  if (createdDir) rmSync(UI_BUILD, { recursive: true, force: true });
});

function app() {
  return makeApp({
    store: new SessionStore(":memory:"),
    events: new EventHub(),
    service: {} as any,
    usageLimits: { limits: () => ({}) } as any,
  });
}

test("serveStatic serves .webmanifest with manifest content-type", async () => {
  const res = await app().fetch(new Request("http://x/manifest.webmanifest"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("manifest");
});
