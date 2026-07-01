import { describe, it, expect, beforeAll } from "vitest";
import { installDemoBackend } from "./install";
import { HerdStore } from "$lib/store.svelte";
import { connectPty } from "$lib/pty";

const tick = () => new Promise((r) => setTimeout(r, 0));

// The real callers build ws URLs from `location`; provide one for node.
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

describe("demo transport ↔ real callers", () => {
  it("HerdStore.connect() flips connected true via the patched global WebSocket", async () => {
    const store = new HerdStore();
    const dispose = store.connect(); // default makeWs → global WebSocket (patched)
    expect(store.connected).toBe(false); // async open, not yet
    await tick();
    expect(store.connected).toBe(true);
    dispose();
  });

  it("connectPty() reaches OPEN and delivers the placeholder frame", async () => {
    let data = "";
    const conn = connectPty("demo-session", 80, 24, (bytes) => {
      data += bytes;
    });
    await tick();
    expect(data.length).toBeGreaterThan(0); // placeholder byte-string arrived after open
    conn.close();
  });
});
