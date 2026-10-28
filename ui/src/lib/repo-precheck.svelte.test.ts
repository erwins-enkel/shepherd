import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DrainStatus, EpicAutoBlockers, EpicAutoFixResult } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { ApiError } from "#lib/api.js";
import { toasts } from "#lib/toasts.svelte.js";
import { RepoPrecheck } from "./repo-precheck.svelte";

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

// The repo on Standard: #35 runs Codex, #40 Claude Code.
const STD_CODEX: EpicAutoBlockers = {
  agentProvider: "codex",
  causes: [
    {
      code: "sandbox_interactive",
      scope: "repo",
      detail: "standard",
      fix: { changes: { sandboxProfile: "autonomous" }, enabled: true, checks: [] },
    },
    {
      code: "sandbox_provider_unconfined",
      scope: "epic",
      detail: "codex",
      fix: { changes: { agentProvider: "claude" }, enabled: true, checks: [] },
    },
  ],
  options: [{ id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] }],
  preselect: "trusted",
};
const STD_CLAUDE: EpicAutoBlockers = {
  agentProvider: "claude",
  causes: [STD_CODEX.causes[0]!],
  options: [],
  preselect: null,
};
const AUTO_CODEX: EpicAutoBlockers = {
  agentProvider: "codex",
  causes: [STD_CODEX.causes[1]!],
  options: [],
  preselect: null,
};

const CODEX_PREV = { agentProvider: "codex" as const, model: null, effort: null };

let n = 0;
const repo = () => `/repo/precheck-${++n}`;

