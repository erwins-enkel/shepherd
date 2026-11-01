// ci-watch settings panel (#2543): pure view + form parsing.

import { test, expect } from "bun:test";
import { applyRepoForm, applySettingsForm, parseOverrides } from "../src/plugins/bundled/ci-watch";
import type { ClassifyRecord } from "../src/plugins/bundled/ci-watch/classify";
import { fileAnywayText } from "../src/plugins/bundled/ci-watch/classify";
import { buildView, repoFieldId, STRINGS } from "../src/plugins/bundled/ci-watch/panel";
import { DEFAULT_REPO, DEFAULT_SETTINGS } from "../src/plugins/bundled/ci-watch/state";
import { validatePluginUIView } from "../src/plugins/ui-validate";
import type { PluginUINode } from "../src/plugins/types";

const repos = Array.from({ length: 450 }, (_, i) => ({
  path: `/home/op/src/org/repo-${i}`,
  name: `repo-${i}`,
  autoLabel: "shepherd:auto",
  lightweight: false,
}));

const rejected: ClassifyRecord[] = Array.from({ length: 40 }, (_, i) => ({
  id: `map:/r::ci.yml::test:${i}`,
  key: "map:/r::ci.yml::test",
  repo: "/home/op/src/org/repo-0",
  runId: i,
  runUrl: `https://github.com/org/repo-0/actions/runs/${i}`,
  headSha: "a".repeat(40),
  workflowName: "CI",
  workflowFile: "ci.yml",
  job: "test",
  outcome: "rejected",
  jev: null,
  stage: "triage",
  verdict: null,
  reason: "r".repeat(600),
  overridden: false,
  updatedAt: "2026-09-28T00:00:00Z",
}));

function maximal(locale: "en" | "de" = "en") {
  const cfgs = Object.fromEntries(
    repos.slice(0, 40).map((r, i) => [
      r.path,
      {
        ...DEFAULT_REPO,
        enabled: i % 2 === 0,
        overrides: [{ glob: "Eval*", threshold: 3 }],
      },
    ]),
  );
  return buildView({
    settings: { ...DEFAULT_SETTINGS, locale },
    status: { lastPollAt: 1, lastError: "boom", lastResult: { ok: 2, baseline: 1 } },
    repos: cfgs,
    available: repos,
    openRepo: repos[0]!.path,
    filedToday: () => 1,
    rejected,
  });
}

const walk = (n: PluginUINode): PluginUINode[] => [n, ...(n.children ?? []).flatMap(walk)];
const find = (root: PluginUINode, type: string) => walk(root).find((n) => n.type === type);
const items = (n: PluginUINode | undefined) =>
  n?.props?.items as { value: string; label: string; meta: string; current: boolean }[];
const options = (n: PluginUINode | undefined) =>
  n?.props?.options as { value: string; label: string }[];

function panel(over: Partial<Parameters<typeof buildView>[0]> = {}) {
  return buildView({
    settings: DEFAULT_SETTINGS,
    status: { lastPollAt: 0, lastError: null, lastResult: {} },
    repos: {},
    available: [],
    openRepo: null,
    filedToday: () => 0,
    rejected: [],
    ...over,
  });
}
const repo = (name: string, slug?: string) => ({
  path: `/r/${name}`,
  name,
  slug,
  autoLabel: "a",
  lightweight: false,
});

function inputNames(n: PluginUINode, out: string[] = []): string[] {
  if (typeof n.props?.name === "string") out.push(n.props.name);
  for (const c of n.children ?? []) inputNames(c, out);
  return out;
}

test("a maximal panel (row caps hit everywhere) passes the host UI validator", () => {
  expect(validatePluginUIView(maximal())).not.toBeNull();
  expect(validatePluginUIView(maximal("de"))).not.toBeNull();
});

test("input names are unique and name-safe", () => {
  const names = inputNames(maximal().root);
  expect(new Set(names).size).toBe(names.length);
  for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
});

test("panel copy follows the locale", () => {
  expect(JSON.stringify(maximal("en"))).toContain(STRINGS.en.rejected);
  const de = JSON.stringify(maximal("de"));
  expect(de).toContain(STRINGS.de.rejected);
  expect(de).not.toContain(STRINGS.en.saveRepo);
});

test("EN and DE catalogs have the same keys", () => {
  expect(Object.keys(STRINGS.de).sort()).toEqual(Object.keys(STRINGS.en).sort());
});

test("parseOverrides", () => {
  expect(parseOverrides("")).toEqual([]);
  expect(parseOverrides("Eval*=3, nightly = 99\ne2e-?=2")).toEqual([
    { glob: "Eval*", threshold: 3 },
    { glob: "nightly", threshold: 20 },
    { glob: "e2e-?", threshold: 2 },
  ]);
  expect(parseOverrides("Eval*")).toBeNull();
  expect(parseOverrides("=3")).toBeNull();
  expect(parseOverrides("x=-1")).toBeNull();
});

test("applySettingsForm clamps and parses globs", () => {
  expect(
    applySettingsForm(DEFAULT_SETTINGS, {
      enabled: true,
      pollMinutes: 0,
      probeSkipGlobs: " Eval*, nightly ,",
      locale: "de",
    }),
  ).toEqual({ enabled: true, pollMinutes: 1, probeSkipGlobs: ["Eval*", "nightly"], locale: "de" });
  expect(applySettingsForm(DEFAULT_SETTINGS, { pollMinutes: null, locale: "fr" })).toEqual(
    DEFAULT_SETTINGS,
  );
});

