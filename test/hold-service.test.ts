// HoldReasonService (feeds GET /api/holds and the herd's attention): the Operator Assistant is not
// herd work, so it never holds — not on the boot seed and not on a later event (#1446).
import { test, expect } from "bun:test";
import { HoldReasonService } from "../src/hold-service";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import type { HoldReason } from "../src/types";

function blockedRow(store: SessionStore, name: string, operatorAssistant?: boolean) {
  const s = store.create({
    name,
    prompt: "x",
    repoPath: `/${name}`,
    baseBranch: operatorAssistant ? "" : "main",
    branch: operatorAssistant ? null : `shepherd/${name}`,
    worktreePath: `/${name}`,
    isolated: false,
    herdrSession: "default",
    herdrAgentId: `term_${name}`,
    operatorAssistant,
  });
  store.update(s.id, { status: "blocked" });
  return s;
}

test("the Operator Assistant never holds; a blocked task beside it does", () => {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const task = blockedRow(store, "task");
  const assistant = blockedRow(store, "assistant", true);
  const changes: { id: string; hold: HoldReason | null }[] = [];
  const holds = new HoldReasonService({
    store,
    events,
    gitSnapshot: () => ({}),
    reviewSnapshot: () => ({}),
    gateSnapshot: () => ({}),
    recapSnapshot: () => ({}),
    onChange: (id, hold) => changes.push({ id, hold }),
  });

  expect(Object.keys(holds.snapshot())).toEqual([task.id]); // the boot seed
  events.emit("session:status", { id: assistant.id, status: "blocked" });
  expect(Object.keys(holds.snapshot())).toEqual([task.id]); // a later event
  expect(changes.map((c) => c.id)).toEqual([task.id]);
  holds.dispose();
});
