// New Project form rules. Mirror pair: src/validate.ts PROJECT_SLUG_RE / PROJECT_IDEA_MAX —
// locked by test/validate.test.ts.

/** Project-name slug rule (the server adds traversal and `.git` checks on top). */
export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** Max idea length in characters, measured after trimming. */
export const PROJECT_IDEA_MAX = 8000;
