import { test, expect } from "bun:test";
import {
  isAllowedMirrorHop,
  playwrightMirrorTokenSubject,
  playwrightUpstreamUrl,
  relayPlaywrightBuild,
} from "../src/playwright-mirror";

const CFT = "builds/cft/159.0.8154.6/linux64/chrome-headless-shell-linux64.zip";
const FF = "builds/firefox/1572/firefox-ubuntu-24.04.zip";
const GCS =
  "https://storage.googleapis.com/chrome-for-testing-public/159.0.8154.6/linux64/chrome-headless-shell-linux64.zip";

test("token subject is distinct from the bare session id", () => {
  expect(playwrightMirrorTokenSubject("abc")).toBe("playwright-mirror:abc");
});

test("playwrightUpstreamUrl maps cft and legacy shapes to cdn.playwright.dev", () => {
  expect(playwrightUpstreamUrl(CFT)).toBe(`https://cdn.playwright.dev/${CFT}`);
  expect(playwrightUpstreamUrl(FF)).toBe(
    `https://cdn.playwright.dev/dbazure/download/playwright/${FF}`,
  );
  expect(playwrightUpstreamUrl("builds/chromium/1255/chromium-headless-shell-linux.zip")).toBe(
    "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1255/chromium-headless-shell-linux.zip",
  );
});

test("playwrightUpstreamUrl rejects anything off-shape", () => {
  for (const p of [
    "",
    "builds/cft/159.0/linux64/chrome-linux64.zip",
    "builds/cft/159.0.8154.6/../x/chrome.zip",
    "builds/firefox/1572/../../x.zip",
    "builds/firefox/1572/..zip",
    "builds/firefox/abc/firefox.zip",
    "builds/firefox/1572/firefox.tar.gz",
    "builds/firefox/1572/sub/firefox.zip",
    "other/firefox/1572/firefox.zip",
    "builds/Firefox/1572/firefox.zip",
    `${FF}?x=1`,
  ]) {
    expect(playwrightUpstreamUrl(p)).toBeNull();
  }
});

test("isAllowedMirrorHop: only https on the three hosts with their prefixes", () => {
  expect(isAllowedMirrorHop(`https://cdn.playwright.dev/${CFT}`)).toBe(true);
  expect(isAllowedMirrorHop(GCS)).toBe(true);
  expect(
    isAllowedMirrorHop(
      `https://playwright.download.prss.microsoft.com/dbazure/download/playwright/${FF}`,
    ),
  ).toBe(true);
  for (const u of [
    "http://cdn.playwright.dev/x",
    "https://storage.googleapis.com/evil-bucket/x.zip",
    "https://storage.googleapis.com/chrome-for-testing-public/../evil/x.zip",
    "https://storage.googleapis.com/chrome-for-testing-publicx/x.zip",
    "https://playwright.download.prss.microsoft.com/other/x.zip",
    "https://evil.example/x.zip",
    "https://cdn.playwright.dev:8443/x",
    "https://user@cdn.playwright.dev/x",
    "not a url",
  ]) {
    expect(isAllowedMirrorHop(u)).toBe(false);
  }
});

type Call = { url: string; redirect?: RequestRedirect };
function fakeFetch(routes: Record<string, () => Response>, calls: Call[] = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, redirect: init?.redirect });
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return r();
  }) as typeof fetch;
}

test("relay follows the 307 to GCS and streams the body with headers", async () => {
  const calls: Call[] = [];
  const f = fakeFetch(
    {
      [`https://cdn.playwright.dev/${CFT}`]: () =>
        new Response(null, { status: 307, headers: { location: GCS } }),
      [GCS]: () =>
        new Response("ZIPBYTES", {
          status: 200,
          headers: { "content-type": "application/zip", "content-length": "8" },
        }),
    },
    calls,
  );
  const res = await relayPlaywrightBuild(CFT, f);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  expect(await res.text()).toBe("ZIPBYTES");
  expect(calls.map((c) => c.redirect)).toEqual(["manual", "manual"]);
});

test("relay: off-shape path → 404 without fetching", async () => {
  const calls: Call[] = [];
  const res = await relayPlaywrightBuild("builds/x/../y.zip", fakeFetch({}, calls));
  expect(res.status).toBe(404);
  expect(calls).toHaveLength(0);
});

test("relay: redirect off the allowlist → 502, never fetched", async () => {
  const calls: Call[] = [];
  const f = fakeFetch(
    {
      [`https://cdn.playwright.dev/${CFT}`]: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://storage.googleapis.com/evil/x.zip" },
        }),
    },
    calls,
  );
  expect((await relayPlaywrightBuild(CFT, f)).status).toBe(502);
  expect(calls).toHaveLength(1);
});

test("relay: relative redirect resolves against the current hop", async () => {
  const f = fakeFetch({
    [`https://cdn.playwright.dev/${CFT}`]: () =>
      new Response(null, { status: 307, headers: { location: "/builds/cft/other.zip" } }),
    "https://cdn.playwright.dev/builds/cft/other.zip": () => new Response("ok"),
  });
  expect(await (await relayPlaywrightBuild(CFT, f)).text()).toBe("ok");
});

test("relay: too many redirects → 502", async () => {
  const url = `https://cdn.playwright.dev/${CFT}`;
  const f = fakeFetch({
    [url]: () => new Response(null, { status: 307, headers: { location: url } }),
  });
  expect((await relayPlaywrightBuild(CFT, f)).status).toBe(502);
});

test("relay: upstream non-200 status passes through without body", async () => {
  const f = fakeFetch({
    [`https://cdn.playwright.dev/dbazure/download/playwright/${FF}`]: () =>
      new Response("secret-ish error body", { status: 404 }),
  });
  const res = await relayPlaywrightBuild(FF, f);
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("");
});

test("relay: fetch failure → 502", async () => {
  const f = (async () => {
    throw new Error("boom");
  }) as unknown as typeof fetch;
  expect((await relayPlaywrightBuild(FF, f)).status).toBe(502);
});

test("relay: header timeout aborts → 504", async () => {
  const f = ((_: unknown, init?: RequestInit) =>
    new Promise((_r, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  expect((await relayPlaywrightBuild(FF, f, { headerTimeoutMs: 20 })).status).toBe(504);
});
