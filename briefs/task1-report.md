# Task 1 Report — Server: surface native sub-issue numbers via `/api/epics`

## Status: DONE

## Commit

`215894c0` — `feat(epics): surface native sub-issue numbers in /api/epics`

## Files changed

- `src/forge/github.ts` — extended `collectSubIssueSummaryPage` with `intoSubIssues: Set<number>` param + `parent` field in GraphQL node type/query; broadened `listSubIssueSummaries` return to `{ summaries, subIssueNumbers }`
- `src/forge/types.ts` — updated `GitForge.listSubIssueSummaries?()` declaration + doc comment
- `src/server.ts` — broadened `fetchNativeSummaries` return; destructured in `handleEpicsList`; all 4 non-error returns changed to `{ epics, subIssues }`
- `test/forge/github-epic.test.ts` — updated existing assertions to `.summaries`/`.subIssueNumbers`; added 2 new `collectSubIssueSummaryPage` unit tests
- `test/epic-server.test.ts` — updated all `body.length`/`body[n]`/`body.find`/`body.toEqual([])` to `body.epics.*`; updated 5 mock returns to `{ summaries, subIssueNumbers }`; added 4 new shape tests

## Test output

```
 4113 pass
 8 skip
 0 fail
 10589 expect() calls
Ran 4121 tests across 210 files. [24.82s]
```

## Lint output

```
$ eslint --no-error-on-unmatched-pattern src test ui/src ci/onboarding-harness deploy
(no output — clean)
```

## Concerns

None. All changes are server/test only; no UI files touched.
