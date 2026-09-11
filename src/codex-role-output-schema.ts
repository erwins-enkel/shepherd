import { join } from "node:path";

const schemaPath = (filename: string): string =>
  join(import.meta.dir, "codex-role-schemas", filename);

export const CODEX_ROLE_OUTPUT_SCHEMAS = {
  autopilot: schemaPath("autopilot.json"),
  recap: schemaPath("recap.json"),
  planReview: schemaPath("plan-review.json"),
  critic: schemaPath("critic.json"),
  criticWithPlan: schemaPath("critic-with-plan.json"),
  distiller: schemaPath("distiller.json"),
  optimizer: schemaPath("optimizer.json"),
  mergeIntra: schemaPath("merge-intra.json"),
  mergeCross: schemaPath("merge-cross.json"),
} as const;
