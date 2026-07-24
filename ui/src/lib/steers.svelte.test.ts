import { describe, it, expect, vi, beforeEach } from "vitest";
import { steers } from "./steers.svelte";
import type { Steer } from "./types";

beforeEach(() => {
  steers.list = [];
  steers.error = null;
  steers.loaded = false;
});

const steer = (id: string): Steer => ({
  id,
  label: id,
  text: `${id}-text`,
  inSteerBar: true,
  onIssues: false,
});

// Flush pending micro- and macro-tasks so the serial writer's drain loop can advance
// after a controlled fetch resolves/rejects (putSteers awaits fetch then r.json()).
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Install a fetch mock whose every call parks a deferred Response the test resolves/rejects
 *  by hand, capturing the PUT body — lets us drive out-of-order / failed writes deterministically. */
function deferredFetch() {
  const calls: {
    body: unknown;
    resolve: (data: unknown) => void;
    reject: (e: unknown) => void;
  }[] = [];
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "null");
    let resolve!: (data: unknown) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<Response>((res, rej) => {
      resolve = (data) => res(new Response(JSON.stringify(data), { status: 200 }));
      reject = rej;
    });
    calls.push({ body, resolve, reject });
    return p;
  }) as unknown as typeof fetch;
  return calls;
}

describe("steers store", () => {
  it("load() populates the list from GET /api/steers", async () => {
    const data = [{ id: "a", label: "x", text: "y", inSteerBar: true, onIssues: false }];
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(data), { status: 200 }),
    ) as unknown as typeof fetch;
    await steers.load();
    expect(steers.list).toEqual(data);
    expect(steers.loaded).toBe(true);
  });

  it("load() backfills surface scopes a pre-scopes backend omits (no vanishing)", async () => {
    // an older backend returns steers without inSteerBar/onIssues
    const legacy = [{ id: "a", label: "x", text: "y" }];
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(legacy), { status: 200 }),
    ) as unknown as typeof fetch;
    await steers.load();
    // defaults to a bar chip so it still renders somewhere
    expect(steers.list[0]!.inSteerBar).toBe(true);
    expect(steers.list[0]!.onIssues).toBe(false);
  });

  it("save() PUTs the list and adopts the normalized result", async () => {
    const normalized = [{ id: "srv", label: "a", text: "b", inSteerBar: true, onIssues: false }];
    const calls: { method?: string }[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { method?: string }) => {
      calls.push({ method: init?.method });
      return new Response(JSON.stringify(normalized), { status: 200 });
    }) as unknown as typeof fetch;
    await steers.save([{ id: "tmp", label: "a", text: "b", inSteerBar: true, onIssues: false }]);
    expect(calls[0]!.method).toBe("PUT");
    expect(steers.list).toEqual(normalized);
  });
});

describe("steers store serial writer", () => {
  it("serializes overlapping saves and never adopts a stale older response", async () => {
    const calls = deferredFetch();
    const A = [steer("A")];
    const B = [steer("B")];

    const pA = steers.save(A);
    const pB = steers.save(B); // enqueued while A is in flight → coalesced, no 2nd PUT yet
    expect(calls.length).toBe(1); // only one PUT in flight (serialized)
    expect(calls[0]!.body).toEqual(A);

    // resolve A (the OLDER write) after B was queued: it must NOT be adopted, and the
    // drain must go on to send B.
    calls[0]!.resolve(A);
    await flush();
    expect(steers.list).not.toEqual(A);
    expect(calls.length).toBe(2);
    expect(calls[1]!.body).toEqual(B);

    calls[1]!.resolve(B);
    await pA;
    await pB;
    expect(steers.list).toEqual(B); // converged to the newest payload
  });

  it("a failed older PUT does not block the queued newer payload, and reports no false success", async () => {
    const calls = deferredFetch();
    const A = [steer("A")];
    const B = [steer("B")];

    const pA = steers.save(A);
    const pB = steers.save(B);
    expect(calls.length).toBe(1);

    calls[0]!.reject(new Error("network")); // older PUT fails
    await flush();
    expect(calls.length).toBe(2); // newer payload still sent
    expect(calls[1]!.body).toEqual(B);
    expect(steers.list).not.toEqual(A);

    calls[1]!.resolve(B);
    await expect(pA).resolves.toBeUndefined(); // both settle on the drain's final success
    await expect(pB).resolves.toBeUndefined();
    expect(steers.list).toEqual(B);
    expect(steers.error).toBeNull(); // the adopted final write cleared the older error
  });

  it("rejects and surfaces the error when the only PUT fails, leaving the list unchanged", async () => {
    steers.list = [steer("keep")];
    globalThis.fetch = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    await expect(steers.save([steer("new")])).rejects.toThrow("boom");
    expect(steers.error).toBe("boom");
    expect(steers.list).toEqual([steer("keep")]);
  });
});
