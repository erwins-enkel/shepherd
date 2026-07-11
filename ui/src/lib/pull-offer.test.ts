import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { toasts } from "./toasts.svelte";
import { pullMainAndToast } from "./pull-offer";
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

// ── pullMainAndToast PullResult → toast mapping ──────────────────────────────

test("pullMainAndToast: ok+updated → info toast with done key text", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: true, branch: "main", updated: true, sha: "x" });
  await pullMainAndToast("/repo/a");
  expect(toasts.items).toHaveLength(1);
  // "Updated local main to latest" — distinct from uptodate ("already up to date")
  expect(toasts.items[0].text).toContain("to latest");
  // toast should auto-dismiss (finite duration) — advance past default 4s
  await vi.advanceTimersByTimeAsync(4_100);
  expect(toasts.items).toHaveLength(0);
});

test("pullMainAndToast: ok+not-updated → info toast that auto-dismisses", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: true, branch: "main", updated: false, sha: "x" });
  await pullMainAndToast("/repo/a");
  expect(toasts.items).toHaveLength(1);
  // "Local main already up to date" — distinct from updated ("to latest")
  expect(toasts.items[0].text).toContain("already up to date");
  await vi.advanceTimersByTimeAsync(4_100);
  expect(toasts.items).toHaveLength(0);
});

test("pullMainAndToast: wrong_branch → benign info that auto-dismisses", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: false, reason: "wrong_branch", branch: "main" });
  await pullMainAndToast("/repo/a");
  expect(toasts.items).toHaveLength(1);
  // "Local checkout isn't on main; left it untouched"
  expect(toasts.items[0].text).toContain("isn't on");
  await vi.advanceTimersByTimeAsync(4_100);
  expect(toasts.items).toHaveLength(0);
});

test("pullMainAndToast: dirty → benign info that auto-dismisses", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: false, reason: "dirty", branch: "main" });
  await pullMainAndToast("/repo/a");
  expect(toasts.items).toHaveLength(1);
  // "Local main has uncommitted changes; left it untouched"
  expect(toasts.items[0].text).toContain("uncommitted changes");
  await vi.advanceTimersByTimeAsync(4_100);
  expect(toasts.items).toHaveLength(0);
});

test("pullMainAndToast: diverged → benign info that auto-dismisses", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: false, reason: "diverged", branch: "main" });
  await pullMainAndToast("/repo/a");
  expect(toasts.items).toHaveLength(1);
  // "Local main has diverged; pull manually"
  expect(toasts.items[0].text).toContain("diverged");
  await vi.advanceTimersByTimeAsync(4_100);
  expect(toasts.items).toHaveLength(0);
});

test("pullMainAndToast: error → 12s alert toast keyed to repo", async () => {
  vi.mocked(pullRepo).mockResolvedValue({ ok: false, reason: "error" });
  await pullMainAndToast("/repo/a");
  expect(toasts.items).toHaveLength(1);
  expect(toasts.items.find((t) => t.key === "update-main:/repo/a")).toBeDefined();
  // Assertive failure → 12s window: survives the 4s benign default, then auto-dismisses
  await vi.advanceTimersByTimeAsync(4_100);
  expect(toasts.items).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(toasts.items).toHaveLength(0);
});
