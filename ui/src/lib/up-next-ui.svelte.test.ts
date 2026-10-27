import { afterEach, describe, expect, test } from "vitest";
import type { UpNextPr, UpNextSnapshot } from "./types";
import {
  ACTED_HIDE_MS,
  findUpNextPr,
  isPrKey,
  upNextKey,
  upNextPrKey,
  upNextUi,
} from "./up-next-ui.svelte";

const pr = { repoPath: "/r/a", number: 7 } as UpNextPr;
const snap = (pullRequests?: UpNextPr[]): UpNextSnapshot => ({
  generatedAt: 1,
  sections: [],
  repoCount: 1,
  fallback: null,
  failedRepoCount: 0,
  pullRequests,
});

afterEach(() => upNextUi.reset());

describe("PR keys", () => {
  test("never collide with issue keys and are recognisable", () => {
    expect(upNextPrKey(pr)).toBe("pr:/r/a#7");
    expect(upNextPrKey(pr)).not.toBe(upNextKey(pr));
    expect(isPrKey(upNextPrKey(pr))).toBe(true);
    expect(isPrKey(upNextKey(pr))).toBe(false);
  });
  test("find the live PR row for a key, or null once a refresh dropped it", () => {
    expect(findUpNextPr(snap([pr]), "pr:/r/a#7")).toBe(pr);
    expect(findUpNextPr(snap([]), "pr:/r/a#7")).toBeNull();
    expect(findUpNextPr(snap(), "pr:/r/a#7")).toBeNull();
    expect(findUpNextPr(null, "pr:/r/a#7")).toBeNull();
  });
});

test("an acted-on PR stays hidden until the server catches up, at most ACTED_HIDE_MS", () => {
  upNextUi.markActed("pr:/r/a#7", 1_000);
  expect(upNextUi.hidesActed("pr:/r/a#7", 1_000)).toBe(true);
  expect(upNextUi.hidesActed("pr:/r/a#7", 1_000 + ACTED_HIDE_MS - 1)).toBe(true);
  expect(upNextUi.hidesActed("pr:/r/a#7", 1_000 + ACTED_HIDE_MS)).toBe(false);
  expect(upNextUi.hidesActed("pr:/r/a#8", 1_000)).toBe(false);
  upNextUi.reset();
  expect(upNextUi.hidesActed("pr:/r/a#7", 1_000)).toBe(false);
});

test("a failed merge is remembered only for the head it failed on", () => {
  const at = (headSha?: string) => ({ ...pr, headSha });
  upNextUi.mergeFailed.set(upNextPrKey(pr), "abc");
  expect(upNextUi.mergeFailedAt(at("abc"))).toBe(true);
  expect(upNextUi.mergeFailedAt(at("def"))).toBe(false);
  expect(upNextUi.mergeFailedAt(at(undefined))).toBe(false);
  upNextUi.reset();
  expect(upNextUi.mergeFailedAt(at("abc"))).toBe(false);
});
