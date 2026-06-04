import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "..", "scripts", "check-feature-catalog.sh");
const CATALOG = "ui/src/lib/feature-announcements.ts";

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
function runGate(): { code: number; out: string } {
  const r = spawnSync("bash", [SCRIPT], {
    cwd: repo,
    env: { ...GIT_ENV, BASE_REF: "main" },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "shepherd-catalog-"));
  git("init", "-q", "-b", "main");
  // Seed main with the catalog so it exists pre-branch.
  writeRepoFile(CATALOG, "export const featureAnnouncements = [];\n");
  commit("chore: seed");
  git("checkout", "-q", "-b", "feature");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("feat + UI change without catalog entry → fails", () => {
  writeRepoFile("ui/src/lib/components/Widget.svelte", "<div>hi</div>\n");
  commit("feat(ui): add widget");
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("does NOT modify");
});

test("feat + UI change with catalog entry → passes", () => {
  writeRepoFile("ui/src/lib/components/Widget.svelte", "<div>hi</div>\n");
  writeRepoFile(CATALOG, "export const featureAnnouncements = [{ id: 'widget' }];\n");
  commit("feat(ui): add widget");
  const { code, out } = runGate();
  expect(code).toBe(0);
  expect(out).toContain("registered in");
});

test("feat touching ui/src/routes also requires the catalog", () => {
  writeRepoFile("ui/src/routes/+page.svelte", "<div>page</div>\n");
  commit("feat: new route");
  expect(runGate().code).toBe(1);
});

test("[no-feature-entry] opt-out skips the check loudly", () => {
  writeRepoFile("ui/src/lib/components/Widget.svelte", "<div>hi</div>\n");
  commit("feat(ui): add widget [no-feature-entry]");
  const { code, out } = runGate();
  expect(code).toBe(0);
  expect(out).toContain("SKIPPED");
  expect(out).toContain("[no-feature-entry]");
});

test("opt-out is branch-global: token on one commit disables the gate for the whole range", () => {
  // A real surfacing feat with no catalog entry...
  writeRepoFile("ui/src/lib/components/Widget.svelte", "<div>hi</div>\n");
  commit("feat(ui): add widget");
  // ...is still skipped because a LATER commit in the range carries the token.
  writeRepoFile("src/server.ts", "export const x = 1;\n");
  commit("feat(server): unrelated [no-feature-entry]");
  const { code, out } = runGate();
  expect(code).toBe(0);
  expect(out).toContain("SKIPPED");
});

test("opt-out token in commit body also works", () => {
  writeRepoFile("ui/src/lib/components/Widget.svelte", "<div>hi</div>\n");
  git("add", "-A");
  execFileSync(
    "git",
    ["commit", "-q", "-m", "feat(ui): add widget", "-m", "internal only [no-feature-entry]"],
    {
      cwd: repo,
      env: GIT_ENV,
    },
  );
  expect(runGate().code).toBe(0);
});

test("feat without user-facing UI change → passes (nothing to register)", () => {
  writeRepoFile("src/server.ts", "export const x = 1;\n");
  commit("feat(server): backend only");
  const { code, out } = runGate();
  expect(code).toBe(0);
  expect(out).toContain("no user-facing UI");
});

test("non-feat UI change → passes (no feat commit)", () => {
  writeRepoFile("ui/src/lib/components/Widget.svelte", "<div>fix</div>\n");
  commit("fix(ui): tweak widget");
  const { code, out } = runGate();
  expect(code).toBe(0);
  expect(out).toContain("no feat");
});

test("feat! breaking-change syntax is recognized", () => {
  writeRepoFile("ui/src/routes/+page.svelte", "<div>x</div>\n");
  commit("feat!: breaking ui change");
  expect(runGate().code).toBe(1);
});
