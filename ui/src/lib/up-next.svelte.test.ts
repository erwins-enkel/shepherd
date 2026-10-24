import { describe, expect, test, vi } from "vitest";
import { UpNextStore } from "./up-next.svelte";
import type { UpNextRead } from "./api";

const snapshot = { generatedAt: 1, sections: [], repoCount: 0, fallback: null, failedRepoCount: 0 };
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

describe("Up Next demand and conditional reads", () => {
  test("closed invalidations are lazy; open and changed reads preserve 304 data", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ modified: true, snapshot, etag: '"one"' })
      .mockResolvedValue({ modified: false });
    const store = new UpNextStore(read);
    store.changed();
    expect(read).not.toHaveBeenCalled();
    const close = store.open();
    await settle();
    expect(read).toHaveBeenNthCalledWith(1, { peek: false, etag: null });
    store.changed();
    await settle();
    expect(read).toHaveBeenNthCalledWith(2, { peek: true, etag: '"one"' });
    expect(store.snapshot).toEqual(snapshot);
    expect(store.loadError).toBe(false);
    close();
    store.changed();
    store.reconnected();
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });

  test("invalidation during a read gets one follow-up, closing stops further reads", async () => {
    let finish!: (result: UpNextRead) => void;
    const read = vi.fn(
      () =>
        new Promise<UpNextRead>((resolve) => {
          finish = resolve;
        }),
    );
    const store = new UpNextStore(read);
    const close = store.open();
    store.changed();
    store.changed();
    finish({ modified: true, snapshot, etag: '"one"' });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    store.changed();
    close();
    finish({ modified: false });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
  });

  test("cached null is valid; failure preserves data and retries on reopen", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ modified: true, snapshot: null, etag: '"null"' })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ modified: false });
    const store = new UpNextStore(read);
    let close = store.open();
    await settle();
    store.changed();
    await settle();
    expect(store.loadError).toBe(true);
    expect(store.snapshot).toBeNull();
    close();
    close = store.open();
    await settle();
    expect(read).toHaveBeenLastCalledWith({ peek: false, etag: '"null"' });
    expect(store.loadError).toBe(false);
    close();
  });

  test("a legacy push beats an older read failure and clears the HTTP validator", async () => {
    let fail!: (error: Error) => void;
    const read = vi
      .fn()
      .mockResolvedValueOnce({ modified: true, snapshot, etag: '"one"' })
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValue({ modified: true, snapshot, etag: null });
    const store = new UpNextStore(read);
    const close = store.open();
    await settle();
    store.changed();
    store.apply({ snapshot });
    fail(new Error("older failure"));
    await settle();
    expect(store.loadError).toBe(false);
    store.changed();
    await settle();
    expect(read).toHaveBeenLastCalledWith({ peek: true, etag: null });
    close();
  });

  test("reset fences outgoing reads and clears validators", async () => {
    let finish!: (result: UpNextRead) => void;
    const read = vi.fn(
      () =>
        new Promise<UpNextRead>((resolve) => {
          finish = resolve;
        }),
    );
    const store = new UpNextStore(read);
    const close = store.open();
    store.reset();
    finish({ modified: true, snapshot, etag: '"old"' });
    await settle();
    expect(store.snapshot).toBeNull();
    expect(store.loaded).toBe(false);
    close();
  });
});
