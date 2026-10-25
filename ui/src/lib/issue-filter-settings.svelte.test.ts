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
};
const settings = (issueFilter?: IssueFilterSettings) => ({ issueFilter }) as unknown as Settings;

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
});
