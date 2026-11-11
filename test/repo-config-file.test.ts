import { afterEach, expect, test } from "bun:test";
import {
  parseRepoRules,
  readRepoConfigFile,
  invalidateRepoConfigFile,
} from "../src/repo-config-file";
import { configRepo, git } from "./helpers/repo-config-git";

const repos: ReturnType<typeof configRepo>[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
});
function fixture(branch?: string) {
  const repo = configRepo(undefined, branch);
  repos.push(repo);
  return repo;
}

test("rules parser accepts partial objects, ignores local and retired keys, rejects malformed values", () => {
  expect(
    parseRepoRules('{"criticEnabled":false,"sandboxProfile":"trusted","learningsEnabled":true}'),
  ).toEqual({ criticEnabled: false });
  expect(parseRepoRules("{}")).toEqual({});
  expect(parseRepoRules('{"defaultModel":"inherit","defaultEffort":"inherit"}')).toEqual({
    defaultModel: "inherit",
    defaultEffort: "inherit",
  });
  for (const raw of [
    "{",
    "[]",
    "null",
    "1",
    '{"criticEnabled":1}',
    '{"signoffAuthority":"root"}',
    '{"autoLabel":" "}',
    '{"defaultEffort":"bogus"}',
    '{"defaultModel":null}',
  ])
    expect(parseRepoRules(raw)).toBeNull();
});

test("committed remote default wins over checkout; cache and invalidation track a fetch", () => {
  const r = fixture("trunk");
  expect(readRepoConfigFile(r.b)).toBeNull();
  const commit = r.commit('{"criticEnabled":false}');
  git(r.b, "fetch", "origin");
  expect(readRepoConfigFile(r.b)).toBeNull(); // cached absence
  invalidateRepoConfigFile(r.b);
  expect(readRepoConfigFile(r.b)).toEqual({ rules: { criticEnabled: false }, commit });
  expect(git(r.b, "rev-parse", "HEAD")).not.toBe(commit);
});

test("local default fallback only when remote ref is unavailable; invalid remote never resurrects local rules", () => {
  const r = fixture();
  r.commit('{"criticEnabled":false}');
  r.commit("invalid");
  git(r.a, "update-ref", "refs/heads/local-good", "HEAD~1");
  git(r.b, "fetch", "origin");
  git(r.b, "update-ref", "refs/heads/main", "origin/main~1");
  expect(readRepoConfigFile(r.b)).toBeNull();
  git(r.b, "update-ref", "-d", "refs/remotes/origin/main");
  invalidateRepoConfigFile(r.b);
  expect(readRepoConfigFile(r.b)?.rules).toEqual({ criticEnabled: false });
  git(r.b, "remote", "remove", "origin");
  invalidateRepoConfigFile(r.b);
  expect(readRepoConfigFile(r.b)).toBeNull();
});

test("cached absence expires after sixty seconds without an explicit invalidation", () => {
  const r = fixture();
  expect(readRepoConfigFile(r.b)).toBeNull();
  const commit = r.commit("{}");
  git(r.b, "fetch", "origin");
  const now = Date.now;
  try {
    const later = now() + 60_001;
    Date.now = () => later;
    expect(readRepoConfigFile(r.b)).toEqual({ rules: {}, commit });
  } finally {
    Date.now = now;
  }
});

test("rule files that violate draft/merge or critic/signoff invariants are invalid", () => {
  for (const rules of [
    { draftMode: true, autoMergeEnabled: true },
    { draftMode: true, criticEnabled: false, signoffAuthority: "critic" },
    { draftMode: true, criticEnabled: false, signoffAuthority: "either" },
  ])
    expect(parseRepoRules(JSON.stringify(rules))).toBeNull();
  expect(parseRepoRules('{"draftMode":true}')).toEqual({ draftMode: true });
  expect(parseRepoRules('{"draftMode":true,"criticEnabled":false}')).toEqual({
    draftMode: true,
    criticEnabled: false,
  });
});
