import { test, expect } from "bun:test";
import { normalizeTelemetryConsent } from "../src/telemetry-consent";

test("accepts the three valid values", () => {
  expect(normalizeTelemetryConsent("unset")).toBe("unset");
  expect(normalizeTelemetryConsent("granted")).toBe("granted");
  expect(normalizeTelemetryConsent("denied")).toBe("denied");
});

test("rejects unknown / wrong-type values", () => {
  expect(normalizeTelemetryConsent("yes")).toBeNull();
  expect(normalizeTelemetryConsent("")).toBeNull();
  expect(normalizeTelemetryConsent(1)).toBeNull();
  expect(normalizeTelemetryConsent(null)).toBeNull();
  expect(normalizeTelemetryConsent(undefined)).toBeNull();
});
