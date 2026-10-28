import type { BlockReason } from "../../src/blocked";
import type { HoldReason } from "../../src/types";
import type { validateIconPatch } from "../../src/validate";

/** Payloads the stubbed server cannot emit itself. `held:changed` and `session:working-blocked`
 *  come from inline object literals (src/held-release.ts:83, src/index.ts:1236), so those two are
 *  annotated structurally; the others carry the server's own type, so `bun run typecheck` fails
 *  before the shape can drift. */
export const heldChangedEvent: { count: number } = { count: 3 };
export const workingBlockedEvent: { id: string; working: boolean } = {
  id: "sess_fixture",
  working: true,
};
export const backgroundBusyEvent: { id: string; busy: boolean } = {
  id: "sess_fixture",
  busy: true,
};
export const hold: HoldReason = { code: "quota-rework", params: { round: 2, cap: 5 } };
export const block: BlockReason = {
  shape: "quota",
  options: [],
  tail: ["rework budget spent"],
  quotaKind: "rework",
  // #3165: proves the AskUserQuestion payload against the contract on both the snapshot and event.
  ask: {
    toolUseId: "toolu_1",
    questions: [
      {
        question: "Pick a color?",
        header: "Color",
        multiSelect: false,
        options: [
          { label: "Red", description: "warm" },
          { label: "Blue", description: "cool" },
        ],
      },
    ],
  },
};

/** PUT /api/project-icons bodies, typed as what the server's validator returns. `iconInvalid`
 *  passes the schema (it carries no length bound on `emoji`) but breaks the server's 8-code-point
 *  rule, so the 400 it gets proves the rule the schema only describes. */
type IconPatch = NonNullable<ReturnType<typeof validateIconPatch>>;
export const iconSet: IconPatch = { path: "/repos/fixture", emoji: "🐑" };
export const iconClear: IconPatch = { path: "/repos/fixture", emoji: "" };
export const iconInvalid: IconPatch = { path: "/repos/fixture", emoji: "🐑".repeat(9) };
