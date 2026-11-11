import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import { RepoConfigService } from "../src/repo-config-service";
import * as files from "../src/repo-config-file";
import { configRepo, git } from "./helpers/repo-config-git";

const leader = "11111111-1111-4111-8111-111111111111";
test("refresh replaces a cached missing file without touching the checkout", async () => {
  const r = configRepo();
  try {
    const svc = new RepoConfigService(new SessionStore(":memory:"));
    expect(svc.read(r.b).repoConfigCommit).toBeNull();
    const head = git(r.b, "rev-parse", "HEAD");
    r.commit('{"autoDrainEnabled":true}');
    expect(svc.read(r.b).autoDrainEnabled).toBe(false);
    expect(typeof files.refreshRepoConfigFile).toBe("function");
    await files.refreshRepoConfigFile(r.b);
    expect(svc.read(r.b).autoDrainEnabled).toBe(true);
    expect(git(r.b, "rev-parse", "HEAD")).toBe(head);
  } finally {
    r.close();
  }
});
test("a combined leader and rule edit makes one commit and subsequent edits retain the leader", async () => {
  const r = configRepo();
  try {
    const svc = new RepoConfigService(new SessionStore(":memory:"));
    const base = git(r.origin, "rev-parse", "main");
    const result = await svc.patch(r.b, { criticAllPrs: true }, { leitrechner: leader });
    expect(result.ok).toBe(true);
    expect(JSON.parse(git(r.origin, "show", "main:.shepherd/config.json")).leitrechner).toBe(
      leader,
    );
    expect(git(r.origin, "rev-list", "--count", `${base}..main`)).toBe("1");
    await svc.patch(r.b, { autoLabel: "ready" });
    expect(svc.read(r.b).leitrechner).toBe(leader);
    await svc.patch(r.b, {}, { leitrechner: null });
    expect(svc.read(r.b).leitrechner).toBeNull();
  } finally {
    r.close();
  }
});

test("a rule write invalidates cached aliases sharing the same Git directory", async () => {
  const r = configRepo();
  try {
    const svc = new RepoConfigService(new SessionStore(":memory:"));
    expect(svc.read(r.b + "/.").repoConfigCommit).toBeNull();
    await svc.patch(r.b, { criticAllPrs: true });
    expect(svc.read(r.b + "/.").criticAllPrs).toBe(true);
  } finally {
    r.close();
  }
});
