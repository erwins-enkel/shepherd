import { describe, expect, it, mock } from "bun:test";
import { StatusPoller } from "../src/poller";
import type { SessionStore } from "../src/store";
import type { HerdrDriver, HerdrAgent } from "../src/herdr";

/** Minimal store fixture: `list()` returns no active sessions, which keeps tick()'s
 *  body trivial (no reconcile/reap/preview/liveness work) so the test isolates the
 *  herdr.listAsync() call + re-entrancy guard. `SessionStore` has private fields, so
 *  this is a structural fake cast through `unknown` (no explicit `any`). */
function fakeStore(): SessionStore {
  return { list: mock(() => []) } as unknown as SessionStore;
}

type FakeHerdr = Pick<HerdrDriver, "listAsync" | "read" | "readAsync" | "reportAgentState">;

function newPoller(herdr: FakeHerdr): StatusPoller {
  return new StatusPoller(
    fakeStore(),
    herdr,
    () => {},
    () => {},
  );
}

describe("StatusPoller.tick()", () => {
  it("calls herdr.listAsync() and never the sync herdr.list()", async () => {
    const listAsync = mock(() => Promise.resolve([] as HerdrAgent[]));
    const listSync = mock((): HerdrAgent[] => {
      throw new Error("tick() must not call the sync list()");
    });
    const herdr = {
      listAsync,
      list: listSync,
      read: mock(() => ""),
      readAsync: mock(() => Promise.resolve("")),
    } as unknown as FakeHerdr;
    const poller = newPoller(herdr);

    await poller.tick();

    expect(listAsync).toHaveBeenCalledTimes(1);
    expect(listSync).not.toHaveBeenCalled();
  });

  it("re-entrancy: a tick still in flight skips a concurrent fire; a fresh tick after resolution runs again", async () => {
    let resolveFirst!: (agents: HerdrAgent[]) => void;
    const listAsync = mock(() => new Promise<HerdrAgent[]>((resolve) => (resolveFirst = resolve)));
    const herdr = {
      listAsync,
      read: mock(() => ""),
      readAsync: mock(() => Promise.resolve("")),
    } as unknown as FakeHerdr;
    const poller = newPoller(herdr);

    const p1 = poller.tick(); // starts, doesn't resolve yet
    const p2 = poller.tick(); // fires while p1 is in flight — guard should skip it

    // Only p1's call has landed; the guard swallowed p2 before it could invoke listAsync again.
    expect(listAsync).toHaveBeenCalledTimes(1);

    resolveFirst([]);
    await p1;
    await p2;

    // Fresh tick after the guard reset: listAsync fires again. Don't await it to
    // completion — its own promise is only resolved by the next resolveFirst reassignment.
    const p3 = poller.tick();
    expect(listAsync).toHaveBeenCalledTimes(2);
    resolveFirst([]);
    await p3;
  });
});
