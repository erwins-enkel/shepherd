import { test, expect } from "bun:test";
import { DistillerService } from "../src/distiller";
import { SessionStore } from "../src/store";

function seedSignals(store: SessionStore, repo: string, n: number) {
  for (let i = 0; i < n; i++) {
    store.addSignal({ repoPath: repo, sessionId: null, kind: "reply", payload: `correction ${i}` });
  }
}

function mkDeps(store: SessionStore, proposals: any, onChange = () => {}) {
  const started: { dir: string }[] = [];
  return {
    deps: {
      store,
      herdr: { start: () => ({ terminalId: "dist1" }), stop: () => {} } as any,
      scratch: {
        create: () => {
          const d = { dir: `/scratch/${started.length}` };
          started.push(d);
          return d;
        },
        remove: () => {},
      },
      onChange,
      now: () => 1000,
      minSignals: 3,
      writeSignals: () => {},
      readProposals: () => proposals,
    },
    started,
  };
}

test("consider spawns when enough new signals, tick stores proposed learnings", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const { deps } = mkDeps(store, {
    rules: [{ rule: "use bun not npm", rationale: "repo is bun", evidence: ["x"] }],
  });
  const d = new DistillerService(deps as any);
  d.consider("/r");
  await d.tick();
  const learnings = store.listLearnings("/r", { status: "proposed" });
  expect(learnings.length).toBe(1);
  expect(learnings[0]!.rule).toBe("use bun not npm");
});

test("consider does nothing below the signal threshold", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 2);
  const { deps, started } = mkDeps(store, { rules: [] });
  const d = new DistillerService(deps as any);
  d.consider("/r");
  expect(started.length).toBe(0);
});

test("distillNow forces a run regardless of threshold", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 1);
  const { deps, started } = mkDeps(store, { rules: [] });
  const d = new DistillerService(deps as any);
  d.distillNow("/r");
  expect(started.length).toBe(1);
});

test("duplicate rule text is not re-proposed", async () => {
  const store = new SessionStore(":memory:");
  store.addLearning({ repoPath: "/r", rule: "use bun not npm", rationale: "", evidence: [] });
  seedSignals(store, "/r", 3);
  const { deps } = mkDeps(store, {
    rules: [{ rule: "Use Bun not npm", rationale: "dup", evidence: [] }],
  });
  const d = new DistillerService(deps as any);
  d.distillNow("/r");
  await d.tick();
  expect(store.listLearnings("/r").length).toBe(1); // unchanged
});

test("onChange fires after a run that produced rules", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  let fired = 0;
  const { deps } = mkDeps(
    store,
    { rules: [{ rule: "x", rationale: "", evidence: [] }] },
    () => fired++,
  );
  const d = new DistillerService(deps as any);
  d.distillNow("/r");
  await d.tick();
  expect(fired).toBe(1);
});

test("spawn argv follows the safe critic contract (dontAsk after allowlist, bare Write, no skip-permissions)", () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  let argv: string[] = [];
  const deps = {
    store,
    herdr: {
      start: (_name: string, _cwd: string, a: string[]) => {
        argv = a;
        return { terminalId: "d1" };
      },
      stop: () => {},
    } as any,
    scratch: { create: () => ({ dir: "/scratch" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
    minSignals: 3,
    writeSignals: () => {},
    readProposals: () => null,
  };
  const d = new DistillerService(deps as any);
  d.distillNow("/r");

  expect(argv).not.toContain("--dangerously-skip-permissions");
  const allow = argv.indexOf("--allowedTools");
  const mode = argv.indexOf("--permission-mode");
  expect(allow).toBeGreaterThan(-1);
  expect(mode).toBeGreaterThan(allow); // dontAsk MUST come after the variadic allowlist
  expect(argv[mode + 1]).toBe("dontAsk");
  // bare Write (not path-scoped) and it sits within the allowlist, before --permission-mode
  const write = argv.indexOf("Write");
  expect(write).toBeGreaterThan(allow);
  expect(write).toBeLessThan(mode);
  // disableAllHooks settings present
  expect(argv).toContain('{"disableAllHooks":true}');
  // the prompt is the trailing positional (last arg), after --permission-mode dontAsk
  expect(argv.length).toBeGreaterThan(mode + 2);
});

test("tick finalizes and reaps a run that times out without proposals", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  let t = 1000;
  let stopped = 0;
  let removed = 0;
  let starts = 0;
  const deps = {
    store,
    herdr: {
      start: () => {
        starts++;
        return { terminalId: `d${starts}` };
      },
      stop: () => stopped++,
    } as any,
    scratch: { create: () => ({ dir: `/scratch/${starts}` }), remove: () => removed++ },
    onChange: () => {},
    now: () => t,
    timeoutMs: 5_000,
    minSignals: 3,
    writeSignals: () => {},
    readProposals: () => null, // proposals never written
  };
  const d = new DistillerService(deps as any);
  d.distillNow("/r");
  expect(starts).toBe(1);
  await d.tick(); // not yet timed out
  expect(stopped).toBe(0);
  t += 6_000; // now past timeoutMs
  await d.tick();
  expect(stopped).toBe(1);
  expect(removed).toBe(1);
  expect(store.listLearnings("/r").length).toBe(0); // no proposals → nothing added
  d.distillNow("/r"); // inflight cleared → a new run can start
  expect(starts).toBe(2);
});

test("distillNow with zero signals does not spawn a run", () => {
  const store = new SessionStore(":memory:");
  const { deps, started } = mkDeps(store, { rules: [] }); // no signals seeded
  const d = new DistillerService(deps as any);
  d.distillNow("/r");
  expect(started.length).toBe(0);
});

test("dismissed rules are passed to the distiller so they aren't re-proposed", () => {
  const store = new SessionStore(":memory:");
  const dis = store.addLearning({
    repoPath: "/r",
    rule: "dismissed rule",
    rationale: "",
    evidence: [],
  });
  store.setLearningStatus(dis.id, "dismissed");
  seedSignals(store, "/r", 3);
  let captured: string[] = [];
  const deps = {
    store,
    herdr: { start: () => ({ terminalId: "d1" }), stop: () => {} } as any,
    scratch: { create: () => ({ dir: "/s" }), remove: () => {} },
    onChange: () => {},
    now: () => 1000,
    minSignals: 3,
    writeSignals: (_dir: string, _sigs: unknown, existingRules: string[]) => {
      captured = existingRules;
    },
    readProposals: () => null,
  };
  const d = new DistillerService(deps as any);
  d.distillNow("/r");
  expect(captured).toContain("dismissed rule");
});
