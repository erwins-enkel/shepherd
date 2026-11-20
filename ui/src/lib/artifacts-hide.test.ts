import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toasts } from "./toasts.svelte";
import { hideSessionArtifacts } from "./artifacts-hide";
import { ApiError, hideArtifacts, undoArtifactsHide } from "#lib/api.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ApiError: actual.ApiError, hideArtifacts: vi.fn(), undoArtifactsHide: vi.fn() };
});
const hide = vi.mocked(hideArtifacts);
const undo = vi.mocked(undoArtifactsHide);

beforeEach(() => {
  hide.mockReset();
  undo.mockReset();
  for (const t of [...toasts.items]) toasts.close(t.id);
});
afterEach(() => {
  for (const t of [...toasts.items]) toasts.close(t.id);
});

const flush = () => new Promise((r) => setTimeout(r, 0));

test("a hide confirms with an Undo that reverses exactly this hide's stamp", async () => {
  hide.mockResolvedValueOnce({ id: "s1", artifacts: [], hiddenAt: 1234 });
  await hideSessionArtifacts("s1");
  expect(hide).toHaveBeenCalledWith("s1");
  expect(toasts.items).toHaveLength(1);
  expect(toasts.items[0]?.text).toBe("Artifacts hidden for this session");
  expect(toasts.items[0]?.actionLabel).toBe("undo");
  expect(toasts.items[0]?.durationMs).toBe(8000);

  undo.mockResolvedValueOnce({ id: "s1", artifacts: [], hiddenAt: null });
  toasts.act(toasts.items[0]!.id);
  await flush();
  expect(undo).toHaveBeenCalledWith("s1", 1234);
  expect(toasts.items).toHaveLength(0);
});

test("an Undo a later hide overtook says so instead of failing loudly", async () => {
  hide.mockResolvedValueOnce({ id: "s1", artifacts: [], hiddenAt: 1 });
  await hideSessionArtifacts("s1");
  undo.mockRejectedValueOnce(new ApiError(409, "superseded", "hide_superseded", true));
  toasts.act(toasts.items[0]!.id);
  await flush();
  expect(toasts.items.map((t) => [t.text, t.alert ?? false])).toEqual([
    ["Hidden again in the meantime, nothing undone", false],
  ]);
});

test("a failed hide or undo raises an alert", async () => {
  hide.mockRejectedValueOnce(new ApiError(502, "down"));
  await hideSessionArtifacts("s1");
  expect(toasts.items.map((t) => [t.text, t.alert])).toEqual([
    ["Couldn't hide the artifacts", true],
  ]);
  toasts.close(toasts.items[0]!.id);

  hide.mockResolvedValueOnce({ id: "s1", artifacts: [], hiddenAt: 7 });
  await hideSessionArtifacts("s1");
  undo.mockRejectedValueOnce(new ApiError(404, "gone"));
  toasts.act(toasts.items[0]!.id);
  await flush();
  expect(toasts.items.map((t) => [t.text, t.alert])).toEqual([
    ["Couldn't show the artifacts again", true],
  ]);
});
