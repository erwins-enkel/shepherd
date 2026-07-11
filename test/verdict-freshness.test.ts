import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { verdictStale, type VerdictGit } from "../src/verdict-freshness";

type ParityCase = {
  name: string;
  verdictHeadSha: string | null;
  git: VerdictGit | null;
  expected: boolean;
};

const cases = JSON.parse(
  readFileSync(new URL("./fixtures/verdict-stale-parity.json", import.meta.url), "utf8"),
) as ParityCase[];

describe("verdictStale (server) — shared parity fixture (server ↔ UI drift lock)", () => {
  // The SAME fixture is asserted by ui/src/lib/verdict-freshness.test.ts against the mirrored
  // UI helper; any drift between the two implementations fails one suite. Mirrors the
  // MERGE_MARK_BACKSTOP_MS / plan-question-parity.json lock.
  for (const c of cases) {
    test(c.name, () => {
      expect(verdictStale(c.verdictHeadSha, c.git)).toBe(c.expected);
    });
  }
});
