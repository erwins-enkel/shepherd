import { describe, expect, test } from "bun:test";
import { EventHub } from "../src/events";
import { LOGIN_REQUEST_EVENT, LoginRequestService } from "../src/login-request";

function setup() {
  const events = new EventHub();
  const emitted: { id: string; request: unknown }[] = [];
  events.subscribe((event, data) => {
    if (event === LOGIN_REQUEST_EVENT) emitted.push(data as { id: string; request: unknown });
  });
  const svc = new LoginRequestService({ events, now: () => 1000 });
  return { events, emitted, svc };
}

function open(svc: LoginRequestService, url = "https://example.com/login") {
  const r = svc.request("s1", url, "need staging login");
  if (r.status !== "open") throw new Error("expected open");
  return r;
}

describe("LoginRequestService", () => {
  test("request opens one request and announces it", () => {
    const { svc, emitted } = setup();
    const r = open(svc);
    expect(r.created).toBe(true);
    expect(r.request).toMatchObject({
      url: "https://example.com/login",
      reason: "need staging login",
      createdAt: 1000,
    });
    expect(svc.get("s1")).toEqual(r.request);
    expect(svc.snapshot()).toEqual({ s1: r.request });
    expect(emitted).toEqual([{ id: "s1", request: r.request }]);
  });

  test("same url re-attaches without a new announcement", () => {
    const { svc, emitted } = setup();
    const first = open(svc);
    const again = open(svc);
    expect(again.created).toBe(false);
    expect(again.request.id).toBe(first.request.id);
    expect(emitted).toHaveLength(1);
  });

  test("a different url replaces the open request and cancels its waiters", async () => {
    const { svc } = setup();
    const first = open(svc);
    const waiting = svc.wait("s1", first.request.id, 10_000);
    const second = open(svc, "https://other.example/login");
    expect(second.created).toBe(true);
    expect(await waiting).toBe("cancelled");
    expect(svc.get("s1")?.id).toBe(second.request.id);
  });

  test("wait reports pending when the window runs out", async () => {
    const { svc } = setup();
    const r = open(svc);
    expect(await svc.wait("s1", r.request.id, 5)).toBe("pending");
    expect(svc.get("s1")).not.toBeNull();
  });

  test("resolve wakes the waiter and clears the request", async () => {
    const { svc, emitted } = setup();
    const r = open(svc);
    const waiting = svc.wait("s1", r.request.id, 10_000);
    expect(svc.resolve("s1", "done")).toBe(true);
    expect(await waiting).toBe("done");
    expect(svc.get("s1")).toBeNull();
    expect(emitted.at(-1)).toEqual({ id: "s1", request: null });
  });

  test("an outcome resolved between calls is delivered once to the next same-url call", () => {
    const { svc } = setup();
    open(svc);
    svc.resolve("s1", "cancelled");
    expect(svc.request("s1", "https://example.com/login", "x")).toEqual({ status: "cancelled" });
    // consumed: a later ask opens a fresh request
    expect(svc.request("s1", "https://example.com/login", "x").status).toBe("open");
  });

  test("an undelivered outcome does not answer a different url", () => {
    const { svc } = setup();
    open(svc);
    svc.resolve("s1", "done");
    expect(svc.request("s1", "https://other.example/", "x").status).toBe("open");
  });

  test("resolve without a request is false", () => {
    const { svc } = setup();
    expect(svc.resolve("s1", "done")).toBe(false);
  });

  test("abort ends the wait but keeps the request", async () => {
    const { svc } = setup();
    const r = open(svc);
    const ctl = new AbortController();
    const waiting = svc.wait("s1", r.request.id, 10_000, ctl.signal);
    ctl.abort();
    expect(await waiting).toBe("pending");
    expect(svc.get("s1")).not.toBeNull();
  });

  test("wait on a stale request id is cancelled", async () => {
    const { svc } = setup();
    open(svc);
    expect(await svc.wait("s1", "nope", 10_000)).toBe("cancelled");
  });

  test("archiving the session cancels and forgets it", async () => {
    const { svc, events } = setup();
    const r = open(svc);
    const waiting = svc.wait("s1", r.request.id, 10_000);
    events.emit("session:archived", { id: "s1" });
    expect(await waiting).toBe("cancelled");
    expect(svc.get("s1")).toBeNull();
    expect(svc.request("s1", "https://example.com/login", "x").status).toBe("open");
  });
});

test("wouldCreate mirrors whether request opens a new one", () => {
  const { svc } = setup();
  const url = "https://example.com/login";
  expect(svc.wouldCreate("s1", url)).toBe(true);
  open(svc, url);
  expect(svc.wouldCreate("s1", url)).toBe(false);
  expect(svc.wouldCreate("s1", "https://other.example/")).toBe(true);
  svc.resolve("s1", "done");
  expect(svc.wouldCreate("s1", url)).toBe(false);
  expect(svc.wouldCreate("s1", "https://other.example/")).toBe(true);
});
