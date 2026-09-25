// Sentry read-only triage stage (#2465): gating, dedup, regression re-triage, deferral,
// override, routes and the rejected-list panel node.
import { test, expect } from "bun:test";
import {
  createTriageStage,
  registerTriageRoutes,
  rejectedPanelNode,
  TRIAGE_SCHEMA,
  TRIAGE_STRINGS,
  type TriageCandidate,
  type TriageFileExtra,
  type TriageVerdict,
} from "../src/plugins/bundled/sentry/triage";
import {
  PluginAgentError,
  type PluginAgentRunOptions,
  type PluginRouteHandler,
  type PluginState,
} from "../src/plugins/types";
import { validatePluginUIView } from "../src/plugins/ui-validate";

function memState(): PluginState {
  const m = new Map<string, string>();
  return {
    get: <T>(k: string) => (m.has(k) ? (JSON.parse(m.get(k)!) as T) : null),
    set: (k, v) => void m.set(k, JSON.stringify(v)),
    delete: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

const HIGH: TriageVerdict = {
  fixable: true,
  confidence: "high",
  hypothesis: "null deref in checkout total",
  files: ["src/checkout.ts"],
  reason: "clear null deref",
};

function candidate(over: Partial<TriageCandidate> = {}): TriageCandidate {
  return {
    sentryId: "42",
    shortId: "APP-1",
    repo: "/repo",
    title: "Sentry APP-1: TypeError in checkout",
    permalink: "https://sentry.io/issues/42",
    untrusted: [{ label: "sentry event", content: "TypeError: x is null" }],
    regressionKey: null,
    ...over,
  };
}

type Answer = TriageVerdict | Error | Promise<TriageVerdict>;

function harness(answers: Answer[]) {
  const runs: PluginAgentRunOptions[] = [];
  const filed: { c: TriageCandidate; extra: TriageFileExtra }[] = [];
  let fileError: Error | null = null;
  let n = 0;
  const stage = createTriageStage({
    agents: {
      runReadonly: async (opts) => {
        runs.push(opts);
        const a = answers[Math.min(n++, answers.length - 1)]!;
        if (a instanceof Error) throw a;
        return a;
      },
    },
    state: memState(),
    file: async (c, extra) => {
      if (fileError) throw fileError;
      filed.push({ c, extra });
      return { number: 100 + filed.length, url: `https://gh/issues/${100 + filed.length}` };
    },
    now: () => new Date("2026-09-25T10:00:00Z"),
  });
  return {
    stage,
    runs,
    filed,
    failFile: (e: Error | null) => {
      fileError = e;
    },
  };
}

test("high + fixable → filed with hypothesis/files as untrusted sections", async () => {
  const h = harness([HIGH]);
  const res = await h.stage.process(candidate());
  expect(res.outcome).toBe("filed");
  expect(h.filed).toHaveLength(1);
  expect(h.filed[0]!.extra).toEqual({
    overridden: false,
    untrusted: [
      { label: "triage hypothesis", content: HIGH.hypothesis },
      { label: "triage files", content: "src/checkout.ts" },
    ],
  });
  expect(res.outcome === "filed" && res.record.issue?.number).toBe(101);
  expect(h.runs[0]!.model).toBe("sonnet");
  expect(h.runs[0]!.schema).toBe(TRIAGE_SCHEMA);
  expect(h.runs[0]!.untrusted).toEqual(candidate().untrusted);
  expect(h.runs[0]!.repo).toBe("/repo");
});

test.each([
  ["low confidence", { ...HIGH, confidence: "low" as const }],
  ["medium confidence", { ...HIGH, confidence: "medium" as const }],
  ["not fixable", { ...HIGH, fixable: false, reason: "third-party outage" }],
])("%s → rejected list, not filed", async (_name, verdict) => {
  const h = harness([verdict]);
  const res = await h.stage.process(candidate());
  expect(res.outcome).toBe("rejected");
  expect(h.filed).toHaveLength(0);
  const rej = h.stage.rejected();
  expect(rej.map((r) => r.sentryId)).toEqual(["42"]);
  expect(rej[0]!.reason).toBe(verdict.reason);
});

test("no double triage for the same issue", async () => {
  const h = harness([{ ...HIGH, confidence: "low" }]);
  await h.stage.process(candidate());
  expect((await h.stage.process(candidate())).outcome).toBe("skipped");
  expect(h.runs).toHaveLength(1);
});

test("filed issue is not re-triaged or re-filed", async () => {
  const h = harness([HIGH]);
  await h.stage.process(candidate());
  expect((await h.stage.process(candidate())).outcome).toBe("skipped");
  expect(h.runs).toHaveLength(1);
  expect(h.filed).toHaveLength(1);
});

test("regression (changed regressionKey) re-triages; same key does not", async () => {
  const h = harness([{ ...HIGH, confidence: "low" }, HIGH]);
  await h.stage.process(candidate({ regressionKey: "r1" }));
  expect((await h.stage.process(candidate({ regressionKey: "r1" }))).outcome).toBe("skipped");
  expect((await h.stage.process(candidate({ regressionKey: "r2" }))).outcome).toBe("filed");
  expect(h.runs).toHaveLength(2);
  expect(h.stage.rejected()).toHaveLength(0);
});

test("concurrent process() for one issue runs one triage", async () => {
  let release!: (v: TriageVerdict) => void;
  const h = harness([new Promise<TriageVerdict>((r) => (release = r))]);
  const a = h.stage.process(candidate());
  expect((await h.stage.process(candidate())).outcome).toBe("skipped");
  release(HIGH);
  expect((await a).outcome).toBe("filed");
  expect(h.runs).toHaveLength(1);
});

test("cap-exceeded / unavailable → deferred, nothing recorded, retried next time", async () => {
  for (const code of ["cap-exceeded", "unavailable"] as const) {
    const h = harness([new PluginAgentError(code, "busy"), HIGH]);
    expect((await h.stage.process(candidate())).outcome).toBe("deferred");
    expect(h.stage.rejected()).toHaveLength(0);
    expect((await h.stage.process(candidate())).outcome).toBe("filed");
    expect(h.runs).toHaveLength(2);
  }
});

test("agent failure → rejected with reason, not re-triaged", async () => {
  const h = harness([new PluginAgentError("timeout", "slow"), HIGH]);
  expect((await h.stage.process(candidate())).outcome).toBe("rejected");
  expect(h.stage.rejected()[0]!.reason).toBe("triage failed: timeout");
  expect((await h.stage.process(candidate())).outcome).toBe("skipped");
  expect(h.runs).toHaveLength(1);
});

test("file() failure after a high verdict retries filing without re-triage", async () => {
  const h = harness([HIGH]);
  h.failFile(new Error("forge down"));
  await expect(h.stage.process(candidate())).rejects.toThrow("forge down");
  h.failFile(null);
  expect((await h.stage.process(candidate())).outcome).toBe("filed");
  expect(h.runs).toHaveLength(1);
  expect(h.filed).toHaveLength(1);
});

test("fileAnyway files a rejected issue once; unknown / non-rejected refused", async () => {
  const h = harness([{ ...HIGH, confidence: "low" }]);
  await h.stage.process(candidate());
  const res = await h.stage.fileAnyway("42");
  expect(res.ok && res.record.overridden).toBe(true);
  expect(h.filed[0]!.extra.overridden).toBe(true);
  expect(h.stage.rejected()).toHaveLength(0);
  expect(await h.stage.fileAnyway("42")).toEqual({ ok: false, code: "not-rejected" });
  expect(await h.stage.fileAnyway("nope")).toEqual({ ok: false, code: "unknown" });
  expect(h.filed).toHaveLength(1);
});

test("fileAnyway after an agent failure files without triage sections", async () => {
  const h = harness([new PluginAgentError("no-output", "x")]);
  await h.stage.process(candidate());
  await h.stage.fileAnyway("42");
  expect(h.filed[0]!.extra).toEqual({ untrusted: [], overridden: true });
});

function routes(stage: ReturnType<typeof harness>["stage"], onChange?: () => void) {
  const handlers = new Map<string, PluginRouteHandler>();
  registerTriageRoutes(
    { route: (m, p, fn) => void handlers.set(`${m} ${p}`, fn), log: { log() {}, warn() {} } },
    stage,
    onChange,
  );
  const post = (body: string) =>
    handlers.get("POST triage/file-anyway")!(
      new Request("http://x/", { method: "POST", body }),
    ) as Promise<Response>;
  return { handlers, post };
}

test("routes: rejected list + file-anyway status codes", async () => {
  const h = harness([{ ...HIGH, confidence: "low" }]);
  await h.stage.process(candidate());
  let changed = 0;
  const r = routes(h.stage, () => changed++);
  const list = (await r.handlers.get("GET triage/rejected")!(new Request("http://x/"))) as Response;
  expect(((await list.json()) as { sentryId: string }[]).map((x) => x.sentryId)).toEqual(["42"]);

  expect((await r.post("not json")).status).toBe(400);
  expect((await r.post(JSON.stringify({}))).status).toBe(400);
  expect((await r.post(JSON.stringify({ sentryId: "nope" }))).status).toBe(404);
  const ok = await r.post(JSON.stringify({ sentryId: "42" }));
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("Filed #101");
  expect(changed).toBe(1);
  expect((await r.post(JSON.stringify({ sentryId: "42" }))).status).toBe(409);
});

test("routes: file error → 500, record stays rejected", async () => {
  const h = harness([{ ...HIGH, confidence: "low" }]);
  await h.stage.process(candidate());
  h.failFile(new Error("forge down"));
  expect((await routes(h.stage).post(JSON.stringify({ sentryId: "42" }))).status).toBe(500);
  expect(h.stage.rejected()).toHaveLength(1);
});

test("rejected panel node is a valid settings-panel view (empty + populated)", async () => {
  const h = harness([{ ...HIGH, confidence: "low" }]);
  for (let i = 0; i < 60; i++) await h.stage.process(candidate({ sentryId: String(i) }));
  for (const records of [[], h.stage.rejected()]) {
    for (const locale of ["en", "de"] as const) {
      const view = {
        schemaVersion: 1 as const,
        slot: "settings-panel" as const,
        title: "Sentry",
        root: rejectedPanelNode(records, locale),
      };
      expect(validatePluginUIView(view)).not.toBeNull();
    }
  }
});

test("EN + DE triage strings have identical keys", () => {
  expect(Object.keys(TRIAGE_STRINGS.de).sort()).toEqual(Object.keys(TRIAGE_STRINGS.en).sort());
});
