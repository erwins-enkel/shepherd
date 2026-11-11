import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configRepo, git } from "./helpers/repo-config-git";
import { configForge } from "./helpers/repo-config-forge";
import {
  REPO_RULE_DEFAULTS,
  readRepoConfigFile,
  withRepoConfigLock,
} from "../src/repo-config-file";
import { saveRepoConfigRules, REPO_CONFIG_PR_BRANCH } from "../src/repo-config-pr";

const repos: ReturnType<typeof configRepo>[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});
function fixture(branch = "main") {
  const r = configRepo(undefined, branch);
  repos.push(r);
  writeFileSync(
    join(r.origin, "hooks/pre-receive"),
    `#!/bin/sh\nwhile read old new ref; do\n if [ "$ref" = "refs/heads/${branch}" ]; then echo 'protected branch' >&2; exit 1; fi\ndone\n`,
    { mode: 0o755 },
  );
  return {
    r,
    ...configForge(() => {
      try {
        git(r.origin, "rev-parse", "--verify", `refs/heads/${REPO_CONFIG_PR_BRANCH}`);
        return true;
      } catch {
        return false;
      }
    }),
  };
}
const defaults = (file: { rules: object } | null) => ({ ...REPO_RULE_DEFAULTS, ...file?.rules });
const save = (
  r: ReturnType<typeof configRepo>,
  dir: string,
  forge: ReturnType<typeof configForge>["forge"],
  patch: object,
) =>
  withRepoConfigLock(dir, () =>
    saveRepoConfigRules(dir, forge, (file) => ({ ...defaults(file), ...patch })),
  );

