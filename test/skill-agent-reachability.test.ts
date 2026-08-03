import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAgentIngressRoute } from "../src/server";

/**
 * #2009 — the shipped skills used to instruct the agent to `POST /api/epic/import` to wire an
 * epic's native sub-issue + blocked_by links. No spawned agent can reach that route: agents talk
 * to the server only through the restricted loopback ingress, whose allowlist is session-scoped,
 * and the repo-scoped import route is not on it (the main port answers 401). Both skills now hand
 * import to the operator instead.
 *
 * The assertion can't simply be "the path is absent" — the skills still SHOW it, inside the
 * command they print for the operator to run. So each skill must mention the path exactly once,
 * and that mention must sit under the `OPERATOR-RUN` sentinel marking it as the operator's to run.
 * Re-introducing an agent-facing call (a second mention, or an unmarked one) fails here.
 */
const OPERATOR_RUN_SENTINEL = "OPERATOR-RUN";
const IMPORT_PATH = "/api/epic/import";
/** How far above the mention the sentinel may sit — enough for the fence + a lead-in line. */
const SENTINEL_LOOKBACK_LINES = 6;

const SKILLS = ["shepherd-epic-authoring", "shepherd-onboarding"] as const;

function readSkill(name: string): string {
  return readFileSync(join(import.meta.dir, "..", ".claude", "skills", name, "SKILL.md"), "utf8");
}

describe("skills never instruct an agent-unreachable epic import (#2009)", () => {
  test("the ingress allowlist rejects the import route", () => {
    // The fact the skill text depends on. If someone ever admits import here, this fails and the
    // skills' Stage 4/5 handoff wording has to be revisited in the same change.
    expect(isAgentIngressRoute("POST", ["api", "epic", "import"])).toBe(false);
    // …and the session-scoped shape it can't take, for good measure.
    expect(isAgentIngressRoute("POST", ["api", "sessions", "abc", "epic-import"])).toBe(false);
  });

  for (const name of SKILLS) {
    describe(name, () => {
      const lines = readSkill(name).split("\n");
      const mentions = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => line.includes(IMPORT_PATH));

      test("mentions the import path exactly once", () => {
        expect(mentions.length).toBe(1);
      });

      test("that mention is marked OPERATOR-RUN", () => {
        expect(mentions.length).toBe(1);
        const at = mentions[0]!.i;
        const preceding = lines.slice(Math.max(0, at - SENTINEL_LOOKBACK_LINES), at);
        expect(preceding.some((l) => l.includes(OPERATOR_RUN_SENTINEL))).toBe(true);
      });
    });
  }
});
