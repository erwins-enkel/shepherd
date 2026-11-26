import { describe, expect, it } from "vitest";
import { ApiError } from "#lib/api.js";
import { askOutcomeText, classifyAskFailure, newAskRequestId } from "#lib/ask-answer-outcome.js";
import { m } from "#lib/paraglide/messages.js";

const api = (status: number, error: string, code?: string) =>
  new ApiError(status, error, code, true);

describe("classifyAskFailure (#4219)", () => {
  it.each([
    [api(409, "ask_not_open", "ask_not_open"), "stale"],
    [api(409, "ask_in_flight", "ask_in_flight"), "in_flight"],
    [api(409, "ask_interrupted", "ask_interrupted"), "interrupted"],
    // An older server: the code rides only in `error`.
    [api(409, "ask_not_open"), "stale"],
    [api(409, "remote_unsupported", "remote_unsupported"), "refused"],
    [new ApiError(409, "answer-ask failed: 409"), "refused"],
    [api(400, "invalid answers"), "invalid"],
    [api(404, "not found"), "gone"],
    [api(401, "unauthorized"), "refused"],
    [api(500, "boom"), "unknown"],
    [api(502, "machine_unreachable", "machine_unreachable"), "unknown"],
    [new TypeError("Load failed"), "unknown"],
    [new Error("anything"), "unknown"],
    ["weird", "unknown"],
  ] as const)("%o → %s", (err, kind) => {
    expect(classifyAskFailure(err)).toBe(kind);
  });
});

describe("askOutcomeText", () => {
  it("adds the ref to every outcome but a confirmed delivery", () => {
    expect(askOutcomeText("verified", "ab12cd34")).toBe(m.ask_result_verified());
    for (const o of ["mismatch", "unverified", "stale", "interrupted", "unknown"] as const)
      expect(askOutcomeText(o, "ab12cd34")).toContain("ab12cd34");
    expect(askOutcomeText("stale", "r")).not.toBe(askOutcomeText("unknown", "r"));
    expect(askOutcomeText("interrupted", "r")).not.toBe(askOutcomeText("unknown", "r"));
  });
});

describe("newAskRequestId", () => {
  it("is 8 hex chars the server accepts", () => {
    const a = newAskRequestId();
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(newAskRequestId()).not.toBe(a);
  });
});
