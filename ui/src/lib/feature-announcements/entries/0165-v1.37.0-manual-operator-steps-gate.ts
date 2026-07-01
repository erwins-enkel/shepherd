import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // P2 of the manual-operator-steps epic (#1060): those declared steps now GATE auto-merge. A PR
  // with an un-acked, non-POST-MERGE step is held out of the merge train with a clear reason; an
  // "Ack steps" button on the session row clears the gate, and you're nudged via push + the daily
  // rundown. POST-MERGE-only steps never block. No targetId — the chip/CTA mount only when steps
  // are detected; surface via the What's-New drawer only. Ships in 1.37.0 alongside P1.
  id: "manual-operator-steps-gate",
  sinceVersion: "1.37.0",
  titleKey: "feat_manual_operator_steps_gate_title",
  bodyKey: "feat_manual_operator_steps_gate_body",
} satisfies FeatureAnnouncement;

export default entry;
