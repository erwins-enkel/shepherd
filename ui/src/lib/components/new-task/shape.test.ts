import { describe, it, expect } from "vitest";
import { shapeBlocker, shapeErrorKey, SHAPE_ERRORS, type ShapeAvailability } from "./shape";

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
