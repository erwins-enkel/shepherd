// Glossary registry driving inline term tooltips throughout the UI.
//
// CONTRACT: each GlossaryTerm pairs a stable id with i18n keys (termKey /
// bodyKey) that must exist in BOTH ui/messages/en.json and de.json.  Keys
// follow the pattern gloss_<id>_term / gloss_<id>_def.  "internal" terms are
// explained in Shepherd's own words; "external" terms optionally link to a
// Wikipedia article (en + de slugs) for deeper reading.  Do NOT hardcode
// display text here — all user-facing strings live in the message catalogs.

type GlossaryTerm = {
  id: string;
  kind: "internal" | "external";
  termKey: string;
  bodyKey: string;
  wikipedia?: { en: string; de: string };
};

const glossary: readonly GlossaryTerm[] = [
  {
    id: "epic",
    kind: "internal",
    termKey: "gloss_epic_term",
    bodyKey: "gloss_epic_def",
  },
  {
    id: "reasoning-effort",
    kind: "internal",
    termKey: "gloss_reasoning_effort_term",
    bodyKey: "gloss_reasoning_effort_def",
  },
  {
    id: "pr",
    kind: "external",
    termKey: "gloss_pr_term",
    bodyKey: "gloss_pr_def",
    wikipedia: {
      en: "Distributed_version_control#Pull_requests",
      de: "Pull-Request",
    },
  },
  {
    id: "ci",
    kind: "external",
    termKey: "gloss_ci_term",
    bodyKey: "gloss_ci_def",
    wikipedia: {
      en: "Continuous_integration",
      de: "Kontinuierliche_Integration",
    },
  },
  {
    id: "critic",
    kind: "internal",
    termKey: "gloss_critic_term",
    bodyKey: "gloss_critic_def",
  },
  {
    id: "merge-train",
    kind: "internal",
    termKey: "gloss_merge_train_term",
    bodyKey: "gloss_merge_train_def",
  },
  {
    id: "rework",
    kind: "internal",
    termKey: "gloss_rework_term",
    bodyKey: "gloss_rework_def",
  },
  {
    id: "inferred",
    kind: "internal",
    termKey: "gloss_inferred_term",
    bodyKey: "gloss_inferred_def",
  },
  {
    id: "lightweight_repo",
    kind: "internal",
    termKey: "gloss_lightweight_repo_term",
    bodyKey: "gloss_lightweight_repo_def",
  },
  {
    id: "trial",
    kind: "internal",
    termKey: "gloss_trial_term",
    bodyKey: "gloss_trial_def",
  },
  {
    id: "weighted-units",
    kind: "internal",
    termKey: "gloss_weighted_units_term",
    bodyKey: "gloss_weighted_units_def",
  },
  {
    id: "satellite-pass",
    kind: "internal",
    termKey: "gloss_satellite_pass_term",
    bodyKey: "gloss_satellite_pass_def",
  },
  {
    id: "telemetry",
    kind: "external",
    termKey: "gloss_telemetry_term",
    bodyKey: "gloss_telemetry_def",
    wikipedia: {
      en: "Telemetry#Software",
      de: "Telemetrie_(Software)",
    },
  },
  {
    id: "host-capacity",
    kind: "internal",
    termKey: "gloss_host_capacity_term",
    bodyKey: "gloss_host_capacity_def",
  },
];

export const glossaryById = new Map<string, GlossaryTerm>(glossary.map((term) => [term.id, term]));
