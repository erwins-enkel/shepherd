import { describe, it, expect } from "vitest";
import {
  hintApplies,
  shapeBlocker,
  shapeOffered,
  verdictMissing,
  verdictStyle,
  HINT_MIN_CHARS,
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

  it("offers the round in epic mode too", () => {
    expect(shapeBlocker({ ...ok, mode: "epic" })).toBeNull();
  });

  it("blocks in the modes that take no brief", () => {
    expect(shapeBlocker({ ...ok, mode: "research" })).toBe("wrong_mode");
    expect(shapeBlocker({ ...ok, mode: "plain" })).toBe("wrong_mode");
    expect(shapeBlocker({ ...ok, mode: "bootstrap" })).toBe("wrong_mode");
  });

  it("blocks while a round is already running, ahead of every other reason", () => {
    expect(shapeBlocker({ ...ok, running: true, promptEmpty: true, mode: "epic" })).toBe("running");
  });
});

describe("shapeOffered", () => {
  it("offers Shape in code and epic mode only", () => {
    expect(shapeOffered("code")).toBe(true);
    expect(shapeOffered("epic")).toBe(true);
    expect(shapeOffered("research")).toBe(false);
    expect(shapeOffered("plain")).toBe(false);
    expect(shapeOffered("bootstrap")).toBe(false);
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

describe("hintApplies", () => {
  const base = {
    prompt: "x".repeat(HINT_MIN_CHARS),
    repoResolved: true,
    mode: "code" as const,
    shapeIdle: true,
    mobile: false,
  };
  it("asks for a long enough prompt where Shape could run", () => {
    expect(hintApplies(base)).toBe(true);
  });
  it("skips short prompts, measured trimmed", () => {
    expect(hintApplies({ ...base, prompt: `  ${"x".repeat(HINT_MIN_CHARS - 1)}  ` })).toBe(false);
  });
  it("asks in epic mode, where Shape runs too", () => {
    expect(hintApplies({ ...base, mode: "epic" })).toBe(true);
  });
  it("skips where Shape is not offered, without a repo, and while Shape owns the slot", () => {
    expect(hintApplies({ ...base, mode: "research" })).toBe(false);
    expect(hintApplies({ ...base, repoResolved: false })).toBe(false);
    expect(hintApplies({ ...base, shapeIdle: false })).toBe(false);
    expect(hintApplies({ ...base, mobile: true })).toBe(false);
  });
});

describe("verdict helpers", () => {
  it("keeps known styles only", () => {
    expect(verdictStyle("prescribing")).toBe("prescribing");
    expect(verdictStyle("describing")).toBe("describing");
    expect(verdictStyle("vague")).toBeNull();
  });
  it("orders known missing entries and drops unknown ones", () => {
    expect(verdictMissing(["acceptance", "new-thing", "symptom"])).toEqual([
      "symptom",
      "acceptance",
    ]);
    expect(verdictMissing([])).toEqual([]);
  });
});
