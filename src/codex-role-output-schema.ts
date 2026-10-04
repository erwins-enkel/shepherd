import { join } from "node:path";

/** Host dir holding every `--output-schema` file. It lives in the Shepherd checkout under `$HOME`,
 *  which the bwrap membrane tmpfs's — so a wrapped codex role needs it bound (sandbox.ts
 *  `codexCliFlags`), or codex aborts at startup with "Failed to read output schema file" (#2595). */
export const CODEX_ROLE_SCHEMA_DIR = join(import.meta.dir, "codex-role-schemas");

const schemaPath = (filename: string): string => join(CODEX_ROLE_SCHEMA_DIR, filename);

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
