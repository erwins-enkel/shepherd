import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Step = { name?: string; run?: string; "timeout-minutes"?: unknown };
const ci = Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
  jobs: Record<string, { "timeout-minutes"?: unknown; steps: Step[] }>;
};

// #2887: a hung step otherwise runs to GitHub's 6h default, blocking the critic and merge train.
describe("ci.yml timeouts", () => {
  test.each(Object.keys(ci.jobs))("job %s has timeout-minutes", (name) => {
    const minutes = ci.jobs[name]!["timeout-minutes"];
    expect(typeof minutes).toBe("number");
    expect(minutes as number).toBeGreaterThan(0);
  });

  test("Playwright install steps have their own timeout", () => {
    const installs = Object.values(ci.jobs).flatMap((job) =>
      job.steps.filter((step) => step.run?.includes("playwright install")),
    );
    expect(installs.length).toBeGreaterThan(0);
    for (const step of installs) expect(step["timeout-minutes"]).toBe(10);
  });
});
