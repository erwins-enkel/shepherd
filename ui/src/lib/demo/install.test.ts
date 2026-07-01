import { describe, it, expect, beforeAll } from "vitest";
import { installDemoBackend } from "./install";
import { EventsSocket } from "./events";
import { PtySocket } from "./pty/socket";
import { bus } from "./bus";
import type { WsEvent } from "$lib/types";

const tick = () => new Promise((r) => setTimeout(r, 0));

// wsUrl()/URL resolution in the real callers reads `location`; provide one for node.
beforeAll(() => {
  if (typeof globalThis.location === "undefined") {
    (globalThis as unknown as { location: unknown }).location = {
      protocol: "http:",
      host: "localhost",
      href: "http://localhost/",
    };
  }
  installDemoBackend();
});

describe("installDemoBackend — fetch", () => {
  it("resolves GET /api/me as 200 authenticated", async () => {
    const r = await fetch("/api/me");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  it("resolves an unmatched /api endpoint with a benign 200", async () => {
    const r = await fetch("/api/unknown");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    await expect(r.json()).resolves.toBeDefined();
  });

  it("resolves an unmatched mutation with { ok: true }", async () => {
    const r = await fetch("/api/anything", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(r.ok).toBe(true);
    await expect(r.json()).resolves.toEqual({ ok: true });
  });
});

describe("installDemoBackend — WebSocket", () => {
  it("routes /events to an EventsSocket and forwards bus frames to onmessage", async () => {
    const ws = new WebSocket("ws://host/events");
    expect(ws).toBeInstanceOf(EventsSocket);
    const frames: unknown[] = [];
    ws.onmessage = (e) => frames.push(e.data);
    await tick(); // open + subscribe
    const ev: WsEvent = { event: "session:ready", data: { id: "demo-1", ready: true } };
    bus.emit(ev);
    expect(frames).toContain(JSON.stringify(ev));
    ws.close();
  });

  it("routes /pty/:id to a PtySocket that opens", async () => {
    const ws = new WebSocket("ws://host/pty/abc?cols=80&rows=24");
    expect(ws).toBeInstanceOf(PtySocket);
    await tick();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("exposes static readyState constants on the patched WebSocket", () => {
    expect(WebSocket.CONNECTING).toBe(0);
    expect(WebSocket.OPEN).toBe(1);
    expect(WebSocket.CLOSING).toBe(2);
    expect(WebSocket.CLOSED).toBe(3);
  });
});
