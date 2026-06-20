import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { toasts } from "./toasts.svelte";
import { offerUpdateMain, pullMainAndToast } from "./pull-offer";
import { pullRepo } from "$lib/api";

vi.mock("$lib/api", () => ({ pullRepo: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(pullRepo).mockReset();
  // start each test from a clean queue (module-singleton store)
  for (const t of [...toasts.items]) toasts.close(t.id);
});

afterEach(() => {
  vi.useRealTimers();
});

test("offer toast auto-dismisses after 15s when ignored", async () => {
  offerUpdateMain("/repo/a");
  expect(toasts.items).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(14_999);
  expect(toasts.items).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(toasts.items).toHaveLength(0);
});

test("re-offer for the same repo re-arms one toast, gone 15s after the second offer", async () => {
  offerUpdateMain("/repo/a");
  await vi.advanceTimersByTimeAsync(10_000);

  offerUpdateMain("/repo/a");
  expect(toasts.items).toHaveLength(1); // keyed dedupe: still exactly one

  await vi.advanceTimersByTimeAsync(14_999); // 24.999s after the FIRST offer
  expect(toasts.items).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(toasts.items).toHaveLength(0);
});

test("failure toast from the offer's action stays persistent", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: false, reason: "error" });

  offerUpdateMain("/repo/a");
  const offer = toasts.items.find((t) => t.key === "update-main-offer:/repo/a");
  expect(offer).toBeDefined();
  toasts.act(offer!.id); // drops the offer, runs pullRepo
  await vi.advanceTimersByTimeAsync(0); // flush the async run

  expect(pullRepo).toHaveBeenCalledWith("/repo/a", undefined);
  expect(toasts.items).toHaveLength(1);
  expect(toasts.items.find((t) => t.key === "update-main:/repo/a")).toBeDefined();

  await vi.advanceTimersByTimeAsync(120_000); // far past 15s
  expect(toasts.items).toHaveLength(1); // duration null: must not vanish
});

// ── pullMainAndToast PullResult → toast mapping ──────────────────────────────

test("pullMainAndToast: ok+updated → info toast with done key text", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: true, branch: "main", updated: true, sha: "x" });
  await pullMainAndToast("/repo/a");
  expect(toasts.items).toHaveLength(1);
  // toast should auto-dismiss (finite duration) — advance past default 4s
  await vi.advanceTimersByTimeAsync(4_100);
  expect(toasts.items).toHaveLength(0);
});

test("pullMainAndToast: ok+not-updated → info toast that auto-dismisses", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: true, branch: "main", updated: false, sha: "x" });
  await pullMainAndToast("/repo/a");
  expect(toasts.items).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(4_100);
  expect(toasts.items).toHaveLength(0);
});

test("pullMainAndToast: wrong_branch → benign info that auto-dismisses", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: false, reason: "wrong_branch", branch: "main" });
  await pullMainAndToast("/repo/a");
  expect(toasts.items).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(4_100);
  expect(toasts.items).toHaveLength(0);
});

test("pullMainAndToast: dirty → benign info that auto-dismisses", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: false, reason: "dirty", branch: "main" });
  await pullMainAndToast("/repo/a");
  expect(toasts.items).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(4_100);
  expect(toasts.items).toHaveLength(0);
});

test("pullMainAndToast: diverged → benign info that auto-dismisses", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: false, reason: "diverged", branch: "main" });
  await pullMainAndToast("/repo/a");
  expect(toasts.items).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(4_100);
  expect(toasts.items).toHaveLength(0);
});

test("pullMainAndToast: error → persistent alert toast keyed to repo", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: false, reason: "error" });
  await pullMainAndToast("/repo/a");
  expect(toasts.items).toHaveLength(1);
  expect(toasts.items.find((t) => t.key === "update-main:/repo/a")).toBeDefined();
  // Persistent: must survive far past any finite default duration
  await vi.advanceTimersByTimeAsync(120_000);
  expect(toasts.items).toHaveLength(1);
});