function drain(repoPath: string, over: Partial<DrainStatus> = {}): DrainStatus {
  return {
    repoPath,
    enabled: true,
    paused: false,
    reason: "sandbox_provider_unconfined",
    detail: "codex",
    queued: 1,
    inFlight: 0,
    max: 2,
    epicParent: 35,
    ...over,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Answer each epic's model from `models` (the latest set). */
function serve(models: Record<number, EpicAutoBlockers>) {
  api.getEpicAutoFix.mockImplementation(async (_repo, parent) => {
    const b = models[parent];
    if (!b) throw new Error("503");
    return b;
  });
}

beforeEach(() => {
  api.getEpicAutoFix.mockReset();
  api.applyEpicAutoFix.mockReset();
});

describe("RepoPrecheck (#3456)", () => {
  it("asks every listed epic at once and publishes the answers together; a failed one is missing", async () => {
    serve({ 35: STD_CODEX, 40: STD_CLAUDE });
    const r = repo();
    const p = new RepoPrecheck();
    p.watch(r, [35, 40, 41], drain(r));
    expect(p.models).toEqual({});
    await settle();
    expect(api.getEpicAutoFix.mock.calls).toEqual([
      [r, 35],
      [r, 40],
      [r, 41],
    ]);
    expect(p.models).toEqual({ 35: STD_CODEX, 40: STD_CLAUDE });
  });

  it("asks again only when the list or the drain's hold changes, and drops a late answer", async () => {
    const first = deferred<EpicAutoBlockers>();
    api.getEpicAutoFix.mockReturnValueOnce(first.promise).mockResolvedValueOnce(AUTO_CODEX);
    const r = repo();
    const p = new RepoPrecheck();
    p.watch(r, [35], drain(r));
    p.watch(r, [35], drain(r));
    expect(api.getEpicAutoFix).toHaveBeenCalledTimes(1);
    p.watch(r, [35], drain(r, { reason: "sandbox_interactive", detail: "standard" }));
    await settle();
    first.resolve(STD_CODEX);
    await settle();
    expect(api.getEpicAutoFix).toHaveBeenCalledTimes(2);
    expect(p.models[35]).toEqual(AUTO_CODEX);
  });

  it("applies the repo's own fix through an epic, keeps it for Undo and asks every model again", async () => {
    const r = repo();
    serve({ 35: STD_CODEX, 40: STD_CLAUDE });
    const p = new RepoPrecheck();
    p.watch(r, [35, 40], drain(r));
    await settle();

    api.applyEpicAutoFix.mockResolvedValueOnce({
      previous: { sandboxProfile: "inherit" },
      blockers: AUTO_CODEX,
    });
    serve({ 35: AUTO_CODEX, 40: { ...STD_CLAUDE, causes: [] } });
    expect(await p.applyCause(35, "sandbox_interactive", "repo")).toBe(true);
    expect(api.applyEpicAutoFix).toHaveBeenCalledWith(r, 35, { cause: "sandbox_interactive" });
    expect(p.applied).toEqual({
      at: "repo",
      parent: 35,
      changes: { sandboxProfile: "autonomous" },
      previous: { sandboxProfile: "inherit" },
    });
    await settle();
    expect(p.models[35]).toEqual(AUTO_CODEX);
    expect(p.models[40]?.causes).toEqual([]);

    api.applyEpicAutoFix.mockResolvedValueOnce({ previous: {}, blockers: STD_CODEX });
    await p.undo();
    expect(api.applyEpicAutoFix).toHaveBeenLastCalledWith(r, 35, {
      restore: { sandboxProfile: "inherit" },
    });
    expect(p.applied).toBeNull();
  });

  it("applies a chooser way as the repo's fix; nothing for a fix the model doesn't name", async () => {
    const r = repo();
    serve({ 35: STD_CODEX, 40: STD_CLAUDE });
    const p = new RepoPrecheck();
    p.watch(r, [35, 40], drain(r));
    await settle();
    api.applyEpicAutoFix.mockResolvedValue({
      previous: { sandboxProfile: "inherit" },
      blockers: STD_CODEX,
    });
    expect(await p.applyOption(35, "trusted")).toBe(true);
    expect(api.applyEpicAutoFix).toHaveBeenCalledWith(r, 35, { option: "trusted" });
    expect(p.applied?.at).toBe("repo");

    // #40 runs Claude Code: no CLI cause, and its model offers no ways.
    expect(await p.applyCause(40, "sandbox_provider_unconfined", "epic")).toBe(false);
    expect(await p.applyOption(40, "trusted")).toBe(false);
    expect(api.applyEpicAutoFix).toHaveBeenCalledTimes(1);
  });

  it("a fix the server no longer offers says so and shows the current models", async () => {
    const r = repo();
    serve({ 35: STD_CODEX });
    const p = new RepoPrecheck();
    p.watch(r, [35], drain(r));
    await settle();
    const info = vi.spyOn(toasts, "info");
    api.applyEpicAutoFix.mockRejectedValueOnce(new ApiError(409, "gone"));
    serve({ 35: AUTO_CODEX });
    expect(await p.applyCause(35, "sandbox_provider_unconfined", "epic")).toBe(false);
    expect(info).toHaveBeenCalledWith(m.epic_autofix_unavailable(), {
      alert: true,
      key: "epic-autofix-fail",
    });
    expect(p.applied).toBeNull();
    expect(p.busy).toBe(false);
    await settle();
    expect(p.models[35]).toEqual(AUTO_CODEX);
    info.mockRestore();
  });

  it("a failed Undo keeps the fix and says so", async () => {
    const r = repo();
    serve({ 35: STD_CODEX });
    const p = new RepoPrecheck();
    p.watch(r, [35], drain(r));
    await settle();
    api.applyEpicAutoFix.mockResolvedValueOnce({ previous: CODEX_PREV, blockers: STD_CODEX });
    await p.applyCause(35, "sandbox_provider_unconfined", "epic");
    const info = vi.spyOn(toasts, "info");
    api.applyEpicAutoFix.mockRejectedValueOnce(new Error("500"));
    await p.undo();
    expect(info).toHaveBeenCalledWith(m.epic_autofix_undo_failed(), {
      alert: true,
      key: "epic-autofix-fail",
    });
    expect(p.applied?.previous).toEqual(CODEX_PREV);
    info.mockRestore();
  });

  it("another repo starts from scratch", async () => {
    const a = repo();
    const b = repo();
    serve({ 35: STD_CODEX });
    const p = new RepoPrecheck();
    p.watch(a, [35], drain(a));
    await settle();
    api.applyEpicAutoFix.mockResolvedValueOnce({ previous: CODEX_PREV, blockers: STD_CODEX });
    await p.applyCause(35, "sandbox_provider_unconfined", "epic");
    serve({});
    p.watch(b, [35], drain(b));
    expect(p.models).toEqual({});
    expect(p.applied).toBeNull();
  });
});
