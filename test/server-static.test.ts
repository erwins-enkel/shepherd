import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp } from "../src/server";

const UI_BUILD = join(import.meta.dir, "..", "ui", "build");
const MANIFEST = join(UI_BUILD, "manifest.webmanifest");
const INDEX = join(UI_BUILD, "index.html");
const CHUNK_DIR = join(UI_BUILD, "_app", "immutable", "__static-test");
const CHUNK = join(CHUNK_DIR, "chunk.js");
const CHUNK_BODY = "export const x = 1;\n".repeat(200);
let createdDir = false;
let createdIndex = false;

beforeAll(() => {
  if (!existsSync(UI_BUILD)) {
    mkdirSync(UI_BUILD, { recursive: true });
    createdDir = true;
  }
  writeFileSync(MANIFEST, JSON.stringify({ name: "Shepherd" }));
  // Exclusive create ("wx"): never clobber a real build's index.html, and no check-then-write race.
  try {
    writeFileSync(INDEX, "<!doctype html><title>Shepherd</title>", { flag: "wx" });
    createdIndex = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  mkdirSync(CHUNK_DIR, { recursive: true });
  writeFileSync(CHUNK, CHUNK_BODY);
  writeFileSync(CHUNK + ".br", brotliCompressSync(CHUNK_BODY));
  writeFileSync(CHUNK + ".gz", gzipSync(CHUNK_BODY));
});

afterAll(() => {
  rmSync(MANIFEST, { force: true });
  rmSync(CHUNK_DIR, { recursive: true, force: true });
  if (createdIndex) rmSync(INDEX, { force: true });
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

const get = (path: string, headers: Record<string, string> = {}) =>
  app().fetch(new Request(`http://x${path}`, { headers }));

test("hashed chunks are cacheable forever", async () => {
  const res = await get("/_app/immutable/__static-test/chunk.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(res.headers.get("content-type")).toContain("javascript");
});

test("serves the brotli sibling when accepted, keeping the original content-type", async () => {
  const res = await get("/_app/immutable/__static-test/chunk.js", {
    "accept-encoding": "gzip, br",
  });
  expect(res.headers.get("content-encoding")).toBe("br");
  expect(res.headers.get("content-type")).toContain("javascript");
  expect(res.headers.get("vary")).toBe("Accept-Encoding");
  expect(Buffer.from(await res.arrayBuffer()).equals(brotliCompressSync(CHUNK_BODY))).toBe(true);
});

test("falls back to gzip, then identity", async () => {
  const gz = await get("/_app/immutable/__static-test/chunk.js", { "accept-encoding": "gzip" });
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  const plain = await get("/_app/immutable/__static-test/chunk.js");
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(await plain.text()).toBe(CHUNK_BODY);
});

test("index.html revalidates by ETag and answers 304", async () => {
  const first = await get("/");
  expect(first.headers.get("cache-control")).toBe("no-cache");
  const etag = first.headers.get("etag");
  expect(etag).toBeTruthy();
  const again = await get("/", { "if-none-match": etag! });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
});

test("a missing hashed chunk is a 404, not the SPA fallback", async () => {
  const res = await get("/_app/immutable/__static-test/gone.js");
  expect(res.status).toBe(404);
});

test("an unknown app route still gets index.html", async () => {
  const res = await get("/some/route");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
});
