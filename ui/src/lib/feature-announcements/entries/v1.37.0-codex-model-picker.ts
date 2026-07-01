import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Codex uses its own model family in the New Task picker; the selected alias is passed
  // through to `codex --model`. No targetId because the picker lives in a closed modal.
  id: "codex-model-picker",
  sinceVersion: "1.37.0",
  titleKey: "feat_codex_model_picker_title",
  bodyKey: "feat_codex_model_picker_body",
} satisfies FeatureAnnouncement;

export default entry;
