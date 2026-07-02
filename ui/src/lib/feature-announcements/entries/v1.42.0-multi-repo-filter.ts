import type { FeatureAnnouncement } from "../../feature-announcements";

const entry = {
  // Shift+click repo pills in the herd chip rail to combo-select more than one repo at a time:
  // the herd list (and the Up-Next / Owed / completed-epic lenses) then show sessions from any
  // selected repo. Plain click still selects one; Shift+click toggles a repo in/out; a plain
  // click while several are selected resets to just that one. 1.41.0 is the latest released tag,
  // so this ships in 1.42.0. No targetId — the chips are per-repo and dynamic, so there is no
  // stable single anchor for a coachmark; What's-New only.
  id: "multi-repo-filter",
  sinceVersion: "1.42.0",
  titleKey: "feat_multi_repo_filter_title",
  bodyKey: "feat_multi_repo_filter_body",
} satisfies FeatureAnnouncement;

export default entry;
