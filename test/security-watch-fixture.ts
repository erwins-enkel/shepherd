// Shared fake world for the security-watch tests: scripted alert reads + in-memory state + fake
// issues, agents and sessions, wired through the real poller, triage, filer and sync.
import { createFiler } from "../src/plugins/bundled/security-watch/file";
import { createPoller } from "../src/plugins/bundled/security-watch/poller";
import {
  DEFAULT_REPO,
  readGroups,
  type GroupRecord,
  type RepoConfig,
} from "../src/plugins/bundled/security-watch/state";
import { syncFiled } from "../src/plugins/bundled/security-watch/sync";
import { createTriage } from "../src/plugins/bundled/security-watch/triage";
import type {
  PluginAlertList,
  PluginCodeScanningAlert,
  PluginDependabotAlert,
  PluginIssue,
  PluginIssueCreateInput,
  PluginRepoVisibility,
  PluginSessionSnapshot,
  PluginState,
} from "../src/plugins/types";

export const REPO = "/r/web";
export const HOUR = 60 * 60_000;
export const T0 = Date.parse("2026-10-01T12:00:00Z");

export function memState(): PluginState {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : null),
    set: (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: (k: string) => void m.delete(k),
    keys: () => [...m.keys()],
  } as PluginState;
}

export function cs(number: number, over: Partial<PluginCodeScanningAlert> = {}) {
  return {
    number,
    url: `https://gh/cs/${number}`,
    ruleId: "js/rule",
    ruleDescription: "RULE-DESC",
    securitySeverity: "high",
    tool: "CodeQL",
    cwes: ["CWE-79"],
    path: "src/a.ts",
    line: 5,
    message: `MESSAGE-${number}`,
    classifications: [],
    createdAt: T0 - 48 * HOUR,
    ...over,
  } satisfies PluginCodeScanningAlert;
}

export function dep(number: number, over: Partial<PluginDependabotAlert> = {}) {
  return {
    number,
    url: `https://gh/dep/${number}`,
    ecosystem: "npm",
    package: "lodash",
    manifest: "package.json",
    scope: "runtime",
    severity: "high",
    ghsaId: `GHSA-${number}`,
    cveId: null,
    summary: `ADVISORY-${number}`,
    cwes: [],
    patchedVersion: "9.9.9",
    createdAt: T0 - 48 * HOUR,
    ...over,
  } satisfies PluginDependabotAlert;
}

const ok = <T>(alerts: T[], truncated = false): PluginAlertList<T> => ({
  status: "ok",
  alerts,
  truncated,
});

export function world(cfg: Partial<RepoConfig> = {}) {
  const state = memState();
  const w = {
    state,
    clock: T0,
    visibility: "private" as PluginRepoVisibility | Error,
    /** Runs when a triage agent is asked, e.g. to change the world mid-poll. */
    onTriage: null as (() => void) | null,
    codeScanning: ok<PluginCodeScanningAlert>([]) as
      PluginAlertList<PluginCodeScanningAlert> | Error,
    dependabot: ok<PluginDependabotAlert>([]) as PluginAlertList<PluginDependabotAlert> | Error,
    verdict: {
      fixable: true,
      confidence: "high",
      hypothesis: "HYPOTHESIS",
      files: ["FILE"],
      reason: "REASON",
    } as Record<string, unknown> | Error,
    created: [] as PluginIssueCreateInput[],
    issues: new Map<number, PluginIssue>(),
    closed: [] as { number: number; comment?: string }[],
    triaged: [] as { prompt: string; content: string }[],
    sessions: [] as PluginSessionSnapshot[],
    createError: null as Error | null,
    setCs(alerts: PluginCodeScanningAlert[], truncated = false) {
      w.codeScanning = ok(alerts, truncated);
    },
    setDep(alerts: PluginDependabotAlert[], truncated = false) {
      w.dependabot = ok(alerts, truncated);
    },
    setConfig(c: Partial<RepoConfig>) {
      state.set("repos", { [REPO]: { ...DEFAULT_REPO, enabled: true, ...c } });
    },
    closeIssue(number: number) {
      const i = w.issues.get(number);
      if (i) w.issues.set(number, { ...i, state: "closed" });
    },
    groups: (): GroupRecord[] => readGroups(state),
    group(subject = "js/rule"): GroupRecord {
      const g = readGroups(state).find((x) => x.subject === subject);
      if (!g) throw new Error(`no group ${subject}`);
      return g;
    },
    status: () => state.get<{ lastResult: Record<string, number> }>("meta:status")!.lastResult,
  };
  w.setConfig({ ...cfg });
  state.set("settings", { enabled: true, pollMinutes: 30, locale: "en" });

  const log = { log: () => {}, warn: () => {} };
  const now = () => new Date(w.clock);
  const repos = () => [
    { path: REPO, name: "web", slug: "o/web", autoLabel: "shepherd:auto", lightweight: false },
    { path: "/r/local", name: "local", autoLabel: "shepherd:auto", lightweight: true },
  ];
  const read = async <T>(v: T | Error) => {
    if (v instanceof Error) throw v;
    return v;
  };
  const security = {
    listCodeScanningAlerts: () => read(w.codeScanning),
    listDependabotAlerts: () => read(w.dependabot),
    visibility: () => read(w.visibility),
  };
  const issues = {
    create: async (_repo: string, o: PluginIssueCreateInput) => {
      if (w.createError) throw w.createError;
      w.created.push(o);
      const number = 40 + w.created.length;
      const url = `https://gh/issues/${number}`;
      w.issues.set(number, {
        number,
        title: o.title,
        body: o.body,
        url,
        labels: o.labels ?? [],
        state: "open",
      });
      return { number, url };
    },
    get: async (_repo: string, n: number) => w.issues.get(n) ?? null,
    close: async (_repo: string, number: number, comment?: string) => {
      w.closed.push({ number, comment });
      w.closeIssue(number);
    },
  };
  const agents = {
    runReadonly: async (o: { prompt: string; untrusted?: { content: string }[] }) => {
      w.triaged.push({
        prompt: o.prompt,
        content: (o.untrusted ?? []).map((s) => s.content).join("\n"),
      });
      w.onTriage?.();
      if (w.verdict instanceof Error) throw w.verdict;
      return w.verdict;
    },
  };
  const file = createFiler({ state, issues, security, repos, now, log });
  const triage = createTriage({ state, agents: agents as never, file, now, log });
  const poller = createPoller({
    state,
    security,
    repos,
    forward: (g) => triage.process(g),
    sync: (complete) =>
      syncFiled({
        state,
        issues,
        sessions: { list: () => w.sessions } as never,
        complete,
        now,
        log,
      }),
    now,
    log,
  });
  return { ...w, w, triage, poller, file };
}

export const agentError = (code: string) =>
  Object.assign(new Error(code), { name: "PluginAgentError", code });
