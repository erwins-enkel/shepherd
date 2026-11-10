/**
 * Contract for site/api/download-mac.ts — the Vercel Function behind
 * shepherd.run/download/mac. It reads the Mac app's Sparkle appcast and
 * 302-redirects to the newest build's DMG, or to the Mac release list when the
 * feed is unreachable, unparsable or names an unexpected URL.
 */

import { test, expect, afterEach, spyOn, type Mock } from "bun:test";
import { dmgUrlFromAppcast, GET, RELEASES_URL } from "../site/api/download-mac";

const RELEASE = "https://github.com/erwins-enkel/shepherd/releases/download";

function item(version: string, url: string): string {
  return `<item>
            <title>2.7.0-nightly.${version}</title>
            <sparkle:version>${version}</sparkle:version>
            <sparkle:shortVersionString>2.7.0-nightly.${version}</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
            <enclosure url="${url}" length="61303804" type="application/octet-stream" sparkle:edSignature="sig=="/>
        </item>`;
}

function feed(...items: string[]): string {
  return `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>Shepherd</title>
        ${items.join("\n        ")}
    </channel>
</rss>`;
}

// Verbatim shape of the live feed on the macos-update-feed branch.
const LIVE = feed(item("2674", `${RELEASE}/macos-nightly-2674/Shepherd-2674.zip`));

test("derives the DMG next to the newest build's update ZIP", () => {
  expect(dmgUrlFromAppcast(LIVE)).toBe(`${RELEASE}/macos-nightly-2674/Shepherd-2674.dmg`);
});

test("picks the highest sparkle:version when the feed lists several builds", () => {
  const xml = feed(
    item("2661", `${RELEASE}/macos-v2.7.0/Shepherd-2661.zip`),
    item("2674", `${RELEASE}/macos-nightly-2674/Shepherd-2674.zip`),
    item("2633", `${RELEASE}/macos-nightly-2633/Shepherd-2633.zip`),
  );
  expect(dmgUrlFromAppcast(xml)).toBe(`${RELEASE}/macos-nightly-2674/Shepherd-2674.dmg`);
});

test.each([
  [
    "a foreign host",
    "https://evil.example/erwins-enkel/shepherd/releases/download/macos-v2.7.0/Shepherd-2661.zip",
  ],
  [
    "another repo",
    "https://github.com/someone/shepherd/releases/download/macos-v2.7.0/Shepherd-2661.zip",
  ],
  ["a non-Mac release tag", `${RELEASE}/v2.7.0/Shepherd-2661.zip`],
  ["an unexpected asset name", `${RELEASE}/macos-v2.7.0/Other-2661.zip`],
  ["a query-string suffix", `${RELEASE}/macos-v2.7.0/Shepherd-2661.zip?x=https://evil.example`],
  [
    "plain http",
    "http://github.com/erwins-enkel/shepherd/releases/download/macos-v2.7.0/Shepherd-2661.zip",
  ],
])("rejects %s", (_label, url) => {
  expect(dmgUrlFromAppcast(feed(item("2661", url)))).toBeNull();
});

test("returns null when the feed has no usable item", () => {
  expect(dmgUrlFromAppcast(feed())).toBeNull();
  expect(dmgUrlFromAppcast("not xml at all")).toBeNull();
  const noEnclosure = `<item><sparkle:version>2674</sparkle:version></item>`;
  expect(dmgUrlFromAppcast(feed(noEnclosure))).toBeNull();
  const noVersion = `<item><enclosure url="${RELEASE}/macos-v2.7.0/Shepherd-2661.zip"/></item>`;
  expect(dmgUrlFromAppcast(feed(noVersion))).toBeNull();
});

const realFetch = globalThis.fetch;
let consoleError: Mock<typeof console.error> | undefined;
afterEach(() => {
  globalThis.fetch = realFetch;
  consoleError?.mockRestore();
  consoleError = undefined;
});

function stubFetch(impl: () => Promise<Response>) {
  globalThis.fetch = impl as unknown as typeof fetch;
  // The fallback path logs for Vercel's function logs; keep the test output quiet.
  consoleError = spyOn(console, "error").mockImplementation(() => {});
}

test("GET redirects to the newest DMG and lets the CDN cache it briefly", async () => {
  stubFetch(async () => new Response(LIVE, { status: 200 }));
  const res = await GET();
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`${RELEASE}/macos-nightly-2674/Shepherd-2674.dmg`);
  expect(res.headers.get("cache-control")).toBe(
    "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
  );
});

const FALLBACK_CACHE = "public, max-age=0, s-maxage=60";

test("GET falls back to the Mac release list when the feed answers non-OK", async () => {
  stubFetch(async () => new Response("nope", { status: 503 }));
  const res = await GET();
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(RELEASES_URL);
  expect(res.headers.get("cache-control")).toBe(FALLBACK_CACHE);
});

test("GET falls back to the Mac release list when the fetch throws", async () => {
  stubFetch(async () => {
    throw new Error("network down");
  });
  const res = await GET();
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(RELEASES_URL);
  expect(res.headers.get("cache-control")).toBe(FALLBACK_CACHE);
});

test("GET falls back to the Mac release list when the feed names an unexpected URL", async () => {
  stubFetch(
    async () => new Response(feed(item("1", "https://evil.example/x.zip")), { status: 200 }),
  );
  const res = await GET();
  expect(res.headers.get("location")).toBe(RELEASES_URL);
  expect(res.headers.get("cache-control")).toBe(FALLBACK_CACHE);
});
