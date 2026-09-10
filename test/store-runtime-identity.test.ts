import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";

const base = {
  name: "runtime-identity-test",
  prompt: "test session",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/runtime-identity",
  worktreePath: "/r-wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
};

// The runtime columns are read through READ_COLS and deliberately absent from COLS, which is bound
// to create()'s hand-counted VALUES placeholder list. Adding them there would break every create —
// this is the test that catches it.
test("create() still works after the runtime-identity migration, with both fields unobserved", () => {
  const s = new SessionStore(":memory:");
  const row = s.create(base);
  expect(row.runtimeModel).toBeNull();
  expect(row.runtimeEffort).toBeNull();
  expect(s.get(row.id)?.runtimeModel).toBeNull();
  expect(s.get(row.id)?.runtimeEffort).toBeNull();
});

test("setRuntimeIdentity persists both fields", () => {
  const s = new SessionStore(":memory:");
  const row = s.create(base);
  s.setRuntimeIdentity(row.id, { runtimeModel: "gpt-6-astra", runtimeEffort: "high" });
  const got = s.get(row.id);
  expect(got?.runtimeModel).toBe("gpt-6-astra");
  expect(got?.runtimeEffort).toBe("high");
});

test("setRuntimeIdentity is partial: writing one field preserves the other", () => {
  const s = new SessionStore(":memory:");
  const row = s.create(base);
  s.setRuntimeIdentity(row.id, { runtimeModel: "gpt-6-astra", runtimeEffort: "high" });

  // A model-only signal (Codex provenance before the first turn_context, or any Claude transcript)
  // must not drag the known effort away with it.
  s.setRuntimeIdentity(row.id, { runtimeModel: "gpt-5.6-sol" });
  expect(s.get(row.id)?.runtimeModel).toBe("gpt-5.6-sol");
  expect(s.get(row.id)?.runtimeEffort).toBe("high");

  // …and the mirror case: an effort-only signal keeps the model.
  s.setRuntimeIdentity(row.id, { runtimeEffort: "max" });
  expect(s.get(row.id)?.runtimeModel).toBe("gpt-5.6-sol");
  expect(s.get(row.id)?.runtimeEffort).toBe("max");
});

test("setRuntimeIdentity fills a missing field without touching the stored one", () => {
  const s = new SessionStore(":memory:");
  const row = s.create(base);
  s.setRuntimeIdentity(row.id, { runtimeModel: "gpt-6-astra" });
  expect(s.get(row.id)?.runtimeEffort).toBeNull();
  s.setRuntimeIdentity(row.id, { runtimeEffort: "high" });
  expect(s.get(row.id)?.runtimeModel).toBe("gpt-6-astra");
  expect(s.get(row.id)?.runtimeEffort).toBe("high");
});

test("setRuntimeIdentity leaves updatedAt alone (it runs off the per-tick probe path)", () => {
  const s = new SessionStore(":memory:");
  const row = s.create(base);
  const before = s.get(row.id)!.updatedAt;
  s.setRuntimeIdentity(row.id, { runtimeModel: "gpt-6-astra" });
  expect(s.get(row.id)?.updatedAt).toBe(before);
});

test("setRuntimeIdentity with nothing observed is a no-op", () => {
  const s = new SessionStore(":memory:");
  const row = s.create(base);
  s.setRuntimeIdentity(row.id, { runtimeModel: "gpt-6-astra", runtimeEffort: "high" });
  s.setRuntimeIdentity(row.id, {});
  expect(s.get(row.id)?.runtimeModel).toBe("gpt-6-astra");
  expect(s.get(row.id)?.runtimeEffort).toBe("high");
});

const codexRow = { ...base, agentProvider: "codex" as const, providerSessionId: "roll-1" };
const claudeRow = { ...base, agentProvider: "claude" as const, claudeSessionId: "sess-1" };

test("candidate query is per FIELD for codex and model-only for claude", () => {
  const s = new SessionStore(":memory:");
  const codexBoth = s.create(codexRow);
  const codexModelOnly = s.create(codexRow);
  const codexDone = s.create(codexRow);
  const claudeOpen = s.create(claudeRow);
  const claudeModelOnly = s.create(claudeRow);

  s.setRuntimeIdentity(codexModelOnly.id, { runtimeModel: "gpt-6-astra" });
  s.setRuntimeIdentity(codexDone.id, { runtimeModel: "gpt-6-astra", runtimeEffort: "high" });
  s.setRuntimeIdentity(claudeModelOnly.id, { runtimeModel: "claude-opus-5" });

  const ids = new Set(s.listIncompleteRuntimeIdentity().map((r) => r.id));
  expect(ids.has(codexBoth.id)).toBe(true);
  // A codex row missing only the effort stays a candidate — a later rollout can still report it.
  expect(ids.has(codexModelOnly.id)).toBe(true);
  expect(ids.has(codexDone.id)).toBe(false);
  expect(ids.has(claudeOpen.id)).toBe(true);
  // A claude row is never asked about effort: no Claude transcript records one, so keeping it a
  // candidate would re-read it on every boot for a value that can never arrive.
  expect(ids.has(claudeModelOnly.id)).toBe(false);
});

test("candidate query honors its row cap", () => {
  const s = new SessionStore(":memory:");
  for (let i = 0; i < 5; i++) s.create(codexRow);
  expect(s.listIncompleteRuntimeIdentity(2).length).toBe(2);
});

// Without a session id there is no transcript to resolve, so such a row can never be filled —
// keeping it a candidate would burn a cap slot on every boot forever. A clean terminal (no agent,
// hence no id) is the case that makes this bite.
test("rows with no usable session id are not candidates", () => {
  const s = new SessionStore(":memory:");
  const codexNoId = s.create({ ...base, agentProvider: "codex" });
  const claudeNoId = s.create({ ...base, agentProvider: "claude", claudeSessionId: "" });
  const resolvable = s.create(codexRow);

  const ids = new Set(s.listIncompleteRuntimeIdentity().map((r) => r.id));
  expect(ids.has(codexNoId.id)).toBe(false);
  expect(ids.has(claudeNoId.id)).toBe(false);
  expect(ids.has(resolvable.id)).toBe(true);
});
