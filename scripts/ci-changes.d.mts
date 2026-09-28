// Types for the node-run CI path gate (scripts/ci-changes.mjs). The gate stays plain
// .mjs so ci.yml's `changes` job needs only the runner's node; this declaration only
// exists so test/ci-changes.test.ts gets real types instead of `any`.

/** Which gated ci.yml jobs must run, plus a human-readable why. */
export interface Classification {
  /** test-root, test-ui, test-ui-browser. */
  test: boolean;
  site: boolean;
  cli: boolean;
  docs_site: boolean;
  reason: string;
}

/** Which gated jobs must run for this change set. Fails open: unknown paths run everything. */
export function classify(files: string[], opts: { event: string }): Classification;

/** The `$GITHUB_OUTPUT` lines (`key=true|false`) for a classification. */
export function formatOutputs(r: Classification): string;
