import { describe, expect, test, vi } from "vitest";
import { IssueFilterSettingsStore } from "./issue-filter-settings.svelte";
import { toasts } from "./toasts.svelte";
import type { IssueFilterSettings, Settings } from "./types";

const FILTER: IssueFilterSettings = {
  scope: "mine_unassigned",
  forks: "all",
  hiddenLabels: [],
  hideActive: false,
  hideSubIssues: true,
  hideBlocked: true,
  repoOverrides: {},
};
const settings = (issueFilter?: IssueFilterSettings) => ({ issueFilter }) as unknown as Settings;

function memStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}
const LEGACY_OFF = {
  "shepherd:issues-hide-others": "0",
  "shepherd:issues-hide-active": "1",
  "shepherd:issues-hide-subissues": "0",
  "shepherd:issues-hide-blocked": "0",
};

describe("IssueFilterSettingsStore", () => {
  test("loads once from /api/settings; an old server leaves it null", async () => {
    const read = vi.fn().mockResolvedValue(settings(FILTER));
    const store = new IssueFilterSettingsStore(read, vi.fn());
    await store.ensureLoaded();
    await store.ensureLoaded();
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.value).toEqual(FILTER);

    const old = new IssueFilterSettingsStore(vi.fn().mockResolvedValue(settings()), vi.fn());
    await old.ensureLoaded();
    expect(old.value).toBeNull();
  });

  test("update applies optimistically and adopts the server's value", async () => {
    let resolve!: (v: { issueFilter: IssueFilterSettings }) => void;
    const write = vi.fn(
      () => new Promise<{ issueFilter: IssueFilterSettings }>((r) => (resolve = r)),
    );
    const store = new IssueFilterSettingsStore(vi.fn(), write);
    store.apply(FILTER);
    const done = store.update({ scope: "mine" });
    expect(store.value?.scope).toBe("mine");
    expect(write).toHaveBeenCalledWith({ scope: "mine" });
    resolve({ issueFilter: { ...FILTER, scope: "mine", hiddenLabels: ["docs"] } });
    await done;
    expect(store.value?.hiddenLabels).toEqual(["docs"]);
  });

  test("a failed write reverts and toasts", async () => {
    const info = vi.spyOn(toasts, "info");
    const store = new IssueFilterSettingsStore(vi.fn(), vi.fn().mockRejectedValue(new Error("x")));
    store.apply(FILTER);
    await store.update({ forks: "hide" });
    expect(store.value).toEqual(FILTER);
    expect(info).toHaveBeenCalledWith(expect.any(String), { alert: true });
    info.mockRestore();
  });

  test("a stale failure does not clobber a newer change", async () => {
    let reject!: (e: Error) => void;
    const write = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_, r) => (reject = r)))
      .mockResolvedValue({ issueFilter: { ...FILTER, scope: "all", forks: "own" } });
    const store = new IssueFilterSettingsStore(vi.fn(), write);
    store.apply(FILTER);
    const first = store.update({ scope: "all" });
    await store.update({ forks: "own" });
    reject(new Error("x"));
    await first;
    expect(store.value).toMatchObject({ scope: "all", forks: "own" });
  });

  test("two failed writes in a row revert to the server-confirmed value", async () => {
    const rejects: ((e: Error) => void)[] = [];
    const write = vi.fn(() => new Promise<never>((_, r) => rejects.push(r)));
    const store = new IssueFilterSettingsStore(vi.fn(), write);
    store.apply(FILTER);
    const first = store.update({ scope: "all" });
    const second = store.update({ scope: "mine" });
    rejects[0]!(new Error("x"));
    await first;
    rejects[1]!(new Error("x"));
    await second;
    expect(store.value).toEqual(FILTER);
  });

  test("a failed write after an earlier success reverts to that success", async () => {
    let reject!: (e: Error) => void;
    const write = vi
      .fn()
      .mockResolvedValueOnce({ issueFilter: { ...FILTER, scope: "all" } })
      .mockImplementationOnce(() => new Promise((_, r) => (reject = r)));
    const store = new IssueFilterSettingsStore(vi.fn(), write);
    store.apply(FILTER);
    const first = store.update({ scope: "all" });
    const second = store.update({ scope: "mine" });
    await first;
    reject(new Error("x"));
    await second;
    expect(store.value).toEqual({ ...FILTER, scope: "all" });
  });

  test("reset restores the Up Next defaults only", async () => {
    const write = vi.fn().mockRejectedValue(new Error("x"));
    const store = new IssueFilterSettingsStore(vi.fn(), write);
    store.apply({ ...FILTER, scope: "all", hiddenLabels: ["a"], hideActive: true });
    void store.reset();
    expect(write).toHaveBeenCalledWith({
      scope: "mine_unassigned",
      forks: "all",
      hiddenLabels: [],
    });
    expect(store.value?.hideActive).toBe(true);
  });

  test("effective falls back to the defaults until loaded", () => {
    const store = new IssueFilterSettingsStore(vi.fn(), vi.fn(), () => null);
    expect(store.effective).toEqual(FILTER);
    store.apply({ ...FILTER, scope: "mine" });
    expect(store.effective.scope).toBe("mine");
  });

  describe("legacy localStorage migration", () => {
    test("PATCHes the old choices once onto a default server value, then drops the keys", async () => {
      const storage = memStorage(LEGACY_OFF);
      const migrated = {
        ...FILTER,
        scope: "all" as const,
        hideActive: true,
        hideSubIssues: false,
        hideBlocked: false,
      };
      const write = vi.fn().mockResolvedValue({ issueFilter: migrated });
      const store = new IssueFilterSettingsStore(
        vi.fn().mockResolvedValue(settings(FILTER)),
        write,
        () => storage,
      );
      await store.ensureLoaded();
      await vi.waitFor(() => expect(storage.length).toBe(0));
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith({
        scope: "all",
        hideActive: true,
        hideSubIssues: false,
        hideBlocked: false,
      });
      expect(store.value).toEqual(migrated);
      store.reconnected();
      await vi.waitFor(() => expect(store.value).toEqual(migrated));
      expect(write).toHaveBeenCalledTimes(1);
    });

    test("never overwrites a server value someone already changed", async () => {
      const storage = memStorage(LEGACY_OFF);
      const write = vi.fn();
      const store = new IssueFilterSettingsStore(
        vi.fn().mockResolvedValue(settings({ ...FILTER, forks: "hide" })),
        write,
        () => storage,
      );
      await store.ensureLoaded();
      await vi.waitFor(() => expect(storage.length).toBe(0));
      expect(write).not.toHaveBeenCalled();
    });

    test("keeps the keys when the write fails, for the next load", async () => {
      const storage = memStorage({ "shepherd:issues-hide-active": "1" });
      const write = vi.fn().mockRejectedValue(new Error("x"));
      const store = new IssueFilterSettingsStore(
        vi.fn().mockResolvedValue(settings(FILTER)),
        write,
        () => storage,
      );
      await store.ensureLoaded();
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      expect(storage.length).toBe(1);
      expect(store.value).toEqual(FILTER);
    });
  });
});
