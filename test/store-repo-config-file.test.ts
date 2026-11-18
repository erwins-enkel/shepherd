import { afterEach, expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import { invalidateRepoConfigFile } from "../src/repo-config-file";
import { configRepo, git } from "./helpers/repo-config-git";

const repos: ReturnType<typeof configRepo>[] = [];
const stores: SessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s["db"].close();
  for (const r of repos.splice(0)) r.close();
});
function fixture() {
  const r = configRepo();
  repos.push(r);
  const a = new SessionStore(":memory:"),
    b = new SessionStore(":memory:");
  stores.push(a, b);
  a.setRepoConfig(r.a, { ...a.getRepoConfig(r.a), criticEnabled: false, maxAuto: 3 });
  b.setRepoConfig(r.b, { ...b.getRepoConfig(r.b), criticAllPrs: true, maxAuto: 7 });
  return { r, a, b };
}

test("no file and invalid file preserve local behavior; a valid partial file resets omitted rules to defaults", () => {
  const { r, a } = fixture();
  expect(a.getRepoConfig(r.a).criticEnabled).toBe(false);
  r.commit("bad json");
  invalidateRepoConfigFile(r.a);
  expect(a.getRepoConfig(r.a).criticEnabled).toBe(false);
  r.commit('{"autoDrainEnabled":true,"sandboxProfile":"trusted","maxAuto":90}');
  invalidateRepoConfigFile(r.a);
  expect(a.getRepoConfig(r.a)).toMatchObject({
    criticEnabled: true,
    autoDrainEnabled: true,
    maxAuto: 3,
    sandboxProfile: "inherit",
  });
  expect(a.getLocalRepoConfig(r.a).criticEnabled).toBe(false);
});

test("two independent instances share fetched rules but retain machine values and inherit", () => {
  const { r, a, b } = fixture();
  r.commit('{"autoDrainEnabled":true,"defaultModel":"inherit","defaultEffort":"inherit"}');
  git(r.b, "fetch", "origin");
  invalidateRepoConfigFile(r.a);
  invalidateRepoConfigFile(r.b);
  for (const [s, path, maxAuto] of [
    [a, r.a, 3],
    [b, r.b, 7],
  ] as const)
    expect(s.getRepoConfig(path)).toMatchObject({
      criticEnabled: true,
      criticAllPrs: false,
      autoDrainEnabled: true,
      defaultModel: "inherit",
      defaultEffort: "inherit",
      maxAuto,
    });
  a.setRepoConfig(r.a, { ...a.getLocalRepoConfig(r.a), repoMode: "lightweight" });
  expect(a.getRepoConfig(r.a).criticEnabled).toBe(false);
});

test("automation and run-default summaries use file values, including repos without DB rows", () => {
  const r = configRepo();
  repos.push(r);
  const store = new SessionStore(":memory:");
  stores.push(store);
  r.commit('{"autoDrainEnabled":true,"defaultModel":"opus"}');
  expect(store.automationRowExists(r.a)).toBe(false);
  expect(store.warmAutomationRepoPaths([r.a])).toEqual(new Set([r.a]));
  expect(store.reposWithOwnRunDefaults([r.a])).toEqual([
    {
      repoPath: r.a,
      agentProvider: "inherit",
      defaultModel: "opus",
      defaultEffort: "inherit",
      defaultExecutionEffort: "inherit",
    },
  ]);
  store.setRepoConfig(r.a, {
    ...store.getLocalRepoConfig(r.a),
    autoDrainEnabled: true,
    criticAllPrs: true,
    defaultModel: "opus",
  });
  r.commit("{}");
  invalidateRepoConfigFile(r.a);
  expect(store.warmAutomationRepoPaths([r.a])).toEqual(new Set());
  expect(store.reposWithOwnRunDefaults([r.a])).toEqual([]);
});
