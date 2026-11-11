import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { configRepo, git } from "./helpers/repo-config-git";
import { configForge } from "./helpers/repo-config-forge";
import { SessionStore } from "../src/store";
import { RepoConfigService } from "../src/repo-config-service";
import { REPO_CONFIG_PR_BRANCH } from "../src/repo-config-pr";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function fixture(seed = true) {
  const r = configRepo();
  const store = new SessionStore(":memory:");
  const f = configForge();
  const svc = new RepoConfigService(
    store,
    () => "standard",
    undefined,
    () => f.forge,
  );
  cleanups.push(() => {
    r.close();
  });
  if (seed) r.commit('{"criticEnabled":true,"autoLabel":"ready"}');
  git(r.b, "fetch", "origin");
  writeFileSync(
    join(r.origin, "hooks/pre-receive"),
    '#!/bin/sh\nwhile read old new ref; do\n if [ "$ref" = "refs/heads/main" ]; then echo secret-token >&2; exit 1; fi\ndone\n',
    { mode: 0o755 },
  );
  return { r, store, svc, ...f };
}

test("pending saves retain effective rules and commit while mixed local fields save", async () => {
  const { r, store, svc } = fixture();
  const before = svc.read(r.b);
  const saved = await svc.patch(
    r.b,
    { criticEnabled: false, maxAuto: 4 },
    { automationConfirmed: true },
  );
  expect(saved).toMatchObject({
    ok: true,
    rulesCommitted: false,
    config: {
      criticEnabled: true,
      maxAuto: 4,
      repoConfigCommit: before.repoConfigCommit,
      pendingRepoConfig: {
        number: 41,
        url: "https://host/pr/41",
        changes: { criticEnabled: false },
      },
    },
  });
  expect(store.getRepoConfig(r.b).criticEnabled).toBe(true);
  expect(store.isAutomationConfirmed(r.b)).toBe(true);
});

test("fresh service discovers proposal, validates combined draft, then adopts merge on both clones", async () => {
  const { r, store, svc, forge, setState } = fixture();
  await svc.patch(r.b, { draftMode: true });
  const other = new RepoConfigService(
    store,
    () => "standard",
    undefined,
    () => forge,
  );
  await other.refreshPending(r.a);
  expect(other.read(r.a)).toMatchObject({
    draftMode: false,
    pendingRepoConfig: { changes: { draftMode: true } },
  });
  expect(await other.patch(r.a, { autoMergeEnabled: true, maxAuto: 9 })).toMatchObject({
    ok: false,
    error: "draftMode and autoMergeEnabled are mutually exclusive",
  });
  expect(store.getLocalRepoConfig(r.a).maxAuto).toBe(1);
  git(r.origin, "update-ref", "refs/heads/main", git(r.origin, "rev-parse", REPO_CONFIG_PR_BRANCH));
  setState("merged");
  await svc.refreshPending(r.b, true);
  await other.refreshPending(r.a, true);
  expect(svc.read(r.b)).toMatchObject({ draftMode: true, pendingRepoConfig: null });
  expect(other.read(r.a)).toMatchObject({ draftMode: true, pendingRepoConfig: null });
});

test("failed fallback leaves mixed local patch intact and sanitized; lightweight/no-forge stay local", async () => {
  const { r, store, svc, forge } = fixture();
  forge.openPr = async () => {
    throw new Error("secret-token");
  };
  const failed = await svc.patch(
    r.b,
    { criticEnabled: false, maxAuto: 9 },
    { automationConfirmed: true },
  );
  expect(failed).toMatchObject({ ok: false, code: "repo_config_write_failed" });
  expect(JSON.stringify(failed)).not.toContain("secret-token");
  expect(store.getLocalRepoConfig(r.b).maxAuto).toBe(1);
  expect(store.isAutomationConfirmed(r.b)).toBe(false);
  const local = new RepoConfigService(store);
  expect(await local.patch(r.a, { planGateEnabled: true })).toMatchObject({
    ok: true,
    rulesCommitted: false,
  });
  expect(store.getLocalRepoConfig(r.a).planGateEnabled).toBe(true);
  expect(await svc.patch(r.b, { repoMode: "lightweight", planGateEnabled: true })).toMatchObject({
    ok: true,
    rulesCommitted: false,
  });
});

test("transient forge lookup and failed merge fetch retain last known pending state", async () => {
  const { r, svc, forge, setState } = fixture();
  await svc.patch(r.b, { criticEnabled: false });
  const lookup = forge.prStatus;
  forge.prStatus = async () => {
    throw new Error("offline");
  };
  await svc.refreshPending(r.b, true);
  expect(svc.read(r.b)).toMatchObject({ criticEnabled: true, pendingRepoConfig: { number: 41 } });
  forge.prStatus = lookup;
  setState("merged");
  git(r.b, "remote", "set-url", "origin", join(r.dir, "missing.git"));
  await svc.refreshPending(r.b, true);
  expect(svc.read(r.b)).toMatchObject({ criticEnabled: true, pendingRepoConfig: { number: 41 } });
  git(r.b, "remote", "set-url", "origin", r.origin);
  git(r.origin, "update-ref", "refs/heads/main", git(r.origin, "rev-parse", REPO_CONFIG_PR_BRANCH));
  await svc.refreshPending(r.b, true);
  expect(svc.read(r.b)).toMatchObject({ criticEnabled: false, pendingRepoConfig: null });
});

test("a missing shared file compares pending changes against the actual local fallback", async () => {
  const { r, store, svc } = fixture(false);
  store.setRepoConfig(r.b, { ...store.getLocalRepoConfig(r.b), criticAllPrs: true });
  const result = await svc.patch(r.b, { criticAllPrs: false });
  expect(result).toMatchObject({
    ok: true,
    config: { criticAllPrs: true, pendingRepoConfig: { changes: { criticAllPrs: false } } },
  });
});

test("startup discovery reports a merged proposal even when startup already fetched the effective file", async () => {
  const { r, svc, store, forge, setState } = fixture();
  await svc.patch(r.b, { criticEnabled: false });
  git(r.origin, "update-ref", "refs/heads/main", git(r.origin, "rev-parse", REPO_CONFIG_PR_BRANCH));
  setState("merged");
  const { refreshRepoConfigFile } = await import("../src/repo-config-file");
  await refreshRepoConfigFile(r.b);
  const restarted = new RepoConfigService(
    store,
    () => "standard",
    undefined,
    () => forge,
  );
  expect(await restarted.refreshPending(r.b)).toBe(true);
  expect(await restarted.refreshPending(r.b, true)).toBe(false);
});

test("pending read replays intent without marking unrelated effective changes as reversions", async () => {
  const { r, svc } = fixture();
  await svc.patch(r.b, { criticAllPrs: true });
  writeFileSync(join(r.origin, "hooks/pre-receive"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  r.commit('{"autoLabel":"new-label"}');
  await svc.refreshPending(r.b, true);
  expect(svc.read(r.b).autoLabel).toBe("new-label");
  expect(svc.read(r.b).pendingRepoConfig?.changes).toEqual({ criticAllPrs: true });
});
