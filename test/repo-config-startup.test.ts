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

test("repository refresh bounds concurrency and isolates synchronous and async failures", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [],
    finished: string[] = [],
    failed: string[] = [];
  let active = 0,
    peak = 0;
  const refresh = (dir: string) => {
    started.push(dir);
    active++;
    peak = Math.max(peak, active);
    return gate.then(() => {
      active--;
      if (dir === "bad") throw new Error("unreachable");
      finished.push(dir);
    });
  };
  const work = files.refreshRepoConfigsAtStartup(
    ["a", "bad", "c", "d", "e", "f"],
    (dir) => failed.push(dir),
    refresh,
  );
  await Promise.resolve();
  expect(started).toEqual(["a", "bad", "c", "d"]);
  release();
  await work;
  expect(peak).toBe(4);
  expect(failed).toEqual(["bad"]);
  expect(finished.sort()).toEqual(["a", "c", "d", "e", "f"]);
  await files.refreshRepoConfigsAtStartup(
    ["throws", "ok"],
    (dir) => failed.push(dir),
    (dir) => {
      if (dir === "throws") throw new Error("resolver failed");
      return Promise.resolve();
    },
  );
  expect(failed).toEqual(["bad", "throws"]);
});
