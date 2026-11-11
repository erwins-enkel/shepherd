import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { RULE_FIELDS } from "#lib/repo-config-fields.js";
import { readFileSync } from "node:fs";
import { RepoConfigEditor } from "./repo-config-editor.svelte";
import { repoConfig } from "#lib/reviews.svelte.js";
import type { RepoConfigResponse } from "#lib/api.js";
const repo = "/editor-test";
let config: RepoConfigResponse;
let puts: Record<string, unknown>[];
beforeEach(() => {
  config = {
    criticEnabled: true,
    draftMode: false,
    autoMergeEnabled: false,
    autoDrainEnabled: false,
    signoffAuthority: "human",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    repoMode: "forge",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    repoConfigBranch: "trunk",
    repoConfigCommit: "old",
    leitrechner: null,
  } as RepoConfigResponse;
  puts = [];
  repoConfig.loaded = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (init?.method === "PUT") {
        const patch = JSON.parse(init.body);
        puts.push(patch);
        config = { ...config, ...patch };
      }
      return Response.json(config);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
test("classification matches the backend", () => {
  const source = readFileSync("../src/repo-config-file.ts", "utf8");
  const fields = [
    ...source
      .split("export const REPO_RULE_FIELDS = [")[1]
      .split("] as const")[0]
      .matchAll(/"([^"]+)"/g),
  ].map((m) => m[1]);
  expect(RULE_FIELDS).toEqual(fields);
});
test("stages rules, preserves them across immediate machine writes, commits once", async () => {
  const editor = new RepoConfigEditor(repo);
  await editor.ensure(repo);
  await editor.toggle(repo);
  await editor.toggleBuildQueue(repo);
  await editor.setLeader("11111111-1111-4111-8111-111111111111");
  expect(puts).toEqual([]);
  expect(repoConfig.isEnabled(repo)).toBe(true);
  expect(editor.isEnabled(repo)).toBe(false);
  await editor.setMaxAuto(repo, 3);
  expect(puts).toEqual([{ maxAuto: 3 }]);
  expect(editor.isEnabled(repo)).toBe(false);
  await editor.save();
  expect(puts).toHaveLength(2);
  expect(puts[1]).toMatchObject({
    criticEnabled: false,
    buildQueueEnabled: true,
    leitrechner: "11111111-1111-4111-8111-111111111111",
  });
  expect(puts[1]).not.toHaveProperty("maxAuto");
  expect(editor.dirty).toBe(false);
});
test("reverting removes diff; discard retains saved machine values", async () => {
  const editor = new RepoConfigEditor(repo);
  await editor.ensure(repo);
  await editor.toggle(repo);
  await editor.toggle(repo);
  expect(editor.dirty).toBe(false);
  await editor.toggle(repo);
  await editor.setMaxAuto(repo, 4);
  editor.discard();
  expect(editor.isEnabled(repo)).toBe(true);
  expect(editor.maxAutoFor(repo)).toBe(4);
});
test("failed save retains edits and two editors never share a draft", async () => {
  const a = new RepoConfigEditor(repo);
  const b = new RepoConfigEditor(repo);
  await a.ensure(repo);
  await b.ensure(repo);
  await a.toggle(repo);
  expect(b.isEnabled(repo)).toBe(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 502 })),
  );
  await expect(a.save()).rejects.toThrow();
  expect(a.dirty).toBe(true);
});
test("first sharing seeds complete current rules even with no edits", async () => {
  config.repoConfigCommit = null;
  const editor = new RepoConfigEditor(repo);
  await editor.ensure(repo);
  await editor.save();
  expect(puts).toHaveLength(1);
  expect(puts[0]).toMatchObject({
    criticEnabled: true,
    defaultModel: "inherit",
    defaultEffort: "inherit",
    autoLabel: "shepherd:auto",
  });
});

test("changing one rule never overwrites a concurrent rule edit on machine response", async () => {
  const editor = new RepoConfigEditor(repo);
  await editor.ensure(repo);
  await editor.toggle(repo);
  config = { ...config, autoDrainEnabled: true };
  await editor.setMaxAuto(repo, 2);
  expect(editor.isAutoDrainEnabled(repo)).toBe(true);
  expect(editor.isEnabled(repo)).toBe(false);
});

