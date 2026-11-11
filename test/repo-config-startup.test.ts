import { expect, test } from "bun:test";
import * as files from "../src/repo-config-file";
import { configRepo, git } from "./helpers/repo-config-git";

test("startup catches up an offline clone and reports failures without blocking other repos", async () => {
  const r = configRepo();
  try {
    expect(files.readRepoConfigFile(r.b)).toBeNull();
    r.commit('{"criticAllPrs":true}');
    expect(typeof files.refreshRepoConfigsAtStartup).toBe("function");
    const failed: string[] = [];
    git(r.a, "remote", "set-url", "origin", `${r.dir}/offline.git`);
    await files.refreshRepoConfigsAtStartup([r.a, r.b], (dir) => failed.push(dir));
    expect(failed).toEqual([r.a]);
    expect(files.readRepoConfigFile(r.b)?.rules.criticAllPrs).toBe(true);
  } finally {
    r.close();
  }
});
