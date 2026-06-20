# Task 1 — Server: surface native sub-issue numbers via the existing `/api/epics` sweep

## Where this fits

Feature: hide GitHub **native sub-issues** by default in the backlog issue list. The UI
(later tasks) needs to know which open issues are native sub-issues. Both issue-list
panels already call `getEpics()` → `GET /api/epics`, which already runs ONE paginated
open-issue GraphQL sweep via `forge.listSubIssueSummaries()`. Your job: piggyback on that
**same sweep** to also collect the set of native sub-issue child numbers and return it in
the `/api/epics` payload. **Do NOT touch `/api/issues` / `handleIssues`. Do NOT touch any
`ui/` file.** Server + root tests only.

## Spike result (already verified — rely on it)

`gh api graphql` accepts `Issue.parent { number }` with **no** preview / `GraphQL-Features`
header (parity with `subIssuesSummary`). Per-node wire shape:
`{ number, subIssuesSummary: { total, completed } | null, parent: { number } | null }`.
A node is a native sub-issue iff `parent != null`.

## Exact changes

### 1. `src/forge/github.ts`

- `listSubIssueSummaries` (~`:1013`): extend the GraphQL query node from
  `nodes{number subIssuesSummary{total completed}}` to
  `nodes{number subIssuesSummary{total completed} parent{number}}`. Broaden the method's
  return from `Promise<Map<number,{total,completed}>>` to
  `Promise<{ summaries: Map<number,{total,completed}>; subIssueNumbers: number[] }>`.
  Build a `subIssueNumbers` array/set alongside the existing `result` map across pages.
  Keep `MAX_SUMMARY_PAGES` paging and the `catch` → on failure return
  `{ summaries: new Map(), subIssueNumbers: [] }`.
- `collectSubIssueSummaryPage` (~`:43`): add a third param to collect sub-issue child
  numbers, e.g. `collectSubIssueSummaryPage(out, intoSummaries, intoSubIssues: Set<number>)`.
  Widen the parsed node type to include `parent?: { number: number } | null`. For every
  node with non-null `parent`, add `node.number` to `intoSubIssues`. (Keep the existing
  `subIssuesSummary.total > 0` → `intoSummaries` logic unchanged.)

### 2. `src/forge/types.ts`

- Update the `GitForge` optional method declaration (~`:382`) to the new return type:
  `listSubIssueSummaries?(): Promise<{ summaries: Map<number,{total,completed}>; subIssueNumbers: number[] }>;`
  Update its doc comment to mention it now also returns native sub-issue (child) numbers.

### 3. `src/server.ts`

- `fetchNativeSummaries` (~`:3739`) + its `NativeSummaryMap` type: keep feeding the
  **summaries map** to `buildEpicCandidates`/`buildEpicSummaries` (those stay unchanged),
  but broaden this helper to also surface `subIssueNumbers`. Change its return to the
  object `{ summaries: Map<...>; subIssueNumbers: number[] }`. **BOTH** fail-open paths
  must return the object: the `?? { summaries: new Map(), subIssueNumbers: [] }` default
  AND the `catch { return { summaries: new Map(), subIssueNumbers: [] }; }`.
- `handleEpicsList` (~`:3837`): it currently calls
  `const nativeSummaries = await fetchNativeSummaries(forge);` then passes
  `nativeSummaries` (a Map) to `buildEpicCandidates`/`buildEpicSummaries`. Destructure:
  `const { summaries: nativeSummaries, subIssueNumbers } = await fetchNativeSummaries(forge);`
  and keep passing `nativeSummaries` to the builders unchanged.
- **Convert ALL FOUR non-error returns of `handleEpicsList` to the object shape**
  `{ epics, subIssues }` so the client never sees a bare array:
  - `if (!deps.drain) return json([]);` → `return json({ epics: [], subIssues: [] });`
  - `if (!forge) return json([]);` → `return json({ epics: [], subIssues: [] });`
  - the `listIssues` `catch { ... return json([]); }` → `return json({ epics: [], subIssues: [] });`
  - final `return json(result);` → `return json({ epics: result, subIssues: subIssueNumbers });`
  - Leave the `{ error: ... }, 400` validation returns exactly as-is.

## Tests (root: `bun test ./test`) — REQUIRED, write/update in this same commit

**New tests** (must fail against pre-change code):

- `collectSubIssueSummaryPage` (unit, in the existing github forge test file or a sibling):
  feed a synthetic GraphQL page string with mixed nodes — one with `parent:{number:7}`,
  one with `parent:null`, one with `subIssuesSummary.total>0` — assert `intoSubIssues`
  contains exactly the child numbers with non-null parent, and the summaries map is
  unchanged behavior.
- `handleEpicsList` shape: assert the happy path returns `{ epics: [...], subIssues: [...] }`
  and that each non-error fallback (`!deps.drain`, `!forge`, listIssues throws) returns
  `{ epics: [], subIssues: [] }`.

**Update existing tests that break on the new shapes** (do NOT skip any — root suite must
stay green):

- `test/forge/github-epic.test.ts` — assertions at ~`:99, :111, :138, :167` read the old
  `Map` return of `listSubIssueSummaries`; update them to read `.summaries` and (where
  sensible) assert `subIssueNumbers`.
- `test/epic-server.test.ts`:
  - the `listSubIssueSummaries: async () => summaryMap` mocks at ~`:566, :597, :625,
:645, :678` must return `{ summaries: summaryMap, subIssueNumbers: [...] }`.
  - **EVERY** array-shaped body assertion in the `GET /api/epics` describe block
    (`describe("GET /api/epics"` ~`:307`) — the body is now `{ epics, subIssues }`, so
    change `body` → `body.epics`. Concretely: `body.length`/`body[0]` at ~`:346–348,
:395–397, :432–435, :463–466, :497–499, :521–524, :550–553, :573–577, :603–607,
:631–632`; `body.find(...)` at ~`:652, :705–706`; `expect(body).toEqual([])` at
    ~`:667` → `expect(body.epics).toEqual([])`. (Line numbers are approximate — find them
    by content; there are ~15.)

## Constraints

- Conventional-commit, concise subject (e.g. `feat(epics): surface native sub-issue numbers in /api/epics`).
- This change ships no user-facing UI itself; if the feature-catalog gate ever fired here
  it would be a false positive — but it won't (no `ui/` files touched). Do not add a
  feature entry.
- Run and PASTE OUTPUT for: `bun run lint` and `bun test ./test`. Both must pass.
- Do NOT touch `/api/issues`, `handleIssues`, or anything under `ui/`.

## Report

Write your full report to `briefs/task1-report.md` (status, files changed, commit sha,
the exact `bun test ./test` + `bun run lint` output, any concerns). Return only: status,
commit sha range, one-line test summary, concerns.
