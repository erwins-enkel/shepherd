import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueFilterSettingsStore } from "./issue-filter-settings.svelte";
import { DEFAULT_ISSUE_FILTER } from "./issue-filter-migration";
import type { IssueFilterSettings, Settings } from "./types";

// The one-time localStorage → server move (#3019) against the browser's real localStorage.
const KEYS = [
  "shepherd:issues-hide-others",
  "shepherd:issues-hide-active",
  "shepherd:issues-hide-subissues",
  "shepherd:issues-hide-blocked",
];

afterEach(() => localStorage.clear());

describe("legacy issue-filter migration", () => {
  it("runs once on first load and removes the old keys", async () => {
    localStorage.setItem("shepherd:issues-hide-others", "0");
    localStorage.setItem("shepherd:issues-hide-blocked", "0");
    localStorage.setItem("shepherd:unrelated", "keep");
    let server: IssueFilterSettings = structuredClone(DEFAULT_ISSUE_FILTER);
    const read = vi.fn(async () => ({ issueFilter: server }) as unknown as Settings);
    const write = vi.fn(async (patch: Partial<IssueFilterSettings>) => {
      server = { ...server, ...patch };
      return { issueFilter: server };
    });

    const first = new IssueFilterSettingsStore(read, write);
    await first.ensureLoaded();
    await expect.poll(() => KEYS.map((k) => localStorage.getItem(k))).toEqual(KEYS.map(() => null));
    expect(write).toHaveBeenCalledExactlyOnceWith({ scope: "all", hideBlocked: false });
    expect(first.value).toMatchObject({ scope: "all", hideBlocked: false });
    expect(localStorage.getItem("shepherd:unrelated")).toBe("keep");

    // A later page load (fresh store) finds nothing left to migrate.
    const second = new IssueFilterSettingsStore(read, write);
    await second.ensureLoaded();
    expect(second.value).toMatchObject({ scope: "all", hideBlocked: false });
    expect(write).toHaveBeenCalledTimes(1);
  });
});
