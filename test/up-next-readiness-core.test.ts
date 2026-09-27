import { test, expect } from "bun:test";
import {
  NOT_READY_BELOW,
  READY_AT,
  band,
  interpretReadiness,
  readinessHash,
  readinessState,
} from "../src/up-next-readiness-core";

const item = { title: "Fix X", body: "Do Y.", labels: ["Bug", "p1"] };

test("state leads with the title and clips the body", () => {
  const s = readinessState({ ...item, body: "x".repeat(10_000) });
  expect(s.startsWith("Issue title: Fix X")).toBe(true);
  expect(s).toContain("Labels: bug, p1");
  expect(s.length).toBeLessThan(4200);
  expect(readinessState({ ...item, body: "  " })).toContain("Issue body: (empty)");
});

test("band edges", () => {
  expect(band(READY_AT)).toBe("ready");
  expect(band(READY_AT - 0.01)).toBe("maybe");
  expect(band(NOT_READY_BELOW)).toBe("maybe");
  expect(band(NOT_READY_BELOW - 0.01)).toBe("notReady");
  expect(band(null)).toBe("maybe");
  expect(band(0.55, 0.5, 0.2)).toBe("ready");
});

test("interpretReadiness rejects unusable answers", () => {
  expect(interpretReadiness({ type: "noul", p: 0.4 })).toBe(0.4);
  expect(interpretReadiness(undefined)).toBeNull();
  expect(interpretReadiness({ type: "choice", p: 0.4 })).toBeNull();
  expect(interpretReadiness({ type: "noul", p: 1.2 })).toBeNull();
  expect(interpretReadiness({ type: "noul", p: Number.NaN })).toBeNull();
  expect(interpretReadiness({ type: "noul", p: "0.4" })).toBeNull();
});

test("hash ignores label order/case/whitespace, not content or model", () => {
  const h = readinessHash("m1", item);
  expect(readinessHash("m1", { ...item, labels: ["P1", " bug"] })).toBe(h);
  expect(readinessHash("m1", { ...item, title: " Fix X " })).toBe(h);
  expect(readinessHash("m2", item)).not.toBe(h);
  expect(readinessHash("m1", { ...item, body: "Do Z." })).not.toBe(h);
  expect(readinessHash("m1", { ...item, labels: ["bug"] })).not.toBe(h);
});
