// Pure helpers for the Readiness greenfield profile (#3107) — kept out of the .svelte file so they
// are unit-testable without a DOM. The report itself comes from `/api/readiness/greenfield`.
import type { GreenfieldItem, GreenfieldItemId, GreenfieldReport } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

/** The gate's placeholder while a repo's greenfield scan hasn't landed (mirrors src/bootstrap.ts). */
export const READINESS_PENDING = "readiness_pending";

/** Must-haves then nice-to-haves, each in server order. */
export function greenfieldGroups(r: GreenfieldReport): {
  must: GreenfieldItem[];
  nice: GreenfieldItem[];
} {
  return {
    must: r.items.filter((i) => i.tier === "must"),
    nice: r.items.filter((i) => i.tier === "nice"),
  };
}

/** Red items first, each half in its given order — what still holds the gate leads the list. */
export function redFirst(items: GreenfieldItem[]): GreenfieldItem[] {
  return [...items.filter((i) => !i.present), ...items.filter((i) => i.present)];
}

/** Items the operator supplies rather than a bootstrap session: the PRD and design are the
 *  inputs, and forge settings are applied from the Readiness tab (src/bootstrap-directive.ts). */
export function greenfieldByOperator(id: GreenfieldItemId): boolean {
  return id === "forge_settings" || id === "prd" || id === "design_export";
}

// Explicit switches (not dynamic m[`…${id}`]) keep the keys statically analysable.
/** A must-have's one-word label under its gate segment; other items fall back to the title. */
export function greenfieldShort(id: GreenfieldItemId): string {
  switch (id) {
    case "stack_pinned":
      return m.readiness_gf_stack_pinned_short();
    case "scaffold_builds":
      return m.readiness_gf_scaffold_builds_short();
    case "ci_on_main":
      return m.readiness_gf_ci_on_main_short();
    case "hooks_pre_push":
      return m.readiness_gf_hooks_pre_push_short();
    case "dead_code_audit":
      return m.readiness_gf_dead_code_audit_short();
    case "forge_settings":
      return m.readiness_gf_forge_settings_short();
    default:
      return greenfieldTitle(id);
  }
}

export function greenfieldTitle(id: GreenfieldItemId): string {
  switch (id) {
    case "stack_pinned":
      return m.readiness_gf_stack_pinned_title();
    case "scaffold_builds":
      return m.readiness_gf_scaffold_builds_title();
    case "ci_on_main":
      return m.readiness_gf_ci_on_main_title();
    case "hooks_pre_push":
      return m.readiness_gf_hooks_pre_push_title();
    case "dead_code_audit":
      return m.readiness_g_dead_code_audit_title();
    case "forge_settings":
      return m.readiness_forge_heading();
    case "prd":
      return m.readiness_gf_prd_title();
    case "design_export":
      return m.readiness_gf_design_export_title();
    case "foundation_decisions":
      return m.readiness_gf_foundation_decisions_title();
    case "issue_templates":
      return m.readiness_g_issue_templates_title();
    case "env_schema":
      return m.readiness_g_env_schema_title();
    case "dependency_automation":
      return m.readiness_g_dependency_automation_title();
  }
}

/** What it takes to turn the item green — shown while it is absent. */
export function greenfieldHint(id: GreenfieldItemId): string {
  switch (id) {
    case "stack_pinned":
      return m.readiness_gf_stack_pinned_hint();
    case "scaffold_builds":
      return m.readiness_gf_scaffold_builds_hint();
    case "ci_on_main":
      return m.readiness_gf_ci_on_main_hint();
    case "hooks_pre_push":
      return m.readiness_gf_hooks_pre_push_hint();
    case "dead_code_audit":
      return m.readiness_gf_dead_code_audit_hint();
    case "forge_settings":
      return m.readiness_gf_forge_settings_hint();
    case "prd":
      return m.readiness_gf_prd_hint();
    case "design_export":
      return m.readiness_gf_design_export_hint();
    case "foundation_decisions":
      return m.readiness_gf_foundation_decisions_hint();
    case "issue_templates":
      return m.readiness_gf_issue_templates_hint();
    case "env_schema":
      return m.readiness_gf_env_schema_hint();
    case "dependency_automation":
      return m.readiness_gf_dependency_automation_hint();
  }
}

const ITEM_IDS = new Set<string>([
  "stack_pinned",
  "scaffold_builds",
  "ci_on_main",
  "hooks_pre_push",
  "dead_code_audit",
  "forge_settings",
  "prd",
  "design_export",
  "foundation_decisions",
  "issue_templates",
  "env_schema",
  "dependency_automation",
]);

/** One entry of a bootstrap hold's `missing` list, localized: a greenfield must-have id or the
 *  pending placeholder reads as its title; phases (`P2`) and unknown ids pass through verbatim. */
export function bootstrapMissingLabel(token: string): string {
  if (token === READINESS_PENDING) return m.readiness_gf_pending();
  return ITEM_IDS.has(token) ? greenfieldTitle(token as GreenfieldItemId) : token;
}
