import type { BlockReason } from "../../src/blocked";
import type { HoldReason } from "../../src/types";

/** Payloads the stubbed server cannot emit itself. `held:changed` and `session:working-blocked`
 *  come from inline object literals (src/held-release.ts:83, src/index.ts:1236), so those two are
 *  annotated structurally; the others carry the server's own type, so `bun run typecheck` fails
 *  before the shape can drift. */
export const heldChangedEvent: { count: number } = { count: 3 };
export const workingBlockedEvent: { id: string; working: boolean } = {
  id: "sess_fixture",
  working: true,
};
export const hold: HoldReason = { code: "quota-rework", params: { round: 2, cap: 5 } };
export const block: BlockReason = {
  shape: "quota",
  options: [],
  tail: ["rework budget spent"],
  quotaKind: "rework",
};
