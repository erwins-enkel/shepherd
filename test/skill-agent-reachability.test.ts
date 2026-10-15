import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_SKILLS_DIR } from "../src/agent-skills";
import { isAgentIngressRoute } from "../src/server";

/**
 * #2009 — the shipped skills used to instruct the agent to `POST /api/epic/import` to wire an
 * epic's native sub-issue + blocked_by links. No spawned agent can reach that route: agents talk
 * to the server only through the restricted loopback ingress, whose allowlist is session-scoped,
 * and the repo-scoped import route is not on it (the main port answers 401). The onboarding skill
 * hands import to the operator instead. (shepherd-epic-authoring carried the same wording until
 * #2003 deleted it — its epic guidance now lives in EPIC_AUTHORING_NOTICE, which never mentions
 * import at all.)
 *
 * #3111 moved the skill to the shipped `agent-skills/` and onto the epic-draft path: the server
 * runs the import on approval, so the skill no longer needs to show the operator's command at all.
 *
 * The assertion can't simply be "the path is absent" — the skill still SHOWS it, inside the
 * command it prints for the operator to run. So the skill must mention the path exactly once,
 * and that mention must sit under the `OPERATOR-RUN` sentinel marking it as the operator's to run.
 * Re-introducing an agent-facing call (a second mention, or an unmarked one) fails here.
 */
const OPERATOR_RUN_SENTINEL = "OPERATOR-RUN";
const IMPORT_PATH = "/api/epic/import";
/** How far above the mention the sentinel may sit — enough for the fence + a lead-in line. */
const SENTINEL_LOOKBACK_LINES = 6;

const SKILLS = ["shepherd-onboarding"] as const;

function readSkill(name: string): string {
  return readFileSync(join(AGENT_SKILLS_DIR, ".claude", "skills", name, "SKILL.md"), "utf8");
}

describe("skills never instruct an agent-unreachable epic import (#2009)", () => {
  test("the ingress allowlist rejects the import route", () => {
    // The fact the skill text depends on. If someone ever admits import here, this fails and the
    // skill's Stage 5 handoff wording has to be revisited in the same change.
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

      test("every mention of the import path is marked OPERATOR-RUN", () => {
        for (const { i } of mentions) {
          const preceding = lines.slice(Math.max(0, i - SENTINEL_LOOKBACK_LINES), i);
          expect(preceding.some((l) => l.includes(OPERATOR_RUN_SENTINEL))).toBe(true);
        }
      });

      test("submits through epic_draft, never an agent-run `gh issue create` (#3111)", () => {
        const text = lines.join("\n");
        expect(text).toContain("`epic_draft` tool");
        const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
        expect(fenced.some((block) => block!.includes("gh issue create"))).toBe(false);
      });

      test("forbids versions in acceptance criteria (#3111)", () => {
        expect(lines.join("\n")).toContain("the pinned stack in CLAUDE.md");
      });
    });
  }
});
