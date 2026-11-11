import { describe, it, expect } from "vitest";
import {
  shapeBlocker,
  shapeErrorKey,
  shapeRemainingMs,
  shapeTipIndex,
  shapeWait,
  SHAPE_ERRORS,
  SHAPE_TIMEOUT_MS,
  SHAPE_TIP_COUNT,
  type ShapeAvailability,
} from "./shape";

const ok: ShapeAvailability = {
  promptEmpty: false,
  repoResolved: true,
  mode: "code",
  running: false,
};

describe("shapeBlocker", () => {
  it("offers the round on a code task with a prompt and a resolved repo", () => {
    expect(shapeBlocker(ok)).toBeNull();
  });

  it("blocks on an empty prompt — there is nothing to shape", () => {
    expect(shapeBlocker({ ...ok, promptEmpty: true })).toBe("empty_prompt");
  });

  it("blocks without a repo — the round reads the repo to ground its questions", () => {
    expect(shapeBlocker({ ...ok, repoResolved: false })).toBe("no_repo");
  });

  it("blocks outside code mode (research has no brief; epic has its own shaping)", () => {
    expect(shapeBlocker({ ...ok, mode: "research" })).toBe("wrong_mode");
    expect(shapeBlocker({ ...ok, mode: "epic" })).toBe("wrong_mode");
  });

  it("blocks while a round is already running, ahead of every other reason", () => {
    expect(shapeBlocker({ ...ok, running: true, promptEmpty: true, mode: "epic" })).toBe("running");
  });
});

describe("shapeErrorKey", () => {
  it("passes every known slug through", () => {
    for (const e of SHAPE_ERRORS) expect(shapeErrorKey(e)).toBe(e);
  });

  it("collapses an unknown slug to timeout rather than inventing a state", () => {
    expect(shapeErrorKey("teapot")).toBe("timeout");
    expect(shapeErrorKey("")).toBe("timeout");
  });
});

describe("shapeWait", () => {
  it("reads as plain work for the first 45 s", () => {
    expect(shapeWait(0)).toBe("reading");
    expect(shapeWait(44_999)).toBe("reading");
  });

  it("reads as long from 45 s, and counts down from 2:30", () => {
    expect(shapeWait(45_000)).toBe("long");
    expect(shapeWait(149_999)).toBe("long");
    expect(shapeWait(150_000)).toBe("closing");
    expect(shapeWait(SHAPE_TIMEOUT_MS + 5_000)).toBe("closing");
  });
});

describe("shapeRemainingMs", () => {
  it("counts down to the server's deadline and never goes negative", () => {
    expect(shapeRemainingMs(0)).toBe(SHAPE_TIMEOUT_MS);
    expect(shapeRemainingMs(155_000)).toBe(25_000);
    expect(shapeRemainingMs(SHAPE_TIMEOUT_MS + 1)).toBe(0);
  });
});

describe("shapeTipIndex", () => {
  it("advances by itself every 7 s and wraps", () => {
    expect(shapeTipIndex(0, 0)).toBe(0);
    expect(shapeTipIndex(6_999, 0)).toBe(0);
    expect(shapeTipIndex(7_000, 0)).toBe(1);
    expect(shapeTipIndex(7_000 * SHAPE_TIP_COUNT, 0)).toBe(0);
  });

  it("follows the operator's paging in both directions", () => {
    expect(shapeTipIndex(0, 1)).toBe(1);
    expect(shapeTipIndex(0, -1)).toBe(SHAPE_TIP_COUNT - 1);
    expect(shapeTipIndex(7_000, -1)).toBe(0);
  });
});
