import { expect, test } from "bun:test";
import { planReviewPrompt, reviewerArgv, PLAN_VERDICT_FILE } from "../src/plan-gate";

test("prompt embeds task + plan + prior findings + verdict file + read-only", () => {
  const p = planReviewPrompt("do X", "PLAN TEXT", ["earlier nit"]);
  expect(p).toContain("do X");
  expect(p).toContain("PLAN TEXT");
  expect(p).toContain("earlier nit");
  expect(p).toContain(PLAN_VERDICT_FILE);
  expect(p.toLowerCase()).toContain("read-only");
});
test("prompt without prior findings omits the re-review block", () => {
  const p = planReviewPrompt("do X", "PLAN TEXT");
  expect(p).not.toContain("RE-REVIEW");
});
test("reviewerArgv mirrors critic hardening: dontAsk last, no --bare, disableAllHooks, slash disabled", () => {
  const a = reviewerArgv(null, "PROMPT");
  expect(a).not.toContain("--bare");
  expect(a).toContain("--disable-slash-commands");
  expect(a.join(" ")).toContain('{"disableAllHooks":true}');
  const dontAsk = a.indexOf("dontAsk");
  expect(dontAsk).toBeGreaterThan(-1);
  expect(a[dontAsk - 1]).toBe("--permission-mode");
  expect(a[a.length - 1]).toBe("PROMPT");
  const tools = a.indexOf("--allowedTools");
  expect(tools).toBeGreaterThan(-1);
  expect(tools).toBeLessThan(dontAsk);
});
test("reviewerArgv inserts --model when given", () => {
  const a = reviewerArgv("opus", "PROMPT");
  const mi = a.indexOf("--model");
  expect(mi).toBeGreaterThan(-1);
  expect(a[mi + 1]).toBe("opus");
  expect(a[a.length - 1]).toBe("PROMPT"); // prompt still trailing
});
