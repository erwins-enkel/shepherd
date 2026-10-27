import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DrainStatus, EpicAutoBlockers, EpicAutoFixResult } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { ApiError } from "#lib/api.js";
import { toasts } from "#lib/toasts.svelte.js";
import { epicAutoFix } from "./epic-auto-fix.svelte";

const api = vi.hoisted(() => ({
  getRepoConfig: vi.fn<(repo: string) => Promise<unknown>>(async () => {
    throw new Error("offline");
  }),
  getEpicAutoFix: vi.fn<(repo: string, parent: number) => Promise<EpicAutoBlockers>>(),
  applyEpicAutoFix:
    vi.fn<(repo: string, parent: number, body: unknown) => Promise<EpicAutoFixResult>>(),
}));

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, ...api };
});

const B = 20;
// "Behebung" Fall A: the repo on Standard, the epic on Codex.
const FALL_A: EpicAutoBlockers = {
  causes: [
    { code: "sandbox_interactive", scope: "repo", detail: "standard" },
    { code: "sandbox_provider_unconfined", scope: "epic", detail: "codex" },
  ],
  options: [
    {
      id: "autonomous_claude",
      changes: { sandboxProfile: "autonomous", agentProvider: "claude" },
      enabled: true,
      checks: [],
    },
    { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
  ],
  preselect: "autonomous_claude",
};
const FALL_C: EpicAutoBlockers = {
  causes: [
    { code: "sandbox_interactive", scope: "repo", detail: "standard" },
    { code: "sandbox_backend_unavailable", scope: "host", detail: "standard" },
  ],
  options: [{ id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] }],
  preselect: "trusted",
};
const CLEAR: EpicAutoBlockers = { causes: [], options: [], preselect: null };
const PREVIOUS = { sandboxProfile: "inherit" as const, agentProvider: "codex" as const };

let n = 0;
const repo = () => `/repo/fix-${++n}`;

function drain(repoPath: string, over: Partial<DrainStatus> = {}): DrainStatus {
  return {
    repoPath,
    enabled: true,
    paused: true,
    reason: "sandbox_provider_unconfined",
    detail: "codex",
    queued: 2,
    inFlight: 0,
    max: 2,
    epicParent: B,
    ...over,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  api.getEpicAutoFix.mockReset();
  api.applyEpicAutoFix.mockReset();
});

