// Types for the node-run env-schema ⇒ docs parity gate
// (scripts/check-env-schema-docs.mjs). The gate stays plain .mjs so
// `node scripts/check-env-schema-docs.mjs` works as a bare CLI in every context (the
// package script, the pre-push gates lane, the CI step); this declaration only exists
// so its TypeScript importer — test/check-env-schema-docs.test.ts — gets real types
// instead of `any`. Mirrors scripts/check-model-mirror.d.mts's role.

/** One key declared in `.env.schema`, with the decorators attached to it. */
export interface SchemaKey {
  /** The variable name, e.g. "SHEPHERD_PORT". */
  key: string;
  /** Carries `@auditIgnore` — varlock cannot see its read site; catalogued, not enforced. */
  auditIgnore: boolean;
  /** Carries `@docsExempt` — contributor-only, deliberately absent from the docs page. */
  docsExempt: boolean;
}

export interface DocsParityResult {
  /** True when both delta lists are empty. */
  ok: boolean;
  /** Gated keys with no row on the Configuration page. */
  missingDocs: string[];
  /** Rows naming a key `.env.schema` does not declare (typo, or a removed key). */
  unknownRows: string[];
  /** How many keys the rule actually gated — 0 means the comparison was vacuous. */
  gatedCount: number;
  /** How many rows the docs parser found. */
  documentedCount: number;
}

/** Every key declared in a `.env.schema` source, in file order. */
export function parseSchemaKeys(source: string): SchemaKey[];

/** Does this key have to appear on the docs page? */
export function requiresDocs(key: SchemaKey): boolean;

/** Keys documented by a `configuration.md` source (first cell of every variable-table row). */
export function parseDocumentedKeys(source: string): Set<string>;

/** Compare the two sides, as structured deltas. */
export function compare(schemaKeys: SchemaKey[], documented: Set<string>): DocsParityResult;