test("applyRepoForm reads only its own repo's fields", () => {
  const id = repoFieldId("/r/a");
  const body = {
    [`en.${id}`]: true,
    [`ad.${id}`]: true,
    [`thr.${id}`]: 4,
    [`ovr.${id}`]: "Eval*=5",
    [`thr.${repoFieldId("/r/b")}`]: 9,
  };
  expect(applyRepoForm(DEFAULT_REPO, body, "/r/a", STRINGS.en)).toEqual({
    enabled: true,
    autoDrain: true,
    threshold: 4,
    overrides: [{ glob: "Eval*", threshold: 5 }],
  });
  expect(applyRepoForm(DEFAULT_REPO, { [`ovr.${id}`]: "bad" }, "/r/a", STRINGS.en)).toBe(
    STRINGS.en.invalidOverrides,
  );
});

test("fileAnywayText", () => {
  const t = STRINGS.en;
  expect(fileAnywayText({ status: "filed", number: 7, url: "" }, t)).toBe("Filed #7.");
  expect(fileAnywayText({ status: "duplicate", number: 3, url: "" }, t)).toBe(
    "Already tracked in #3.",
  );
  expect(fileAnywayText({ status: "refused", code: "forbidden" }, t)).toBe("Not filed: forbidden.");
  expect(fileAnywayText(undefined, t)).toBe(t.deferred);
});

test("repo picker + headings label by forge slug, dir name as fallback (#2556)", () => {
  const base = { autoLabel: "shepherd:auto", lightweight: false };
  const view = buildView({
    settings: DEFAULT_SETTINGS,
    status: { lastPollAt: 0, lastError: null, lastResult: {} },
    repos: { "/r/a": DEFAULT_REPO },
    openRepo: "/r/a",
    available: [
      { ...base, path: "/r/a", name: "a", slug: "acme/a" },
      { ...base, path: "/r/b", name: "b", slug: "other/b" },
      { ...base, path: "/r/c", name: "c", lightweight: true },
    ],
    filedToday: () => 0,
    rejected: [],
  });
  const json = JSON.stringify(view);
  expect(json).toContain('"value":"acme/a · ');
  expect(json).toContain('{"value":"/r/b","label":"other/b"}');
  expect(json).toContain('{"value":"/r/c","label":"c"}');
});

test("picker sorts by visible label, whatever the folder order (case-insensitive, numeric)", () => {
  const view = panel({
    available: [
      repo("a", "zeta/a"),
      repo("b"),
      repo("c", "Acme/c"),
      repo("d", "acme/repo10"),
      repo("e", "acme/repo2"),
    ],
  });
  expect(options(find(view.root, "multi-select")).map((o) => o.label)).toEqual([
    "Acme/c",
    "acme/repo2",
    "acme/repo10",
    "b",
    "zeta/a",
  ]);
});

test("watched list: enabled first, then label; every repo reachable, no form until opened", () => {
  const all = Array.from({ length: 66 }, (_, i) => repo(`r${i}`));
  const repos = Object.fromEntries(
    all.map((r, i) => [r.path, { ...DEFAULT_REPO, enabled: i !== 0 }]),
  );
  const view = panel({ repos, available: [...all, repo("z", "acme/z"), repo("y", "acme/y")] });
  const rows = items(find(view.root, "action-list"));
  expect(rows).toHaveLength(66);
  expect(rows.at(0)?.label).toBe("r1");
  expect(rows.at(-1)?.label).toBe("r0");
  expect(rows.at(-1)?.meta).toContain(STRINGS.en.off);
  expect(rows.at(0)?.meta).toContain(STRINGS.en.watching);
  expect(rows.some((r) => r.current)).toBe(false);
  expect(inputNames(view.root).filter((n) => n.startsWith("thr."))).toEqual([]);
});

test("opening a repo renders only its form and marks its row", () => {
  const a = repo("a");
  const b = repo("b");
  const repos = { [a.path]: DEFAULT_REPO, [b.path]: DEFAULT_REPO };
  const view = panel({ repos, available: [a, b], openRepo: b.path });
  expect(inputNames(view.root).filter((n) => n.startsWith("thr."))).toEqual([
    `thr.${repoFieldId(b.path)}`,
  ]);
  expect(items(find(view.root, "action-list")).find((r) => r.current)?.value).toBe(b.path);
});

test("add picker keeps its index whether or not a row is open", () => {
  const a = repo("a");
  const b = repo("b");
  const index = (openRepo: string | null) =>
    panel({
      repos: { [a.path]: DEFAULT_REPO },
      available: [a, b],
      openRepo,
    }).root.children!.findIndex((n) => n.props?.name === "addRepos");
  expect(index(null)).toBeGreaterThan(-1);
  expect(index(a.path)).toBe(index(null));
});

test("200 long-path repos stay inside the host's limits, with the overflow counted", () => {
  const long = Array.from({ length: 450 }, (_, i) => ({
    ...repo(`${"x".repeat(100)}${i}`, `organisation/${"y".repeat(30)}${i}`),
  }));
  const half = Object.fromEntries(long.slice(0, 120).map((r) => [r.path, DEFAULT_REPO]));
  const view = panel({ repos: half, available: long, openRepo: long[0]!.path, rejected });
  expect(validatePluginUIView(view)).not.toBeNull();
  expect(items(find(view.root, "action-list"))).toHaveLength(120);
  expect(options(find(view.root, "multi-select"))).toHaveLength(80);
  expect(JSON.stringify(view)).toContain(`250 ${STRINGS.en.more}`);

  const full = Object.fromEntries(long.slice(0, 210).map((r) => [r.path, DEFAULT_REPO]));
  const over = panel({ repos: full, available: long });
  expect(validatePluginUIView(over)).not.toBeNull();
  expect(items(find(over.root, "action-list"))).toHaveLength(200);
  expect(find(over.root, "multi-select")).toBeUndefined();
  expect(JSON.stringify(over)).toContain(`10 ${STRINGS.en.more}`);
});
