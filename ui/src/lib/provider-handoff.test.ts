import { expect, it } from "vitest";
import { replaceRequestId, settleReplaceRequest } from "./provider-handoff";

it("retains identity across transport retries but not a changed or completed action", () => {
  const choice = { agentProvider: "codex" as const, model: null };
  const id = replaceRequestId("s", choice);
  expect(replaceRequestId("s", { ...choice })).toBe(id);
  const changed = replaceRequestId("s", { ...choice, handoffMode: "summarize" });
  expect(changed).not.toBe(id);
  settleReplaceRequest("s", id);
  expect(replaceRequestId("s", { ...choice, handoffMode: "summarize" })).toBe(changed);
  settleReplaceRequest("s", changed);
  expect(replaceRequestId("s", { ...choice, handoffMode: "summarize" })).not.toBe(changed);
});
