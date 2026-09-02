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
    id: "plan-gate",
    kind: "internal",
    termKey: "gloss_plan_gate_term",
    bodyKey: "gloss_plan_gate_def",
  },
  {
    id: "autopilot",
    kind: "internal",
    termKey: "gloss_autopilot_term",
    bodyKey: "gloss_autopilot_def",
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
    id: "first-pass-rate",
    kind: "internal",
    termKey: "gloss_first_pass_rate_term",
    bodyKey: "gloss_first_pass_rate_def",
  },
  {
    id: "first-push-green",
    kind: "internal",
    termKey: "gloss_first_push_green_term",
    bodyKey: "gloss_first_push_green_def",
  },
  {
    id: "plan-drift",
    kind: "internal",
    termKey: "gloss_plan_drift_term",
    bodyKey: "gloss_plan_drift_def",
  },
  {
    id: "maintain-loop",
    kind: "internal",
    termKey: "gloss_maintain_loop_term",
    bodyKey: "gloss_maintain_loop_def",
  },
  {
    id: "band",
    kind: "internal",
    termKey: "gloss_band_term",
    bodyKey: "gloss_band_def",
  },
  {
    id: "lead-time",
    kind: "external",
    termKey: "gloss_lead_time_term",
    bodyKey: "gloss_lead_time_def",
    wikipedia: {
      en: "Lead_time",
      de: "Durchlaufzeit",
    },
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
  {
    id: "herdr-hygiene",
    kind: "internal",
    termKey: "gloss_herdr_hygiene_term",
    bodyKey: "gloss_herdr_hygiene_def",
  },
  {
    id: "sandbox-membrane",
    kind: "internal",
    termKey: "gloss_sandbox_membrane_term",
    bodyKey: "gloss_sandbox_membrane_def",
  },
  {
    id: "inode",
    kind: "external",
    termKey: "gloss_inode_term",
    bodyKey: "gloss_inode_def",
    wikipedia: {
      en: "Inode",
      de: "Inode",
    },
  },
  {
    id: "spawn-prompt",
    kind: "internal",
    termKey: "gloss_spawn_prompt_term",
    bodyKey: "gloss_spawn_prompt_def",
  },
  {
    // Internal, not external, on purpose: the definition describes a token as SHEPHERD mints it
    // (shown once, hashed at rest, individually revocable), and German Wikipedia has no
    // counterpart to the English "Access token" article — an external entry needs a resolving
    // slug in BOTH locales. Keep this note inside the braces: check-glossary.mjs splits the
    // registry on `}` followed by `{`, so a comment BETWEEN two entries silently merges them.
    id: "access-token",
    kind: "internal",
    termKey: "gloss_access_token_term",
    bodyKey: "gloss_access_token_def",
  },
  {
    // Internal: "scope" is an industry term, but what the three LEVELS mean is specific to
    // Shepherd's routes, and that is the part an operator needs at the mint form. Keep this note
    // inside the braces — see the access-token entry above for why.
    id: "token-scope",
    kind: "internal",
    termKey: "gloss_token_scope_term",
    bodyKey: "gloss_token_scope_def",
  },
];

export const glossaryById = new Map<string, GlossaryTerm>(glossary.map((term) => [term.id, term]));
