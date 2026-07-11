import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { verdictStale, type VerdictGit } from "./verdict-freshness";

type ParityCase = {
  name: string;
  verdictHeadSha: string | null;
  git: VerdictGit | null;
  expected: boolean;
};

describe("verdictStale (UI) — shared parity fixture (server ↔ UI drift lock)", () => {
  // The SAME fixture is asserted by test/verdict-freshness.test.ts against the server helper;
  // any drift between the two implementations fails one suite. Mirrors the
  // MERGE_MARK_BACKSTOP_MS / plan-question-parity.json lock.
  const cases = JSON.parse(
    readFileSync(
      new URL("../../../test/fixtures/verdict-stale-parity.json", import.meta.url),
      "utf8",
    ),
  ) as ParityCase[];
  for (const c of cases) {
    test(c.name, () => {
      expect(verdictStale(c.verdictHeadSha, c.git)).toBe(c.expected);
    });
  }
});
