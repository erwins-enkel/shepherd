// security-watch settings panel: pure view + form parsing.
import { test, expect } from "bun:test";
import { applyRepoForm, applySettingsForm, fileText } from "../src/plugins/bundled/security-watch";
import { buildView, repoFieldId, STRINGS } from "../src/plugins/bundled/security-watch/panel";
import {
  DEFAULT_REPO,
  DEFAULT_SETTINGS,
  type GroupRecord,
} from "../src/plugins/bundled/security-watch/state";
import type { PluginRepoVisibility, PluginUINode } from "../src/plugins/types";
import { validatePluginUIView } from "../src/plugins/ui-validate";
import { REPO } from "./security-watch-fixture";

function input(visibility: PluginRepoVisibility, locale: "en" | "de" = "en") {
  return {
    settings: { ...DEFAULT_SETTINGS, locale },
    status: { lastPollAt: 0, lastError: null, lastResult: {} },
    repos: { [REPO]: { ...DEFAULT_REPO, enabled: true } },
    available: [{ path: REPO, name: "web", autoLabel: "a", lightweight: false }],
    openRepo: REPO as string | null,
    filedToday: () => 0,
    visibility: () => visibility,
    availability: () => ({ cs: "ok" }),
    rejected: [] as GroupRecord[],
    closedStillOpen: [] as GroupRecord[],
  };
}

test("every EN string has a DE counterpart", () => {
  expect(Object.keys(STRINGS.de).sort()).toEqual(Object.keys(STRINGS.en).sort());
});

test("disclosure notice and checkbox render only on non-private repos, in EN and DE", () => {
  for (const locale of ["en", "de"] as const) {
    const t = STRINGS[locale];
    for (const v of ["public", "internal", "unknown"] as const) {
      const view = JSON.stringify(buildView(input(v, locale)));
      expect(view).toContain(t.publicNotice);
      expect(view).toContain(t.publicRiskAck);
      expect(view).toContain(`ack.${repoFieldId(REPO)}`);
    }
    const view = JSON.stringify(buildView(input("private", locale)));
    expect(view).not.toContain(t.publicNotice);
    expect(view).not.toContain(`ack.${repoFieldId(REPO)}`);
  }
  expect(STRINGS.en.publicNotice).toContain("critic");
  expect(STRINGS.de.publicNotice).toContain("Critic");
});

function countNodes(n: PluginUINode): number {
  return 1 + (n.children ?? []).reduce((sum, c) => sum + countNodes(c), 0);
}

test("a full view stays within the host's node budget", () => {
  const group = (i: number): GroupRecord => ({
    key: `k${i}`,
    repo: REPO,
    source: "cs",
    subject: "r",
    location: "f",
    tool: "t",
    description: "",
    openAlerts: [],
    triage: {
      alerts: [],
      outcome: "rejected",
      verdict: null,
      reason: "x",
      overridden: false,
      updatedAt: 0,
    },
  });
  const many = Array.from({ length: 40 }, (_, i) => group(i));
  const repos = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`/r/${i}`, { ...DEFAULT_REPO, enabled: true }]),
  );
  const view = buildView({ ...input("public"), repos, rejected: many, closedStillOpen: many });
  expect(countNodes(view.root)).toBeLessThanOrEqual(256);
});

test("a watched repo that needs acceptance says so while collapsed, in EN and DE", () => {
  for (const locale of ["en", "de"] as const) {
    const t = STRINGS[locale];
    const meta = (v: PluginRepoVisibility, cfg: Partial<typeof DEFAULT_REPO> = {}) => {
      const view = buildView({
        ...input(v, locale),
        openRepo: null,
        repos: { [REPO]: { ...DEFAULT_REPO, enabled: true, ...cfg } },
      });
      expect(JSON.stringify(view)).not.toContain(t.publicNotice);
      const list = view.root.children
        ?.flatMap((n) => n.children ?? [])
        .find((n) => n.type === "action-list");
      return (list?.props?.items as { meta: string }[])[0]!.meta;
    };
    expect(meta("public")).toContain(t.needsAcceptance);
    expect(meta("unknown")).toContain(t.needsAcceptance);
    expect(meta("public", { publicRiskAck: true })).not.toContain(t.needsAcceptance);
    expect(meta("private")).not.toContain(t.needsAcceptance);
    expect(meta("public", { enabled: false })).not.toContain(t.needsAcceptance);
  }
});