describe("epicAutoFix (#3455)", () => {
  it("asks once for every surface watching the same hold", async () => {
    api.getEpicAutoFix.mockResolvedValue(FALL_A);
    const r = repo();
    const a = epicAutoFix.watch(r, drain(r));
    const b = epicAutoFix.watch(r, drain(r));
    await settle();
    expect(api.getEpicAutoFix).toHaveBeenCalledTimes(1);
    expect(api.getEpicAutoFix).toHaveBeenCalledWith(r, B);
    expect(epicAutoFix.blockers(r, B)).toEqual(FALL_A);
    // Another epic of the repo has no halt of its own.
    expect(epicAutoFix.blockers(r, 99)).toBeNull();
    a();
    b();
  });

  it("asks again for a new hold and drops the late answer to the old one", async () => {
    const first = deferred<EpicAutoBlockers>();
    api.getEpicAutoFix.mockReturnValueOnce(first.promise).mockResolvedValueOnce(FALL_C);
    const r = repo();
    const a = epicAutoFix.watch(r, drain(r));
    const b = epicAutoFix.watch(r, drain(r, { reason: "sandbox_interactive", detail: "standard" }));
    await settle();
    first.resolve(FALL_A);
    await settle();
    expect(api.getEpicAutoFix).toHaveBeenCalledTimes(2);
    expect(epicAutoFix.blockers(r, B)).toEqual(FALL_C);
    a();
    b();
  });

  it("a failed load stays failed for the hold and is asked again once every surface left", async () => {
    api.getEpicAutoFix.mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce(FALL_A);
    const r = repo();
    const a = epicAutoFix.watch(r, drain(r));
    await settle();
    expect(epicAutoFix.blockers(r, B)).toBeNull();
    // An effect's rerun on the same hold doesn't hammer the server.
    a();
    const b = epicAutoFix.watch(r, drain(r));
    await settle();
    expect(api.getEpicAutoFix).toHaveBeenCalledTimes(1);
    b();
    await settle();
    const c = epicAutoFix.watch(r, drain(r));
    await settle();
    expect(api.getEpicAutoFix).toHaveBeenCalledTimes(2);
    expect(epicAutoFix.blockers(r, B)).toEqual(FALL_A);
    c();
  });

  it("shares the pick; the hold clearing drops model and pick but keeps the applied fix", async () => {
    api.getEpicAutoFix.mockResolvedValue(FALL_A);
    api.applyEpicAutoFix.mockResolvedValueOnce({ previous: PREVIOUS, blockers: CLEAR });
    const r = repo();
    const a = epicAutoFix.watch(r, drain(r));
    await settle();
    epicAutoFix.pick(r, B, "trusted");
    expect(epicAutoFix.picked(r, B)).toBe("trusted");
    expect(epicAutoFix.picked(r, 99)).toBeNull();

    expect(await epicAutoFix.apply(r, B, "trusted", [21])).toBe(true);
    expect(api.applyEpicAutoFix).toHaveBeenCalledWith(r, B, { option: "trusted" });
    expect(epicAutoFix.blockers(r, B)).toEqual(CLEAR);
    expect(epicAutoFix.applied(r, B)).toEqual({
      parent: B,
      changes: { sandboxProfile: "trusted" },
      previous: PREVIOUS,
      starting: [21],
    });

    const b = epicAutoFix.watch(r, drain(r, { reason: null, detail: null }));
    expect(epicAutoFix.blockers(r, B)).toBeNull();
    expect(epicAutoFix.picked(r, B)).toBeNull();
    expect(epicAutoFix.applied(r, B)).not.toBeNull();
    a();
    b();
  });

  it("undo writes the previous values back and forgets the fix", async () => {
    api.getEpicAutoFix.mockResolvedValue(FALL_A);
    api.applyEpicAutoFix
      .mockResolvedValueOnce({ previous: PREVIOUS, blockers: CLEAR })
      .mockResolvedValueOnce({ previous: { sandboxProfile: "autonomous" }, blockers: FALL_A });
    const r = repo();
    const a = epicAutoFix.watch(r, drain(r));
    await settle();
    await epicAutoFix.apply(r, B, "autonomous_claude", []);
    await epicAutoFix.undo(r, B);
    expect(api.applyEpicAutoFix).toHaveBeenLastCalledWith(r, B, { restore: PREVIOUS });
    expect(epicAutoFix.applied(r, B)).toBeNull();
    expect(epicAutoFix.blockers(r, B)).toEqual(FALL_A);
    a();
  });

  it("a refused way says so and asks for the current ways", async () => {
    api.getEpicAutoFix.mockResolvedValueOnce(FALL_A).mockResolvedValueOnce(FALL_C);
    api.applyEpicAutoFix.mockRejectedValueOnce(new ApiError(409, "gone"));
    const info = vi.spyOn(toasts, "info");
    const r = repo();
    const a = epicAutoFix.watch(r, drain(r));
    await settle();
    expect(await epicAutoFix.apply(r, B, "autonomous_claude", [])).toBe(false);
    await settle();
    expect(info).toHaveBeenCalledWith(m.epic_autofix_unavailable(), expect.anything());
    expect(epicAutoFix.blockers(r, B)).toEqual(FALL_C);
    expect(epicAutoFix.applied(r, B)).toBeNull();
    expect(epicAutoFix.busy(r)).toBe(false);
    info.mockRestore();
    a();
  });

  it("keeps the state across an effect's rerun and drops it once the last surface leaves", async () => {
    api.getEpicAutoFix.mockResolvedValue(FALL_A);
    api.applyEpicAutoFix.mockResolvedValueOnce({ previous: PREVIOUS, blockers: CLEAR });
    const r = repo();
    const a = epicAutoFix.watch(r, drain(r));
    await settle();
    await epicAutoFix.apply(r, B, "trusted", []);
    // Release and watch again synchronously, as an effect's rerun does.
    a();
    const b = epicAutoFix.watch(r, drain(r, { reason: null, detail: null }));
    await settle();
    expect(epicAutoFix.applied(r, B)).not.toBeNull();
    b();
    await settle();
    expect(epicAutoFix.applied(r, B)).toBeNull();
  });

  it("counts the repo and host causes for the Automation tab", async () => {
    const r1 = repo();
    const r2 = repo();
    api.getEpicAutoFix.mockResolvedValueOnce(FALL_A).mockResolvedValueOnce(FALL_C);
    const a = epicAutoFix.watch(r1, drain(r1));
    const b = epicAutoFix.watch(r2, drain(r2));
    await settle();
    expect(epicAutoFix.repoHalts(r1)).toBe(1);
    expect(epicAutoFix.repoHalts(r2)).toBe(2);
    expect(epicAutoFix.repoHalts(repo())).toBe(0);
    a();
    b();
  });

  it("asks nothing while the drain holds for another reason", async () => {
    const r = repo();
    const a = epicAutoFix.watch(r, drain(r, { reason: "cap", detail: null }));
    await settle();
    expect(api.getEpicAutoFix).not.toHaveBeenCalled();
    expect(epicAutoFix.repoHalts(r)).toBe(0);
    a();
  });
});
