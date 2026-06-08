import { test, expect } from "bun:test";
import { buildPayload } from "../src/push";

test("autopilot payload: title names the session, body is the question summary", () => {
  const p = buildPayload(
    {
      kind: "autopilot",
      sessionId: "s1",
      tag: "s1",
      name: "login",
      summary: "Which auth provider?",
    },
    "en",
  );
  expect(p.kind).toBe("autopilot");
  expect(p.title).toContain("login");
  expect(p.body).toContain("Which auth provider?");
});

test("autopilot payload falls back when summary empty", () => {
  const p = buildPayload(
    { kind: "autopilot", sessionId: "s1", tag: "s1", name: "login", summary: "" },
    "de",
  );
  expect(p.title).toContain("login");
  expect(p.body.length).toBeGreaterThan(0);
});

test("autopilot-done payload: title reads complete, body is the summary", () => {
  const p = buildPayload(
    {
      kind: "autopilot-done",
      sessionId: "s1",
      tag: "s1",
      name: "research",
      summary: "Created issue #345.",
    },
    "en",
  );
  expect(p.kind).toBe("autopilot-done");
  expect(p.title).toContain("research");
  expect(p.title).toContain("complete");
  expect(p.body).toContain("Created issue #345.");
});

test("autopilot-done payload falls back when summary empty", () => {
  const p = buildPayload(
    { kind: "autopilot-done", sessionId: "s1", tag: "s1", name: "research", summary: "" },
    "de",
  );
  expect(p.title).toContain("research");
  expect(p.body.length).toBeGreaterThan(0);
});
