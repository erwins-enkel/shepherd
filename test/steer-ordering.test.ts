import { test, expect, describe } from "bun:test";
import { SessionService } from "../src/service";
import { SessionStore } from "../src/store";

/**
 * Ordering guarantees for the now-ASYNC steer path (issue #1567).
 *
 * A steer is two PTY writes — a bracketed paste, then a CR that submits it. When `herdr.send` was
 * synchronous these landed as an uninterruptible unit for free. Now that it is a promise, two
 * invariants must be asserted on ORDERING (when each send *starts*, relative to when the previous
 * one *resolves*), not merely on the argv each send received:
 *
 *  1. The CR is issued only after the paste send RESOLVES — a CR racing ahead of an in-flight
 *     paste submits an empty prompt and strands the pasted text on the next turn.
 *  2. Two concurrent steers to the same pane never interleave — `paste:A, paste:B, cr:A, cr:B`
 *     would submit a corrupted merge of both texts.
 *
 * Both are enforced by SessionService's steer serializer, so both are tested through the public
 * `reply()` boundary rather than by reaching into `sendSteerTo`.
 */

const PASTE_START = "\x1b[200~";

/** A steer harness whose `herdr.send` records a start/end event per call and can be held open,
 *  so a test can observe the exact interleaving of two round trips. */
function makeSvc() {
  const events: string[] = [];
  /** Resolvers for each in-flight send, keyed by the label we recorded for it. */
  const gates = new Map<string, () => void>();
  /** When set, a send matching this label parks until its gate is released. */
  let holdLabel: string | null = null;
  /** The steer whose paste went out most recently. A CR's payload is a bare "\r", so it carries no
   *  identity of its own — it belongs to the paste that preceded it. Under a hypothetical
   *  interleave the paste order alone still exposes it; this only keeps the trace readable. */
  let owner = "";

  const store = new SessionStore(":memory:");
  const svc = new SessionService({
    store,
    worktree: {},
    herdr: {
      send: async (_id: string, text: string) => {
        const isPaste = text.includes(PASTE_START);
        if (isPaste) owner = text.includes("A") ? ":A" : text.includes("B") ? ":B" : "";
        const tag = `${isPaste ? "paste" : "cr"}${owner}`;
        events.push(`${tag}:start`);
        if (holdLabel === tag) {
          await new Promise<void>((resolve) => gates.set(tag, resolve));
        }
        events.push(`${tag}:end`);
      },
      list: () => [{ terminalId: "t1", agentStatus: "idle" }],
    },
    namer: (p: string) => p,
  } as any);

  const s = store.create({
    name: "n",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "b",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t1",
  });

  return {
    svc,
    id: s.id,
    events,
    hold: (tag: string) => (holdLabel = tag),
    release: (tag: string) => gates.get(tag)!(),
  };
}

/** Let every already-queued microtask/timer callback run, so a CR that was going to race ahead
 *  has had every chance to. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("steer ordering (#1567)", () => {
  test("the CR send starts only AFTER the bracket-paste send resolves", async () => {
    const { svc, id, events, hold, release } = makeSvc();
    hold("paste"); // park the paste mid-flight

    const steer = svc.reply(id, "hello");
    await settle();

    // The paste is in flight and NOT yet resolved — the CR must not have been issued.
    expect(events).toEqual(["paste:start"]);

    release("paste");
    expect(await steer).toBe(true);

    expect(events).toEqual(["paste:start", "paste:end", "cr:start", "cr:end"]);
  });

  test("two concurrent steers to one pane do not interleave their paste/CR pairs", async () => {
    const { svc, id, events, hold, release } = makeSvc();
    hold("paste:A"); // hold steer A's paste open while steer B is submitted behind it

    const steerA = svc.reply(id, "A");
    await settle();
    const steerB = svc.reply(id, "B");
    await settle();

    // B must be queued behind A entirely — not slipped between A's paste and A's CR.
    expect(events).toEqual(["paste:A:start"]);

    release("paste:A");
    expect(await steerA).toBe(true);
    expect(await steerB).toBe(true);

    expect(events).toEqual([
      "paste:A:start",
      "paste:A:end",
      "cr:A:start",
      "cr:A:end",
      "paste:B:start",
      "paste:B:end",
      "cr:B:start",
      "cr:B:end",
    ]);
  });
});
