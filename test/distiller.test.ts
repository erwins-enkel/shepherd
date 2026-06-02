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
