import { expect, test } from "bun:test";
import { buildAssistantHandoff } from "../src/operator-assistant-handoff";

test("handoff preserves recent operator context with a hard size bound and data fences", () => {
  const messages = Array.from({ length: 40 }, (_, n) => ({
    role: "user" as const,
    text: `turn ${n} ${"x".repeat(2000)}`,
    ts: n,
  }));
  const text = buildAssistantHandoff(messages);
  expect(text.length).toBeLessThanOrEqual(24_000);
  expect(text).toContain("turn 39");
  expect(text).not.toContain("turn 0 ");
  expect(text).toContain("truncated");
  expect(text).toContain("⟦UNTRUSTED:");
});
