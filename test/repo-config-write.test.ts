import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { RepoConfigService } from "../src/repo-config-service";
import { invalidateRepoConfigFile, REPO_RULE_FIELDS } from "../src/repo-config-file";
import { configRepo, git } from "./helpers/repo-config-git";

const repos: ReturnType<typeof configRepo>[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
});
function fixture() {
  const r = configRepo();
  repos.push(r);
  const store = new SessionStore(":memory:");
  const svc = new RepoConfigService(store, () => "standard");
  return { r, store, svc };
}
function tip(r: ReturnType<typeof configRepo>) {
  return git(r.origin, "rev-parse", "main");
}

test("multi-rule patch creates one default commit without touching branch, index or dirty files; seeds all rules", async () => {
  const { r, store, svc } = fixture();
  store.setRepoConfig(r.b, { ...store.getRepoConfig(r.b), criticAllPrs: true, maxAuto: 9 });
  git(r.b, "switch", "-c", "feature");
  writeFileSync(join(r.b, "README"), "staged\n");
  git(r.b, "add", "README");
  writeFileSync(join(r.b, "README"), "unstaged\n");
  writeFileSync(join(r.b, "untracked"), "keep\n");
  const head = git(r.b, "rev-parse", "HEAD");
  const index = readFileSync(join(r.b, ".git/index"));
  const status = git(r.b, "status", "--porcelain");
  const result = await svc.patch(
    r.b,
    { autoDrainEnabled: true, defaultEffort: "high", maxAuto: 4 },
    { automationConfirmed: true },
  );
  expect(result.ok).toBe(true);
  expect(git(r.origin, "rev-list", "--count", `${head}..main`)).toBe("1");
  expect(git(r.origin, "diff-tree", "--no-commit-id", "--name-only", "-r", "main")).toBe(
    ".shepherd/config.json",
  );
  expect(git(r.origin, "log", "-1", "--format=%s")).toBe("chore(shepherd): set repo rules");
  const rules = JSON.parse(git(r.origin, "show", "main:.shepherd/config.json"));
  expect(Object.keys(rules).sort()).toEqual([...REPO_RULE_FIELDS].sort());
  expect(rules).toMatchObject({
    criticAllPrs: true,
    autoDrainEnabled: true,
    defaultEffort: "high",
  });
  expect(store.getLocalRepoConfig(r.b)).toMatchObject({
    autoDrainEnabled: false,
    maxAuto: 4,
    criticAllPrs: true,
  });
  expect(store.isAutomationConfirmed(r.b)).toBe(true);
  expect(store.getRepoConfig(r.b).autoDrainEnabled).toBe(true);
  expect(git(r.b, "rev-parse", "HEAD")).toBe(head);
  expect(git(r.b, "branch", "--show-current")).toBe("feature");
  expect(readFileSync(join(r.b, ".git/index"))).toEqual(index);
  expect(git(r.b, "status", "--porcelain")).toBe(status);
  expect(readFileSync(join(r.b, "README"), "utf8")).toBe("unstaged\n");
  expect(readFileSync(join(r.b, "untracked"), "utf8")).toBe("keep\n");
});

test("machine-only patches never commit or copy repo rules into DB, including no-origin repos", async () => {
  const { r, store, svc } = fixture();
  const initial = tip(r);
  await svc.patch(r.b, { maxAuto: 5, previewOpenMode: "tab" });
  expect(tip(r)).toBe(initial);
  r.commit('{"criticEnabled":false}');
  invalidateRepoConfigFile(r.b);
  git(r.b, "fetch", "origin");
  const withFile = tip(r);
  await svc.patch(r.b, { hidden: true });
  expect(tip(r)).toBe(withFile);
  expect(store.getLocalRepoConfig(r.b).criticEnabled).toBe(true);
  git(r.b, "remote", "remove", "origin");
  invalidateRepoConfigFile(r.b);
  expect((await svc.patch(r.b, { autoDrainEnabled: true })).ok).toBe(true);
  expect(store.getLocalRepoConfig(r.b).autoDrainEnabled).toBe(true);
  expect(tip(r)).toBe(withFile);
});

