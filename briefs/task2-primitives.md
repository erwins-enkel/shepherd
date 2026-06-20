# Task 2 — UI filter primitives: `hideSubIssues` pure fn + store field

## Where this fits

Feature: hide GitHub native sub-issues by default in the backlog issue list. Task 1 (done)
made `/api/epics` return `{ epics, subIssues }` where `subIssues: number[]` is the set of
native sub-issue issue numbers. This task adds the two **pure/leaf** primitives the
components (Task 3) will consume. **Only touch these two files + the unit test.** Do NOT
touch any `.svelte` component, `api.ts`, or messages — that's Task 3.

## Change 1 — `ui/src/lib/components/issues-panel.ts`

Add a pure filter mirroring the existing `hideActive`/`hideOthers` style (same file). Add
at the end of the file:

```ts
/**
 * Narrow an issue list to hide native sub-issues (children of a GitHub epic),
 * nudging the operator to start an epic drain instead of draining a child alone.
 *
 * Hides an issue only when it is a native sub-issue (`subIssues.has(number)`) AND
 * not itself an epic parent (`!epicParents.has(number)`) — so a mid-level epic
 * (a sub-issue that is also a parent) stays visible as a drain entry point.
 *
 * Fails open — returns every issue unchanged — when `enabled` is false or
 * `subIssues` is empty (non-GitHub forge / drain-absent / epics not yet loaded).
 */
export function hideSubIssues(
  issues: readonly Issue[],
  enabled: boolean,
  subIssues: ReadonlySet<number>,
  epicParents: ReadonlySet<number>,
): Issue[] {
  if (!enabled) return [...issues];
  return issues.filter((issue) => !(subIssues.has(issue.number) && !epicParents.has(issue.number)));
}
```

## Change 2 — `ui/src/lib/issues-filter.svelte.ts`

Add a third filter to the shared store, **default ON** (hidden), mirroring `hideOthers`
exactly (absence of key = on; persist only the "off" value `"0"`). Concretely:

- Add a key constant near the others:
  `// "Hide sub-issues" filter: drop native sub-issues (children of an epic). Default ON —
//  absence of the key means "on", so "0" is the value we persist.`
  `const KEY_SUB = "shepherd:issues-hide-subissues";`
- Add a reader mirroring `read()`:
  ```ts
  function readSub(): boolean {
    try {
      // Default true: only an explicit "0" turns it off.
      return localStorage.getItem(KEY_SUB) !== "0";
    } catch {
      return true;
    }
  }
  ```
- In `class IssuesFilter` add:
  ```ts
  hideSubIssues = $state(readSub());
  toggleSubIssues() {
    this.setSubIssues(!this.hideSubIssues);
  }
  setSubIssues(v: boolean) {
    this.hideSubIssues = v;
    try {
      if (v) localStorage.removeItem(KEY_SUB);
      else localStorage.setItem(KEY_SUB, "0");
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }
  ```

## Tests — `ui/src/lib/components/issues-panel.test.ts` (REQUIRED, must fail pre-change)

Add a `describe("hideSubIssues", ...)` block. Import `hideSubIssues` from `./issues-panel`.
Cover (these would all throw/fail before the function exists):

1. enabled, an issue in `subIssues` but NOT in `epicParents` → **dropped**.
2. enabled, an issue in BOTH `subIssues` and `epicParents` (mid-level epic) → **kept**.
3. enabled, an issue absent from `subIssues` → **kept**.
4. `enabled = false` → identity (all issues returned).
5. empty `subIssues` set → identity (all kept).
   Use `new Set<number>([...])` for the args. Reuse the file's existing `issue(...)` helper.

## Constraints

- Match the existing code style/comments in both files. No new dependencies.
- Run and PASTE OUTPUT: `cd ui && bun run test` (vitest) and `cd ui && bun run check`
  (svelte-check). Both must pass. (Deps already installed under `ui/`.)
- Do NOT touch `.svelte` files, `api.ts`, or `ui/messages/*`.
- Concise conventional-commit subject (e.g. `feat(ui): add hideSubIssues filter primitive + store field`).

## Report

Write full report to `briefs/task2-report.md` (status, files, commit sha, the exact
`bun run test` + `bun run check` output, concerns). Return only: status, commit sha,
one-line test summary, concerns.
