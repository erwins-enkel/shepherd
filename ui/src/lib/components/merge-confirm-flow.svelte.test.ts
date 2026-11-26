import { beforeEach, describe, expect, it, vi } from "vitest";
import { MergeRefusedError } from "#lib/api.js";
import type { MergeConfirmContext } from "./merge-confirm";

const { info, dismissKey } = vi.hoisted(() => ({ info: vi.fn(), dismissKey: vi.fn() }));
vi.mock("#lib/toasts.svelte.js", () => ({ toasts: { info, dismissKey } }));

const { MergeConfirmFlow } = await import("./merge-confirm-flow.svelte");

function ctx(over: Partial<MergeConfirmContext> = {}): MergeConfirmContext {
  return {
    repoLabel: "shepherd",
    number: 42,
    title: "feat: thing",
    baseBranch: "main",
    mergeMethod: "squash",
    headSha: "abc",
    handoff: null,
    handoffWho: null,
    reviewBlockBy: null,
    ...over,
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function refusal() {
  return new MergeRefusedError(
    409,
    "confirm again",
    "merge_confirm_stale",
    { handoff: "merger", handoffWho: "octo", reviewBlockBy: null },
    { headSha: "def", baseRefName: "main" },
  );
}

beforeEach(() => {
  info.mockReset();
  dismissKey.mockReset();
});

describe("MergeConfirmFlow", () => {
  it("closes the dialog on confirm and shows a sticky progress toast until the merge settles", async () => {
    const flow = new MergeConfirmFlow();
    const d = deferred();
    const run = vi.fn(() => d.promise);
    flow.open(ctx(), run);

    const done = flow.confirm();
    expect(flow.ctx).toBeNull();
    expect(flow.busy).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
    const [text, opts] = info.mock.calls[0];
    expect(text).toContain("42");
    expect(text).toContain("shepherd");
    expect(opts).toMatchObject({ sticky: true });
    expect(dismissKey).not.toHaveBeenCalled();

    d.resolve();
    await done;
    expect(dismissKey).toHaveBeenCalledWith(opts.key);
    expect(flow.busy).toBe(false);
    expect(flow.ctx).toBeNull();
  });

  it("gives two flows distinct progress keys", async () => {
    const a = new MergeConfirmFlow();
    const b = new MergeConfirmFlow();
    a.open(ctx(), async () => {});
    b.open(ctx(), async () => {});
    await Promise.all([a.confirm(), b.confirm()]);
    expect(info.mock.calls[0][1].key).not.toBe(info.mock.calls[1][1].key);
  });

  it("resets without a dialog when the merge fails for an ordinary reason", async () => {
    const flow = new MergeConfirmFlow();
    flow.attach();
    flow.open(ctx(), async () => {
      throw new Error("boom");
    });
    await flow.confirm();
    expect(flow.ctx).toBeNull();
    expect(flow.error).toBeNull();
    expect(flow.busy).toBe(false);
    expect(dismissKey).toHaveBeenCalledOnce();
  });

  it("reopens the re-stated dialog on a refusal while a host is attached", async () => {
    const flow = new MergeConfirmFlow();
    flow.attach();
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(refusal())
      .mockResolvedValueOnce();
    flow.open(ctx(), run);

    await flow.confirm();
    expect(flow.ctx).toMatchObject({ number: 42, handoff: "merger", headSha: "def" });
    expect(flow.error).toBeTruthy();
    expect(flow.busy).toBe(false);
    expect(dismissKey).toHaveBeenCalledOnce();

    await flow.confirm();
    expect(run).toHaveBeenCalledTimes(2);
    expect(flow.ctx).toBeNull();
  });

  it("falls back to an alert toast on a refusal when no host is attached", async () => {
    const flow = new MergeConfirmFlow();
    const detach = flow.attach();
    detach();
    flow.open(ctx(), async () => {
      throw refusal();
    });
    await flow.confirm();
    expect(flow.ctx).toBeNull();
    expect(flow.error).toBeNull();
    const alert = info.mock.calls.find(([, o]) => o?.alert);
    expect(alert).toBeTruthy();
  });

  it("ignores open() while a merge is in flight", async () => {
    const flow = new MergeConfirmFlow();
    const d = deferred();
    flow.open(ctx(), () => d.promise);
    const done = flow.confirm();
    const second = vi.fn(async () => {});
    flow.open(ctx({ number: 7 }), second);
    expect(flow.ctx).toBeNull();
    expect(flow.busy).toBe(true);
    d.resolve();
    await done;
    expect(second).not.toHaveBeenCalled();
  });

  it("runs the merge once on a double confirm", async () => {
    const flow = new MergeConfirmFlow();
    const run = vi.fn(async () => {});
    flow.open(ctx(), run);
    await Promise.all([flow.confirm(), flow.confirm()]);
    expect(run).toHaveBeenCalledOnce();
  });
});