test("repo lists sort by visible label; the add picker keeps its index when a row opens", () => {
  const repo = (name: string, slug?: string) => ({
    path: `/r/${name}`,
    name,
    slug,
    autoLabel: "a",
    lightweight: false,
  });
  const available = [repo("a", "zeta/a"), repo("b", "Acme/b"), repo("c"), repo("d", "acme/d")];
  const repos = {
    "/r/a": { ...DEFAULT_REPO, enabled: true },
    "/r/b": { ...DEFAULT_REPO, enabled: true },
  };
  const view = (openRepo: string | null) =>
    buildView({ ...input("private"), repos, available, openRepo }).root;
  const at = (root: PluginUINode) => root.children!.findIndex((n) => n.props?.name === "addRepos");
  expect(at(view(null))).toBeGreaterThan(-1);
  expect(at(view("/r/a"))).toBe(at(view(null)));

  const picker = view(null).children![at(view(null))]!;
  expect((picker.props?.options as { label: string }[]).map((o) => o.label)).toEqual([
    "acme/d",
    "c",
  ]);
  const list = view(null)
    .children!.flatMap((n) => n.children ?? [])
    .find((n) => n.type === "action-list");
  expect((list?.props?.items as { label: string }[]).map((i) => i.label)).toEqual([
    "Acme/b",
    "zeta/a",
  ]);
});

test("200 long-path repos stay inside the host's limits", () => {
  const long = Array.from({ length: 450 }, (_, i) => ({
    path: `/${"x".repeat(100)}${i}`,
    name: `n${i}`,
    slug: `organisation/${"y".repeat(30)}${i}`,
    autoLabel: "a",
    lightweight: false,
  }));
  const repos = Object.fromEntries(
    long.slice(0, 120).map((r) => [r.path, { ...DEFAULT_REPO, enabled: true }]),
  );
  const view = buildView({ ...input("public"), repos, available: long, openRepo: long[0]!.path });
  expect(validatePluginUIView(view)).not.toBeNull();
  expect(JSON.stringify(view)).toContain(`250 ${STRINGS.en.more}`);
});

test("settings form: values apply, out-of-range clamps, a bad locale is ignored", () => {
  expect(
    applySettingsForm(DEFAULT_SETTINGS, { enabled: true, pollMinutes: 1, locale: "de" }),
  ).toEqual({ enabled: true, pollMinutes: 5, locale: "de" });
  expect(applySettingsForm(DEFAULT_SETTINGS, { locale: "xx" }).locale).toBe("en");
});

test("repo form: named fields apply; an absent ack field keeps the stored value", () => {
  const id = repoFieldId(REPO);
  const next = applyRepoForm(
    { ...DEFAULT_REPO, publicRiskAck: true },
    {
      [`en.${id}`]: true,
      [`ad.${id}`]: true,
      [`sev.${id}`]: "medium",
      [`cs.${id}`]: false,
      [`np.${id}`]: true,
    },
    REPO,
  );
  expect(next).toEqual({
    enabled: true,
    autoDrain: true,
    minSeverity: "medium",
    codeScanning: false,
    dependabot: true,
    includeNonProduction: true,
    publicRiskAck: true,
  });
  expect(applyRepoForm(DEFAULT_REPO, { [`sev.${id}`]: "bogus" }, REPO).minSeverity).toBe("high");
});

test("fileText covers every outcome", () => {
  const t = STRINGS.en;
  expect(fileText({ status: "filed", number: 7, url: "u" }, t)).toBe("Filed #7.");
  expect(fileText({ status: "needs-ack" }, t)).toBe(t.needsAck);
  expect(fileText({ status: "no-candidates" }, t)).toBe(t.noCandidates);
  expect(fileText({ status: "refused", code: "x" }, t)).toContain("x");
  expect(fileText(null, t)).toBe(t.deferred);
});
