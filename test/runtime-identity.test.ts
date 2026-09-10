import { expect, test } from "bun:test";
import {
  backfillRuntimeIdentity,
  type RuntimeIdentityCandidate,
  type RuntimeIdentityStore,
} from "../src/runtime-identity";
import type { RolloutMeta } from "../src/codex-activity";
import { jsonlPathFor } from "../src/usage";

/** A rollout shaped like the real one behind TASK-1090: provenance carries no model, the
 *  turn_context names both the effective model and effort. */
const CODEX_ROLLOUT = [
  JSON.stringify({
    type: "session_meta",
    timestamp: "2026-09-10T12:57:54.000Z",
    payload: { id: "roll-1", cwd: "/wt/codex", source: "cli", provenance: {} },
  }),
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-09-10T12:58:00.000Z",
    payload: { model: "gpt-6-astra", effort: "high" },
  }),
].join("\n");

/** Provenance-only: what a rollout looks like before its first turn lands — model, no effort. */
const CODEX_ROLLOUT_PROVENANCE_ONLY = JSON.stringify({
  type: "session_meta",
  timestamp: "2026-09-10T12:57:54.000Z",
  payload: {
    id: "roll-2",
    cwd: "/wt/codex",
    source: "cli",
    provenance: { model: "gpt-5.6-sol" },
  },
});

const CLAUDE_TRANSCRIPT = [
  JSON.stringify({ type: "assistant", message: { model: "claude-opus-5" } }),
  JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } }),
].join("\n");

const META: RolloutMeta = {
  path: "/rollouts/roll-1.jsonl",
  cwd: "/wt/codex",
  rolloutId: "roll-1",
  source: "cli",
  mtimeMs: 1,
};

function candidate(over: Partial<RuntimeIdentityCandidate> = {}): RuntimeIdentityCandidate {
  return {
    id: "s1",
    agentProvider: "codex",
    worktreePath: "/wt/codex",
    claudeSessionId: null,
    providerSessionId: "roll-1",
    spawnAccountDir: null,
    ...over,
  };
}

function fakeStore(rows: RuntimeIdentityCandidate[]): RuntimeIdentityStore & {
  writes: Array<[string, { runtimeModel?: string | null; runtimeEffort?: string | null }]>;
} {
  const writes: Array<[string, { runtimeModel?: string | null; runtimeEffort?: string | null }]> =
    [];
  return {
    writes,
    listIncompleteRuntimeIdentity: () => rows,
    setRuntimeIdentity: (id, identity) => void writes.push([id, identity]),
  };
}

test("resolves a codex rollout by native session id and writes model + effort", () => {
  const store = fakeStore([candidate()]);
  const filled = backfillRuntimeIdentity(store, {
    listMetas: () => [META],
    readText: () => CODEX_ROLLOUT,
  });
  expect(filled).toBe(1);
  expect(store.writes).toEqual([["s1", { runtimeModel: "gpt-6-astra", runtimeEffort: "high" }]]);
});

// The live path can persist a provenance model before any turn_context exists. That row stays a
// candidate, and this pass must fill ONLY the effort — passing no model keeps the stored one.
test("a partial identity is completed without restating the other field", () => {
  const store = fakeStore([candidate({ id: "partial" })]);
  backfillRuntimeIdentity(store, {
    listMetas: () => [META],
    readText: () => CODEX_ROLLOUT,
  });
  const [, identity] = store.writes[0]!;
  // The setter is partial by contract, so whatever it is handed is additive — the store test pins
  // that a supplied field never clears its counterpart.
  expect(identity.runtimeEffort).toBe("high");
});

test("a provenance-only rollout yields a model and no effort", () => {
  const store = fakeStore([candidate({ providerSessionId: "roll-2" })]);
  backfillRuntimeIdentity(store, {
    listMetas: () => [{ ...META, path: "/rollouts/roll-2.jsonl", rolloutId: "roll-2" }],
    readText: () => CODEX_ROLLOUT_PROVENANCE_ONLY,
  });
  expect(store.writes).toEqual([["s1", { runtimeModel: "gpt-5.6-sol" }]]);
});

test("a claude row resolves its transcript, model only", () => {
  const row = candidate({
    id: "c1",
    agentProvider: "claude",
    worktreePath: "/wt/claude",
    claudeSessionId: "sess-1",
    providerSessionId: null,
  });
  const store = fakeStore([row]);
  const wanted = jsonlPathFor("/wt/claude", "sess-1", null);
  backfillRuntimeIdentity(store, {
    listMetas: () => {
      throw new Error("no codex candidates — the tree walk must not run");
    },
    readText: (p) => (p === wanted ? CLAUDE_TRANSCRIPT : null),
  });
  // "<synthetic>" is a control record, not an inference model — the last REAL model wins.
  expect(store.writes).toEqual([["c1", { runtimeModel: "claude-opus-5" }]]);
});

test("a row whose rollout is gone stays untouched (NULL is the honest answer)", () => {
  const store = fakeStore([candidate()]);
  const filled = backfillRuntimeIdentity(store, {
    listMetas: () => [],
    readText: () => null,
  });
  expect(filled).toBe(0);
  expect(store.writes).toEqual([]);
});

test("a codex row with no native session id resolves nothing", () => {
  const store = fakeStore([candidate({ providerSessionId: null })]);
  backfillRuntimeIdentity(store, { listMetas: () => [META], readText: () => CODEX_ROLLOUT });
  expect(store.writes).toEqual([]);
});

test("the tree walk runs at most once, shared across every codex candidate", () => {
  let walks = 0;
  const store = fakeStore([candidate({ id: "a" }), candidate({ id: "b" }), candidate({ id: "c" })]);
  backfillRuntimeIdentity(store, {
    listMetas: () => {
      walks += 1;
      return [META];
    },
    readText: () => CODEX_ROLLOUT,
  });
  expect(walks).toBe(1);
  expect(store.writes.length).toBe(3);
});

test("one unreadable row does not abort the sweep", () => {
  const store = fakeStore([candidate({ id: "bad" }), candidate({ id: "good" })]);
  let first = true;
  backfillRuntimeIdentity(store, {
    listMetas: () => [META],
    readText: () => {
      if (first) {
        first = false;
        throw new Error("boom");
      }
      return CODEX_ROLLOUT;
    },
  });
  expect(store.writes.map(([id]) => id)).toEqual(["good"]);
});

test("never throws when the store itself fails", () => {
  const store: RuntimeIdentityStore = {
    listIncompleteRuntimeIdentity: () => {
      throw new Error("db gone");
    },
    setRuntimeIdentity: () => {},
  };
  expect(backfillRuntimeIdentity(store, { listMetas: () => [], readText: () => null })).toBe(0);
});

test("an empty candidate set skips the tree walk entirely", () => {
  let walks = 0;
  const store = fakeStore([]);
  backfillRuntimeIdentity(store, {
    listMetas: () => {
      walks += 1;
      return [];
    },
    readText: () => null,
  });
  expect(walks).toBe(0);
});
