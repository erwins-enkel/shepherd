import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toasts } from "./toasts.svelte";
import { hideSessionArtifacts } from "./artifacts-hide";
import { ApiError, setArtifactsHidden } from "#lib/api.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ApiError: actual.ApiError, setArtifactsHidden: vi.fn() };
});
const put = vi.mocked(setArtifactsHidden);

beforeEach(() => {
  put.mockReset();
  for (const t of [...toasts.items]) toasts.close(t.id);
});
afterEach(() => {
  for (const t of [...toasts.items]) toasts.close(t.id);
});

const flush = () => new Promise((r) => setTimeout(r, 0));

test("a hide confirms with an Undo that reverses exactly this hide's stamp", async () => {
  put.mockResolvedValueOnce({ id: "s1", artifacts: [], hiddenAt: 1234 });
  await hideSessionArtifacts("s1");
  expect(put).toHaveBeenCalledWith("s1", { hidden: true });
  expect(toasts.items).toHaveLength(1);
  expect(toasts.items[0]?.text).toBe("Artifacts hidden for this session");
  expect(toasts.items[0]?.actionLabel).toBe("undo");
  expect(toasts.items[0]?.durationMs).toBe(8000);

  put.mockResolvedValueOnce({ id: "s1", artifacts: [], hiddenAt: null });
  toasts.act(toasts.items[0]!.id);
  await flush();
  expect(put).toHaveBeenLastCalledWith("s1", { hidden: false, hiddenAt: 1234 });
  expect(toasts.items).toHaveLength(0);
});

test("an Undo a later hide overtook says so instead of failing loudly", async () => {
  put.mockResolvedValueOnce({ id: "s1", artifacts: [], hiddenAt: 1 });
  await hideSessionArtifacts("s1");
  put.mockRejectedValueOnce(new ApiError(409, "superseded", "hide_superseded", true));
  toasts.act(toasts.items[0]!.id);
  await flush();
  expect(toasts.items.map((t) => [t.text, t.alert ?? false])).toEqual([
    ["Hidden again in the meantime, nothing undone", false],
  ]);
});

test("a failed hide or undo raises an alert", async () => {
  put.mockRejectedValueOnce(new ApiError(502, "down"));
  await hideSessionArtifacts("s1");
  expect(toasts.items.map((t) => [t.text, t.alert])).toEqual([
    ["Couldn't hide the artifacts", true],
  ]);
  toasts.close(toasts.items[0]!.id);

  put.mockResolvedValueOnce({ id: "s1", artifacts: [], hiddenAt: 7 });
  await hideSessionArtifacts("s1");
  put.mockRejectedValueOnce(new ApiError(404, "gone"));
  toasts.act(toasts.items[0]!.id);
  await flush();
  expect(toasts.items.map((t) => [t.text, t.alert])).toEqual([
    ["Couldn't show the artifacts again", true],
  ]);
});
