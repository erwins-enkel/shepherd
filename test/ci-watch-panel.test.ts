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
    filedToday: () => 1,
    rejected,
  });
}

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
