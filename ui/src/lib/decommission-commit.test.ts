import { describe, expect, it, vi } from "vitest";
import { createDecommissionCommit } from "./decommission-commit";

function actions() {
  return {
    closePr: vi.fn().mockResolvedValue(undefined),
    mergePr: vi.fn().mockResolvedValue(undefined),
    archiveSession: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createDecommissionCommit", () => {
  it("archives directly when the PR stays open", async () => {
    const api = actions();
    const commit = createDecommissionCommit({ id: "s1", reap: ["vite:5173"], action: "keep" }, api);

    await commit.run();

    expect(api.closePr).not.toHaveBeenCalled();
    expect(api.mergePr).not.toHaveBeenCalled();
    expect(api.archiveSession).toHaveBeenCalledWith("s1", ["vite:5173"]);
  });

  it("forwards the operator's merge confirmation to the gated merge endpoint", async () => {
    // The decommission dialog IS this merge's confirmation (#2299): without the payload the
    // server refuses the merge whenever the repo puts someone else on the hook.
    const api = actions();
    const mergeConfirm = {
      headSha: "abc123",
      baseRefName: "main",
      handoff: "merger" as const,
      handoffWho: "scoop",
      reviewBlockBy: null,
    };
    await createDecommissionCommit({ id: "s1", action: "merge", mergeConfirm }, api).run();

    expect(api.mergePr).toHaveBeenCalledWith("s1", mergeConfirm);
  });

  it("retries a failed PR action before attempting the archive", async () => {
    const api = actions();
    api.closePr.mockRejectedValueOnce(new Error("close failed"));
    const commit = createDecommissionCommit({ id: "s1", action: "close" }, api);

    await expect(commit.run()).rejects.toThrow("close failed");
    expect(api.archiveSession).not.toHaveBeenCalled();

    await commit.run();
    expect(api.closePr).toHaveBeenCalledTimes(2);
    expect(api.archiveSession).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a successful close when the immediate archive retry is needed", async () => {
    const api = actions();
    api.archiveSession.mockRejectedValueOnce(new Error("archive failed"));
    const commit = createDecommissionCommit({ id: "s1", action: "close" }, api);

    await expect(commit.run()).rejects.toThrow("archive failed");
    await commit.run();

    expect(api.closePr).toHaveBeenCalledTimes(1);
    expect(api.archiveSession).toHaveBeenCalledTimes(2);
  });

  it("keeps the merge pending when it was refused, so a rebuilt commit still merges", async () => {
    // A refused merge confirmation (#2299) must not silently degrade into "archive without
    // merging" — the operator asked for a merge. The caller rebuilds the confirmation and
    // re-runs; `remaining` staying "merge" is what makes that second run do the merge.
    const api = actions();
    api.mergePr.mockRejectedValueOnce(
      Object.assign(new Error("confirm"), { code: "merge_confirm_stale" }),
    );
    const commit = createDecommissionCommit({ id: "s1", action: "merge" }, api);

    await expect(commit.run()).rejects.toThrow("confirm");
    expect(api.archiveSession).not.toHaveBeenCalled();

    await commit.run();
    expect(api.mergePr).toHaveBeenCalledTimes(2);
    expect(api.archiveSession).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a successful merge when the immediate archive retry is needed", async () => {
    const api = actions();
    api.archiveSession.mockRejectedValueOnce(new Error("archive failed"));
    const commit = createDecommissionCommit({ id: "s1", action: "merge" }, api);

    await expect(commit.run()).rejects.toThrow("archive failed");
    await commit.run();

    expect(api.mergePr).toHaveBeenCalledTimes(1);
    expect(api.archiveSession).toHaveBeenCalledTimes(2);
  });
});