test("push rejection leaves mixed local patch and automation metadata unchanged and returns sanitized error", async () => {
  const { r, store, svc } = fixture();
  writeFileSync(join(r.origin, "hooks/pre-receive"), "#!/bin/sh\necho secret-token >&2\nexit 1\n", {
    mode: 0o755,
  });
  const before = tip(r),
    local = store.getLocalRepoConfig(r.b);
  const result = await svc.patch(
    r.b,
    { autoDrainEnabled: true, maxAuto: 8 },
    { automationConfirmed: true },
  );
  expect(result).toMatchObject({ ok: false, code: "repo_config_write_failed" });
  expect(JSON.stringify(result)).not.toContain("secret-token");
  expect(tip(r)).toBe(before);
  expect(store.getLocalRepoConfig(r.b)).toEqual(local);
  expect(store.isAutomationConfirmed(r.b)).toBe(false);
  expect(store.automationRowExists(r.b)).toBe(false);
  expect(store.getRepoConfig(r.b).autoDrainEnabled).toBe(false);
});

test("cross-field validation uses fresh remote view and does not change DB or remote on rejection", async () => {
  const { r, store, svc } = fixture();
  svc.read(r.b); // cache absence, then another instance changes the rules
  r.commit('{"draftMode":true,"criticEnabled":false,"signoffAuthority":"human"}');
  const before = tip(r);
  const rejected = await svc.patch(r.b, { autoMergeEnabled: true, maxAuto: 9 });
  expect(rejected).toMatchObject({
    ok: false,
    error: "draftMode and autoMergeEnabled are mutually exclusive",
  });
  expect(tip(r)).toBe(before);
  expect(store.getLocalRepoConfig(r.b).maxAuto).toBe(1);
  const critic = await svc.patch(r.b, { signoffAuthority: "critic" });
  expect(critic.ok).toBe(false);
  expect(tip(r)).toBe(before);
});

test("fresh fetch preserves external rules; concurrent patches serialize and preserve intervening local preview writes", async () => {
  const { r, store, svc } = fixture();
  svc.read(r.b);
  r.commit('{"criticAllPrs":true}');
  const first = svc.patch(r.b, { autoDrainEnabled: true, maxAuto: 2 });
  store.setRepoConfig(r.b, { ...store.getLocalRepoConfig(r.b), previewStartCommand: "bun dev" });
  const second = svc.patch(r.b, { planGateEnabled: true });
  expect((await first).ok).toBe(true);
  expect((await second).ok).toBe(true);
  expect(store.getRepoConfig(r.b)).toMatchObject({
    criticAllPrs: true,
    autoDrainEnabled: true,
    planGateEnabled: true,
    maxAuto: 2,
    previewStartCommand: "bun dev",
  });
  expect(git(r.origin, "rev-list", "--count", "main")).toBe("4");
});

test("a competing remote commit rejects our push instead of being overwritten", async () => {
  const { r, store } = fixture();
  const { writeRepoConfigFile, repoRulesFromConfig } = await import("../src/repo-config-file");
  const base = tip(r);
  const tree = git(r.origin, "rev-parse", "main^{tree}");
  const competing = git(
    r.origin,
    "-c",
    "user.name=Other",
    "-c",
    "user.email=other@example.test",
    "commit-tree",
    tree,
    "-p",
    base,
    "-m",
    "competing",
  );
  await expect(
    writeRepoConfigFile(r.b, () => {
      git(r.origin, "update-ref", "refs/heads/main", competing, base);
      return repoRulesFromConfig(store.getRepoConfig(r.b));
    }),
  ).rejects.toThrow();
  expect(tip(r)).toBe(competing);
});

test("switching from lightweight validates the newly active file view", async () => {
  const { r, store, svc } = fixture();
  r.commit('{"draftMode":true,"autoMergeEnabled":true}');
  git(r.b, "fetch", "origin");
  invalidateRepoConfigFile(r.b);
  store.setRepoConfig(r.b, { ...store.getLocalRepoConfig(r.b), repoMode: "lightweight" });
  const result = await svc.patch(r.b, { repoMode: "forge" });
  expect(result.ok).toBe(false);
  expect(store.getLocalRepoConfig(r.b).repoMode).toBe("lightweight");
});

test("a newly active file is not overwritten by stale local CLI clamping", async () => {
  const { r, store, svc } = fixture();
  r.commit('{"defaultModel":"opus"}'); // service refreshes after the route cached absence
  const result = await svc.patch(
    r.b,
    { autoDrainEnabled: true, agentProvider: "codex" },
    { localRunDefaults: { defaultModel: "inherit" } },
  );
  expect(result.ok).toBe(true);
  expect(store.getRepoConfig(r.b).defaultModel).toBe("opus");
});