test("a changed comparison requires a second confirmation and saves nothing on the first", async () => {
  const editor = new RepoConfigEditor(repo);
  await editor.ensure(repo);
  await editor.toggle(repo);
  config = { ...config, criticEnabled: false, repoConfigCommit: "new" };
  expect(await editor.save()).toBe(false);
  expect(puts).toEqual([]);
  expect(editor.dirty).toBe(true);
});

test("compound merge/critic setters keep the staged invariant in the single commit", async () => {
  config = { ...config, draftMode: true, signoffAuthority: "critic" };
  const editor = new RepoConfigEditor(repo);
  await editor.ensure(repo);
  await editor.toggle(repo);
  expect(editor.signoffAuthorityFor(repo)).toBe("human");
  await editor.setMergeMode(repo, "auto");
  expect(editor.isDraftModeEnabled(repo)).toBe(false);
  expect(puts).toEqual([]);
  await editor.save();
  expect(puts).toEqual([
    { criticEnabled: false, signoffAuthority: "human", draftMode: false, autoMergeEnabled: true },
  ]);
});

test("known local-only repositories keep immediate writes without sharing", async () => {
  config.repoConfigBranch = null;
  const editor = new RepoConfigEditor(repo);
  await editor.ensure(repo);
  await editor.toggle(repo);
  expect(puts).toEqual([{ criticEnabled: false }]);
  expect(editor.dirty).toBe(false);
  expect(editor.shareable).toBe(false);
});

test("saving rules does not block an immediate machine permission revocation", async () => {
  const editor = new RepoConfigEditor(repo);
  await editor.ensure(repo);
  editor.saving = true;
  await editor.write(repo, { sharedBrowserEnabled: false });
  expect(puts).toEqual([{ sharedBrowserEnabled: false }]);
});

test("a delayed rule response cannot undo a newer machine permission write", async () => {
  const editor = new RepoConfigEditor(repo);
  await editor.ensure(repo);
  await editor.toggle(repo);
  let release!: () => void;
  let waiting = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (init?.method === "PUT") {
        const patch = JSON.parse(init.body);
        config = { ...config, ...patch };
        if ("criticEnabled" in patch) {
          config.repoConfigCommit = "new";
          const snapshot = { ...config };
          await new Promise<void>((resolve) => {
            release = resolve;
            waiting = true;
          });
          return Response.json(snapshot);
        }
      }
      return Response.json(config);
    }),
  );
  const save = editor.save();
  await vi.waitFor(() => expect(waiting).toBe(true));
  await editor.write(repo, { sharedBrowserEnabled: false, maxAuto: 7 });
  release();
  await save;
  expect(repoConfig.maxAutoFor(repo)).toBe(7);
  expect(editor.maxAutoFor(repo)).toBe(7);
  expect(repoConfig.sharedBrowserOn(repo)).toBe(false);
});

test("a delayed machine response cannot restore old rules after the commit", async () => {
  const editor = new RepoConfigEditor(repo);
  await editor.ensure(repo);
  let release!: () => void;
  let waiting = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      if (init?.method === "PUT") {
        const patch = JSON.parse(init.body);
        config = { ...config, ...patch };
        if ("maxAuto" in patch) {
          const snapshot = { ...config };
          await new Promise<void>((resolve) => {
            release = resolve;
            waiting = true;
          });
          return Response.json(snapshot);
        }
        config.repoConfigCommit = "new";
      }
      return Response.json(config);
    }),
  );
  const machine = editor.setMaxAuto(repo, 7);
  await vi.waitFor(() => expect(waiting).toBe(true));
  await editor.toggle(repo);
  await editor.save();
  release();
  await machine;
  expect(editor.view?.repoConfigCommit).toBe("new");
  expect(repoConfig.isEnabled(repo)).toBe(false);
  expect(editor.isEnabled(repo)).toBe(false);
});