test("protected default creates one config-only PR; second clone edits reuse it and preserve pending rules", async () => {
  const { r, forge, opened, edited } = fixture("trunk");
  git(r.b, "switch", "-c", "feature");
  writeFileSync(join(r.b, "README"), "staged\n");
  git(r.b, "add", "README");
  writeFileSync(join(r.b, "README"), "dirty\n");
  const index = readFileSync(join(r.b, ".git/index"));
  const head = git(r.b, "rev-parse", "HEAD");
  const first = await save(r, r.b, forge, { criticAllPrs: true });
  expect(first).toMatchObject({
    kind: "pr",
    pending: { number: 41, changes: { criticAllPrs: true } },
  });
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({
    base: "trunk",
    title: "chore(shepherd): set repo rules",
    head: REPO_CONFIG_PR_BRANCH,
  });
  expect(opened[0]!.body).toContain("criticAllPrs");
  expect(readRepoConfigFile(r.b)).toBeNull();
  const second = await save(r, r.a, forge, { planGateEnabled: true });
  expect(second).toMatchObject({
    kind: "pr",
    pending: { changes: { criticAllPrs: true, planGateEnabled: true } },
  });
  expect(opened).toHaveLength(1);
  expect(edited.at(-1)!.body).toContain("criticAllPrs");
  expect(edited.at(-1)!.body).toContain("planGateEnabled");
  expect(git(r.origin, "diff", "--name-only", "trunk", REPO_CONFIG_PR_BRANCH)).toBe(
    ".shepherd/config.json",
  );
  expect(git(r.b, "rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(r.b, ".git/index"))).toEqual(index);
  expect(readFileSync(join(r.b, "README"), "utf8")).toBe("dirty\n");
  const tip = git(r.origin, "rev-parse", REPO_CONFIG_PR_BRANCH);
  await save(r, r.a, forge, { planGateEnabled: true });
  expect(opened).toHaveLength(1);
  expect(git(r.origin, "rev-parse", REPO_CONFIG_PR_BRANCH)).toBe(tip);
});

test("a stale writer cannot replace another machine's proposal", async () => {
  const { r, forge } = fixture();
  await save(r, r.b, forge, { criticAllPrs: true });
  await expect(
    withRepoConfigLock(r.b, () =>
      saveRepoConfigRules(r.b, forge, (file) => {
        const prior = git(r.origin, "rev-parse", REPO_CONFIG_PR_BRANCH);
        git(r.a, "fetch", "origin", REPO_CONFIG_PR_BRANCH);
        const competing = git(
          r.a,
          "commit-tree",
          git(r.origin, "rev-parse", `${prior}^{tree}`),
          "-p",
          prior,
          "-m",
          "other writer",
        );
        git(r.a, "push", "origin", `${competing}:refs/heads/${REPO_CONFIG_PR_BRANCH}`);
        return { ...defaults(file), planGateEnabled: true };
      }),
    ),
  ).rejects.toThrow();
  expect(git(r.origin, "log", "-1", "--format=%s", REPO_CONFIG_PR_BRANCH)).toBe("other writer");
});

test("ambiguous PR create is recovered by querying the same head", async () => {
  const { r, forge, opened, setState } = fixture();
  forge.openPr = async (input) => {
    opened.push(input);
    setState("open");
    throw new Error("timeout");
  };
  expect(await save(r, r.b, forge, { criticEnabled: false })).toMatchObject({
    kind: "pr",
    pending: { number: 41 },
  });
  expect(opened).toHaveLength(1);
});

test("reverting every draft change closes the PR without changing the default", async () => {
  const { r, forge } = fixture();
  await save(r, r.b, forge, { criticEnabled: false });
  expect(await save(r, r.b, forge, { criticEnabled: true })).toMatchObject({ kind: "unchanged" });
  expect((await forge.prStatus(REPO_CONFIG_PR_BRANCH)).state).toBe("closed");
  expect(readRepoConfigFile(r.b)).toBeNull();
});

test("pending deltas preserve unrelated rules merged into default", async () => {
  const { r, forge } = fixture();
  await save(r, r.b, forge, { criticAllPrs: true });
  // An administrator lands an unrelated rule while the proposal waits.
  writeFileSync(join(r.origin, "hooks/pre-receive"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  r.commit('{"autoLabel":"ready"}');
  const result = await save(r, r.b, forge, { planGateEnabled: true });
  expect(result).toMatchObject({
    kind: "pr",
    pending: { changes: { criticAllPrs: true, planGateEnabled: true } },
  });
  expect(result.kind === "pr" && result.pending.changes.autoLabel).toBeUndefined();
  expect(
    JSON.parse(git(r.origin, "show", `${REPO_CONFIG_PR_BRANCH}:.shepherd/config.json`)).autoLabel,
  ).toBe("ready");
});

test("failed publication can recover the branch draft on the next save", async () => {
  const { r, forge, opened } = fixture();
  const open = forge.openPr;
  forge.openPr = async () => {
    throw new Error("forge unavailable");
  };
  await expect(save(r, r.b, forge, { criticAllPrs: true })).rejects.toThrow();
  forge.openPr = open;
  const result = await save(r, r.a, forge, { planGateEnabled: true });
  expect(result).toMatchObject({
    kind: "pr",
    pending: { changes: { criticAllPrs: true, planGateEnabled: true } },
  });
  expect(opened).toHaveLength(1);
});

test("explicit null clears a pending leader change", async () => {
  const { r, forge } = fixture();
  await save(r, r.b, forge, { leitrechner: "11111111-1111-4111-8111-111111111111" });
  expect(await save(r, r.b, forge, { leitrechner: null })).toMatchObject({ kind: "unchanged" });
});

test("cancelling a stale draft cannot close a successfully updated proposal", async () => {
  const { r, forge } = fixture();
  await save(r, r.b, forge, { criticAllPrs: true });
  const { buildRepoConfigCommit } = await import("../src/repo-config-file");
  const competing = await buildRepoConfigCommit(r.a, git(r.origin, "rev-parse", "main"), {
    ...REPO_RULE_DEFAULTS,
    criticAllPrs: true,
    planGateEnabled: true,
  });
  await expect(
    withRepoConfigLock(r.b, () =>
      saveRepoConfigRules(r.b, forge, () => {
        git(
          r.a,
          "push",
          "--force",
          "origin",
          `${competing.commit}:refs/heads/${REPO_CONFIG_PR_BRANCH}`,
        );
        return { ...REPO_RULE_DEFAULTS };
      }),
    ),
  ).rejects.toThrow();
  expect((await forge.prStatus(REPO_CONFIG_PR_BRANCH)).state).toBe("open");
  expect(git(r.origin, "rev-parse", REPO_CONFIG_PR_BRANCH)).toBe(competing.commit);
});

test("cancelling an unpublished draft prevents a later save resurrecting its rules", async () => {
  const { r, forge } = fixture();
  const open = forge.openPr;
  forge.openPr = async () => {
    throw new Error("unavailable");
  };
  await expect(save(r, r.b, forge, { criticAllPrs: true })).rejects.toThrow();
  await save(r, r.b, forge, { criticAllPrs: false });
  forge.openPr = open;
  const saved = await save(r, r.b, forge, { planGateEnabled: true });
  expect(saved).toMatchObject({ kind: "pr", pending: { changes: { planGateEnabled: true } } });
  expect(saved.kind === "pr" && saved.pending.changes.criticAllPrs).toBeUndefined();
});

test("fork rejection never opens an upstream PR", async () => {
  const { r, forge, opened } = fixture();
  Object.assign(forge, { isFork: true });
  await expect(save(r, r.b, forge, { criticAllPrs: true })).rejects.toThrow();
  expect(opened).toHaveLength(0);
  expect(git(r.origin, "ls-tree", "main", ".shepherd/config.json")).toBe("");
  expect(
    git(r.origin, "for-each-ref", "--format=%(refname)", `refs/heads/${REPO_CONFIG_PR_BRANCH}`),
  ).toBe("");
});
