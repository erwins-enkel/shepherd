import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "..", "scripts", "check-generated-docs.sh");
// The one committed generated artifact the gate covers (the herdr CLI reference).
const SOURCE = "docs-site/scripts/gen-cli-reference.ts";
const OUTPUT = "docs-site/src/content/docs/reference/cli/status.md";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

let repo: string;

function git(...args: string[]) {
  execFileSync("git", args, { cwd: repo, env: GIT_ENV });
}

function writeRepoFile(rel: string, contents: string) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

/** Stage everything and commit with the given subject. */
function commit(subject: string) {
  git("add", "-A");
  execFileSync("git", ["commit", "-q", "-m", subject], { cwd: repo, env: GIT_ENV });
}

/** Run the gate with BASE_REF=main (no remote needed). Returns {code, out}. */
function runGate(base = "main"): { code: number; out: string } {
  const r = spawnSync("bash", [SCRIPT], {
    cwd: repo,
    env: { ...GIT_ENV, BASE_REF: base },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "shepherd-gendocs-"));
  git("init", "-q", "-b", "main");
  // Seed main with the generator source + its committed output so both pre-exist.
  writeRepoFile(SOURCE, "// gen-cli-reference v1\n");
  writeRepoFile(OUTPUT, "herdr status v1\n");
  commit("chore: seed");
  git("checkout", "-q", "-b", "feature");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("generator source changed WITHOUT regenerating output → fails", () => {
  writeRepoFile(SOURCE, "// gen-cli-reference v2 (bumped pin)\n");
  commit("feat(docs): bump herdr pin");
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("was NOT regenerated");
});

test("generator source changed WITH regenerated output → passes", () => {
  writeRepoFile(SOURCE, "// gen-cli-reference v2 (bumped pin)\n");
  writeRepoFile(OUTPUT, "herdr status v2\n");
  commit("feat(docs): bump herdr pin + regenerate CLI reference");
  const { code, out } = runGate();
  expect(code).toBe(0);
  expect(out).toContain("regenerated");
});

test("[skip-docs-regen] opt-out skips the check loudly", () => {
  writeRepoFile(SOURCE, "// gen-cli-reference v2 (comment only)\n");
  commit("docs: tweak a comment [skip-docs-regen]");
  const { code, out } = runGate();
  expect(code).toBe(0);
  expect(out).toContain("SKIPPED");
  expect(out).toContain("[skip-docs-regen]");
});

test("opt-out token in commit body also works", () => {
  writeRepoFile(SOURCE, "// gen-cli-reference v2 (comment only)\n");
  git("add", "-A");
  execFileSync(
    "git",
    ["commit", "-q", "-m", "docs: tweak generator", "-m", "comment only [skip-docs-regen]"],
    {
      cwd: repo,
      env: GIT_ENV,
    },
  );
  expect(runGate().code).toBe(0);
});

test("no generator-source change → passes (nothing to check)", () => {
  // Touch only the committed output (and an unrelated file) — never the generator.
  writeRepoFile(OUTPUT, "herdr status hand-tweaked\n");
  writeRepoFile("docs-site/README.md", "unrelated\n");
  commit("docs: unrelated edit");
  const { code, out } = runGate();
  expect(code).toBe(0);
  expect(out).toContain("nothing to check");
});

test("unrelated change elsewhere → passes (gate untouched)", () => {
  writeRepoFile("src/server.ts", "export const x = 1;\n");
  commit("feat(server): backend only");
  expect(runGate().code).toBe(0);
});

test("unresolvable base ref → fails closed (no silent vacuous pass)", () => {
  // A stale-output change that would otherwise sail through if base couldn't resolve.
  writeRepoFile(SOURCE, "// gen-cli-reference v2\n");
  commit("feat(docs): bump pin");
  const { code, out } = runGate("definitely-not-a-ref");
  expect(code).toBe(1);
  expect(out).toContain("could not be resolved");
});
