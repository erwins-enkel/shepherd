import { test, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { sessionIdFromLink, sessionIdFromLaunchUrl, onLaunchLink } from "./launch-link";

beforeEach(() => {
  vi.unstubAllGlobals();
});

test("sessionIdFromLink parses a session link", () => {
  expect(sessionIdFromLink("web+shepherd://session/abc")).toBe("abc");
  expect(sessionIdFromLink("web+shepherd://session/abc/")).toBe("abc");
  expect(sessionIdFromLink("WEB+Shepherd://session/abc")).toBe("abc");
  expect(sessionIdFromLink("web+shepherd://session/a%20b")).toBe("a b");
});

test("sessionIdFromLink rejects anything else", () => {
  for (const bad of [
    null,
    "",
    "web+shepherd://session/",
    "web+shepherd://other/abc",
    "web+shepherd://session/a/b",
    "web+shepherd://session/abc?x=1",
    "https://session/abc",
    "web+shepherd://session/%E0",
  ]) {
    expect(sessionIdFromLink(bad)).toBeNull();
  }
});

test("sessionIdFromLaunchUrl reads the link query param", () => {
  expect(
    sessionIdFromLaunchUrl("https://h.ts.net/?link=web%2Bshepherd%3A%2F%2Fsession%2Fa%2520b"),
  ).toBe("a b");
  expect(sessionIdFromLaunchUrl("https://h.ts.net/")).toBeNull();
  expect(sessionIdFromLaunchUrl("not a url")).toBeNull();
});

test("onLaunchLink forwards parsed ids from the launch queue", () => {
  let consumer: ((p: { targetURL?: string }) => void) | undefined;
  vi.stubGlobal("window", { launchQueue: { setConsumer: (c: typeof consumer) => (consumer = c) } });
  const cb = vi.fn();
  onLaunchLink(cb);
  consumer!({ targetURL: "https://h/?link=web%2Bshepherd%3A%2F%2Fsession%2Fabc" });
  consumer!({ targetURL: "https://h/" });
  consumer!({});
  expect(cb.mock.calls).toEqual([["abc"]]);
});

test("onLaunchLink is a no-op without launchQueue", () => {
  vi.stubGlobal("window", {});
  expect(() => onLaunchLink(vi.fn())).not.toThrow();
});

test("manifest registers the web+shepherd handler and focus-existing launch", () => {
  const m = JSON.parse(readFileSync("static/manifest.webmanifest", "utf8"));
  expect(m.protocol_handlers).toEqual([{ protocol: "web+shepherd", url: "/?link=%s" }]);
  expect(m.launch_handler).toEqual({ client_mode: "focus-existing" });
});
