import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

type Step = { name?: string; run?: string; uses?: string };
type Workflow = {
  jobs?: Record<string, { uses?: string; steps?: Step[] }>;
  runs?: { steps?: Step[] };
};

const files = [
  ...readdirSync(".github/workflows")
    .filter((f) => f.endsWith(".yml"))
    .map((f) => `.github/workflows/${f}`),
  ...readdirSync(".github/actions").map((d) => `.github/actions/${d}/action.yml`),
];
const parse = (file: string) => Bun.YAML.parse(readFileSync(file, "utf8")) as Workflow;
const steps = (wf: Workflow) => [
  ...Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []),
  ...(wf.runs?.steps ?? []),
];

// #2107: a tag is mutable; a SHA is not. Dependabot bumps the SHA and its version comment together.
describe("actions pinned to commit SHAs", () => {
  test.each(files)("%s", (file) => {
    const wf = parse(file);
    const refs = [
      ...steps(wf).map((s) => s.uses),
      ...Object.values(wf.jobs ?? {}).map((j) => j.uses),
    ].filter((u): u is string => !!u && !u.startsWith("./"));
    const src = readFileSync(file, "utf8");
    for (const ref of refs) {
      expect(ref).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      expect(src).toMatch(
        new RegExp(`uses: ${ref.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} # \\S+`),
      );
    }
  });
});

// #2108: dispatch inputs reach the shell through env, never `${{ }}` spliced into the script.
test("eval-stop-classifier run steps interpolate no expressions", () => {
  const runs = steps(parse(".github/workflows/eval-stop-classifier.yml")).flatMap(
    (s) => s.run ?? [],
  );
  expect(runs.length).toBeGreaterThan(0);
  for (const run of runs) expect(run).not.toContain("${{");
});

// A push between the eligibility read and the merge must not be merged unchecked.
test("doc-automerge merges only the head it checked", () => {
  const run = steps(parse(".github/workflows/doc-automerge.yml"))
    .map((s) => s.run ?? "")
    .find((r) => r.includes("gh pr merge"))!;
  expect(run).toContain("headRefOid");
  expect(run).toMatch(/gh pr merge "\$n" [^\n]*--match-head-commit "\$head"/);
});
