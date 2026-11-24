import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { addressStallStatus, type AddressStallStatus } from "./review-status";
import type { ReviewVerdict } from "./types";

const NOW = 1_000_000_000_000;

type ParityCase = {
  name: string;
  addressRound: number;
  addressCap: number;
  findings: string[];
  finalRoundPending: boolean;
  finalRoundTimeoutMs: number;
  ageMs: number;
  expected: AddressStallStatus;
};

describe("addressStallStatus (UI) — shared parity fixture (server ↔ UI drift lock)", () => {
  // The SAME fixture is asserted by test/review-status.test.ts against the server copy; drift
  // between the two implementations fails one suite.
  const cases = JSON.parse(
    readFileSync(
      new URL("../../../test/fixtures/review-status-parity.json", import.meta.url),
      "utf8",
    ),
  ) as ParityCase[];
  for (const { name, ageMs, expected, ...fields } of cases) {
    test(name, () => {
      const v: ReviewVerdict = {
        sessionId: "s1",
        headSha: "abc123",
        decision: "changes_requested",
        summary: "",
        body: "",
        ...fields,
        updatedAt: NOW - ageMs,
      };
      expect(addressStallStatus(v, NOW)).toBe(expected);
    });
  }
});
